import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, readdir, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EMBEDDING_GEMMA, manifestBytes, modelId } from '../src/manifest';
import {
  ModelError,
  fetchModel,
  modelPaths,
  modelStatus,
  openModel,
  otherModels,
  removeModel,
  type FetchProgress,
} from '../src/model-store';
import { TINY, TINY_DIR, fixtureServer, type FixtureServer } from './support';

let home: string;
let server: FixtureServer;
beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'penmoss-embed-'));
  server = await fixtureServer();
});
afterEach(async () => {
  await server.close();
  await rm(home, { recursive: true, force: true });
});

const fetchTiny = (options: Parameters<typeof fetchModel>[1] = {}) =>
  fetchModel(TINY, { home, baseUrl: server.url, ...options });

describe('the pinned manifest (A1151)', () => {
  it('pins EmbeddingGemma q4 at one commit with every file hashed', () => {
    expect(EMBEDDING_GEMMA.revision).toMatch(/^[0-9a-f]{40}$/);
    for (const file of EMBEDDING_GEMMA.files) expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(manifestBytes(EMBEDDING_GEMMA)).toBe(218_725_224);
    expect(modelId(EMBEDDING_GEMMA)).toBe('embeddinggemma-300m-q4@5090578d/768/p1');
  });
});

describe('the model store (A1151)', () => {
  it('downloads into a partial folder, renames it into place, and reports progress', async () => {
    const progress: FetchProgress[] = [];
    expect((await modelStatus(TINY, home)).state).toBe('absent');
    const dir = await fetchTiny({ onProgress: (p) => progress.push(p) });
    expect(dir).toBe(join(home, 'models', `tiny@${TINY.revision}`));
    for (const file of TINY.files) {
      expect(readFileSync(join(dir, file.path))).toEqual(readFileSync(join(TINY_DIR, file.path)));
    }
    expect(await modelStatus(TINY, home)).toMatchObject({
      state: 'ready',
      bytes: manifestBytes(TINY),
    });
    expect(progress.at(-1)).toMatchObject({
      received: manifestBytes(TINY),
      total: manifestBytes(TINY),
    });
    expect((await readdir(join(home, 'models'))).sort()).toEqual([`tiny@${TINY.revision}`]);
    expect(await openModel(TINY, home)).toBe(dir);
  });

  it('reuses a model in place without asking the server', async () => {
    await fetchTiny();
    const asked = server.requests.length;
    await fetchTiny();
    expect(server.requests).toHaveLength(asked);
  });

  it('resumes a dropped download with a range request', async () => {
    server.cutNext('tokenizer.json', 100);
    await expect(fetchTiny()).rejects.toMatchObject({ code: 'download_failed' });
    expect((await modelStatus(TINY, home)).state).toBe('partial');
    await fetchTiny();
    const tokenizer = server.requests.filter((r) => r.path === 'tokenizer.json');
    expect(tokenizer.map((r) => r.range)).toEqual([undefined, 'bytes=100-']);
    expect(await openModel(TINY, home)).toBeTruthy();
    // Files finished before the drop are not fetched again.
    expect(server.requests.filter((r) => r.path === 'onnx/model.onnx')).toHaveLength(1);
  });

  it('starts a file again when the server ignores the range', async () => {
    server.cutNext('tokenizer.json', 100);
    await expect(fetchTiny()).rejects.toBeInstanceOf(ModelError);
    server.ignoreRanges();
    await fetchTiny();
    expect(await openModel(TINY, home)).toBeTruthy();
  });

  it('refuses a file whose hash differs, deleting it', async () => {
    const good = readFileSync(join(TINY_DIR, 'tokenizer.json'));
    const bad = Buffer.from(good);
    bad[10] = bad[10]! ^ 1;
    server.replace('tokenizer.json', bad);
    await expect(fetchTiny()).rejects.toMatchObject({ code: 'hash_mismatch' });
    expect((await modelStatus(TINY, home)).state).not.toBe('ready');
    const { partial } = modelPaths(TINY, home);
    expect(await readdir(partial)).not.toContain('tokenizer.json.part');
  });

  it('lets one of two downloads at once do the work while the other waits', async () => {
    const [a, b] = await Promise.all([fetchTiny(), fetchTiny()]);
    expect(a).toBe(b);
    for (const file of TINY.files) {
      expect(server.requests.filter((r) => r.path === file.path)).toHaveLength(1);
    }
  });

  it('takes over a lock left by a process that died', async () => {
    const { lock } = modelPaths(TINY, home);
    await mkdir(join(home, 'models'), { recursive: true });
    writeFileSync(lock, '99999');
    const old = new Date(Date.now() - 60_000);
    await utimes(lock, old, old);
    expect(await fetchTiny({ staleLockMs: 1_000 })).toBeTruthy();
  });

  it('checks the hashes again on open, and removes the model', async () => {
    await expect(openModel(TINY, home)).rejects.toMatchObject({ code: 'absent' });
    const dir = await fetchTiny();
    const path = join(dir, 'tokenizer_config.json');
    const bytes = readFileSync(path);
    bytes[2] = bytes[2]! ^ 1;
    writeFileSync(path, bytes);
    await expect(openModel(TINY, home)).rejects.toMatchObject({ code: 'corrupt' });
    expect((await modelStatus(TINY, home)).state).toBe('partial');
    // Fetching again downloads only the file that was deleted.
    const asked = server.requests.length;
    await fetchTiny();
    expect(server.requests.slice(asked).map((r) => r.path)).toEqual(['tokenizer_config.json']);
    expect(await openModel(TINY, home)).toBe(dir);
    await removeModel(TINY, home);
    expect((await modelStatus(TINY, home)).state).toBe('absent');
  });

  it('lists other revisions on disk', async () => {
    await mkdir(join(home, 'models', 'tiny@old'), { recursive: true });
    await fetchTiny();
    expect(await otherModels(TINY, home)).toEqual([join(home, 'models', 'tiny@old')]);
  });
});
