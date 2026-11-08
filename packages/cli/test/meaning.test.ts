/**
 * Search by meaning from the CLI (T75): `penmoss models`, `search` with and without the model,
 * and `penmoss mcp` indexing in the background while it holds the lease. The model is a fake
 * `MeaningIo` over core's fake embedder; the notebook is real git, as in notebook.test.ts.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryVectorCache, fakeEmbedder } from '@penmoss/core/search';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Io, MeaningIo, MeaningStatus } from '../src/io';
import { run } from '../src/main';
import { memoryTokenStore } from '../src/memory-store';
import { nodeNotebooks } from '../src/node-notebooks';

vi.setConfig({ testTimeout: 60_000 });

const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'penmoss-meaning-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function bare(name: string): string {
  const path = join(root, `${name}.git`);
  mkdirSync(path, { recursive: true });
  execFileSync('git', ['init', '--bare', '--quiet', '--initial-branch=main'], {
    cwd: path,
    env: { ...process.env, ...GIT_ENV },
  });
  return path;
}

/** The model as a test controls it: here or not, on or off, the lease free or taken. */
function fakeMeaning(initial: { state?: MeaningStatus['state']; leaseFree?: boolean } = {}) {
  const embedder = fakeEmbedder();
  const cache = Object.assign(new MemoryVectorCache(), { compact: () => Promise.resolve(0) });
  const control = {
    state: initial.state ?? 'ready',
    enabled: true,
    leaseFree: initial.leaseFree ?? true,
    opened: 0,
    closed: 0,
    embedded: 0,
  };
  const status = (): Promise<MeaningStatus> =>
    Promise.resolve({
      enabled: control.enabled,
      state: control.state,
      bytes: control.state === 'ready' ? 1_000_000 : 0,
      totalBytes: 1_000_000,
      model: embedder.model,
      repository: 'onnx-community/test',
      revision: '0123456789abcdef',
      dir: join(root, 'models', 'test'),
      license: { name: 'Test terms', url: 'https://example.invalid/terms' },
    });
  const meaning: MeaningIo = {
    status,
    fetch: async (onProgress) => {
      onProgress?.(500_000, 1_000_000);
      onProgress?.(1_000_000, 1_000_000);
      control.state = 'ready';
      return status();
    },
    remove: () => {
      control.state = 'absent';
      return Promise.resolve();
    },
    open: () => {
      if (control.state !== 'ready' || !control.enabled) return Promise.resolve(null);
      control.opened++;
      return Promise.resolve({
        embedder: {
          ...embedder,
          embedQuery: (text: string) => embedder.embedQuery(text),
          embedDocuments: (texts: readonly string[]) => {
            control.embedded += texts.length;
            return embedder.embedDocuments(texts);
          },
        },
        cache,
        lease: () =>
          Promise.resolve(
            control.leaseFree
              ? { held: () => Promise.resolve(true), release: () => Promise.resolve() }
              : undefined,
          ),
        close: () => {
          control.closed++;
          return Promise.resolve();
        },
      });
    },
  };
  return { meaning, control };
}

function machine(meaning: MeaningIo | undefined, indexEveryMs = 20) {
  const notebooks = nodeNotebooks({
    home: join(root, 'home'),
    env: {},
    platform: process.platform,
    secrets: memoryTokenStore(),
    gitEnv: GIT_ENV,
    pushDelayMs: 50,
    pullEveryMs: 60_000,
    lockWaitMs: 300,
    indexEveryMs,
    ...(meaning ? { meaning } : {}),
  });
  /** stdin's lines; 'wait' pauses, and a function runs then (the test changes something). */
  return async (argv: string[], lines: Array<string | (() => void)> = []) => {
    let stdout = '';
    let stderr = '';
    const io: Io = {
      env: {},
      stdin: { isTTY: false, read: () => Promise.resolve('') },
      stdout: { isTTY: false, write: (text) => void (stdout += text) },
      stderr: { write: (text) => void (stderr += text) },
      openUrl: () => Promise.resolve(false),
      readFile: (path) => Promise.resolve(new Uint8Array(readFileSync(path))),
      fileSize: (path) => Promise.resolve(statSync(path).size),
      stdio: {
        lines: async function* () {
          for (const line of lines) {
            if (typeof line === 'function') line();
            else if (line === 'wait') await new Promise((resolve) => setTimeout(resolve, 300));
            else yield line;
          }
        },
      },
      notebooks,
      ...(meaning ? { meaning } : {}),
    };
    const code = await run(argv, io);
    return { code, stdout, stderr, json: () => JSON.parse(stdout) as Record<string, unknown> };
  };
}

async function withNotes(cli: ReturnType<typeof machine>) {
  expect((await cli(['notebook', 'add', `file://${bare('nb')}`, '--name', 'nb'])).code).toBe(0);
  for (const [title, text] of [
    [
      'UPS shutdown',
      'When the power fails the battery keeps the rack up and the guests shut down in order.',
    ],
    ['Sourdough', 'Feed the starter flour and water every morning.'],
  ]) {
    expect((await cli(['new', title!, '--text', text!, '--no-sync'])).code).toBe(0);
  }
}

describe('penmoss models (T75)', () => {
  it('says this penmoss has none without the app', async () => {
    const cli = machine(undefined);
    const status = await cli(['models', 'status', '--json']);
    expect(status.code).toBe(1);
    expect(status.stderr).toContain('"code":"unsupported"');
    expect((await cli(['models'])).code).toBe(2);
  });

  it('reports, fetches and removes the model', async () => {
    const { meaning, control } = fakeMeaning({ state: 'absent' });
    const cli = machine(meaning);
    const before = await cli(['models', 'status']);
    expect(before.code).toBe(0);
    expect(before.stdout).toContain('Search by meaning: on');
    expect(before.stdout).toContain('not downloaded (1 MB): run penmoss models fetch');
    const fetched = await cli(['models', 'fetch']);
    expect(fetched.code).toBe(0);
    expect(fetched.stderr).toContain('Downloading the model: 50% of 1 MB');
    expect(fetched.stdout).toContain('Downloaded the model.');
    const json = await cli(['models', 'status', '--json']);
    expect(json.json()).toMatchObject({ state: 'ready', enabled: true, model: 'fake-hash-1024' });
    const removed = await cli(['models', 'remove', '--json']);
    expect(removed.json()).toMatchObject({ state: 'absent', removed: true });
    expect(control.state).toBe('absent');
    expect((await cli(['models', 'frobnicate'])).code).toBe(2);
  });
});

describe('penmoss search with meaning (T75, A1156)', () => {
  it('refuses semantic with exit 7 only without the model, and hybrid says words only', async () => {
    const { meaning, control } = fakeMeaning({ state: 'absent' });
    const cli = machine(meaning);
    await withNotes(cli);
    const semantic = await cli(['search', 'battery', '--mode', 'semantic', '--no-sync']);
    expect(semantic.code).toBe(7);
    expect(semantic.stderr).toContain('penmoss models fetch');
    const hybrid = await cli(['search', 'battery', '--no-sync', '--json']);
    expect(hybrid.json()).toMatchObject({
      mode: 'full-text',
      notice: expect.stringMatching(/words only/) as string,
    });

    control.state = 'ready';
    const found = await cli([
      'search',
      'battery rack',
      '--mode',
      'semantic',
      '--limit',
      '1',
      '--no-sync',
      '--json',
    ]);
    expect(found.code, found.stderr).toBe(0);
    expect(found.json()).toMatchObject({
      mode: 'semantic',
      results: [{ title: 'UPS shutdown', foundBy: ['semantic'] }],
    });
    const fused = await cli(['search', 'battery', '--no-sync', '--json']);
    expect(fused.json()).toMatchObject({
      mode: 'hybrid',
      results: [{ title: 'UPS shutdown', foundBy: ['full-text', 'semantic'] }],
    });
    expect(fused.json()['notice']).toBeUndefined();
    // Each one-shot search opens the model and lets it go.
    expect(control.closed).toBe(control.opened);
  });

  it('stays words only for full-text, without opening the model', async () => {
    const { meaning, control } = fakeMeaning();
    const cli = machine(meaning);
    await withNotes(cli);
    const words = await cli(['search', 'battery', '--mode', 'full-text', '--no-sync', '--json']);
    expect(words.json()).toMatchObject({ mode: 'full-text' });
    expect(control.opened).toBe(0);
  });
});

describe('penmoss mcp with meaning (T75, A1157)', () => {
  const rpc = (id: number, method: string, params?: unknown) =>
    JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
  const searchCall = (id: number, query: string) =>
    rpc(id, 'tools/call', {
      name: 'search_notes',
      arguments: { query, mode: 'semantic', limit: 1 },
    });

  it('describes meaning, indexes in the background as the holder, and answers by meaning', async () => {
    const { meaning, control } = fakeMeaning();
    const cli = machine(meaning);
    await withNotes(cli);
    const served = await cli(
      ['mcp', '--notebook', 'nb'],
      [
        rpc(1, 'initialize', { protocolVersion: '2025-06-18' }),
        rpc(2, 'tools/list'),
        'wait',
        searchCall(3, 'battery rack'),
      ],
    );
    const replies = served.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { id: number; result: Record<string, unknown> });
    expect(replies[0]!.result['instructions']).toMatch(/by their words and their meaning/);
    const tools = replies[1]!.result['tools'] as Array<{ name: string; description: string }>;
    expect(tools.find((tool) => tool.name === 'search_notes')!.description).toMatch(
      /by meaning alone/,
    );
    expect(replies[2]!.result['structuredContent']).toMatchObject({
      mode: 'semantic',
      results: [{ title: 'UPS shutdown', foundBy: ['semantic'] }],
      coverage: { indexed: 2, total: 2 },
    });
    expect(control.embedded).toBe(2);
    expect(control.closed).toBe(1);
  });

  it('indexes an agent’s edit a moment after it, as the holder', async () => {
    const { meaning } = fakeMeaning();
    // The background pass is an hour away: only the edit itself can bring the new note in.
    const cli = machine(meaning, 60 * 60_000);
    await withNotes(cli);
    const served = await cli(
      ['mcp', '--notebook', 'nb'],
      [
        'wait',
        rpc(1, 'tools/call', {
          name: 'create_note',
          arguments: { title: 'Generator', markdown: 'A diesel generator behind the shed.' },
        }),
        'wait',
        'wait',
        'wait',
        'wait',
        'wait',
        searchCall(2, 'battery rack'),
      ],
    );
    const replies = served.stdout
      .trim()
      .split('\n')
      .map(
        (line) => JSON.parse(line) as { result: { structuredContent: Record<string, unknown> } },
      );
    expect(replies[1]!.result.structuredContent).toMatchObject({
      coverage: { indexed: 3, total: 3 },
    });
  });

  it('without the lease, embeds only within its small budget', async () => {
    const { meaning } = fakeMeaning({ leaseFree: false });
    const cli = machine(meaning);
    await withNotes(cli);
    const served = await cli(['mcp', '--notebook', 'nb'], ['wait', searchCall(1, 'battery rack')]);
    const reply = JSON.parse(served.stdout.trim()) as {
      result: { structuredContent: Record<string, unknown> };
    };
    expect(reply.result.structuredContent).toMatchObject({
      mode: 'semantic',
      coverage: { total: 2 },
    });
  });

  it('falls back to words once Search by Meaning is switched off (A1158)', async () => {
    const { meaning, control } = fakeMeaning();
    const cli = machine(meaning);
    await withNotes(cli);
    const hybrid = (id: number) =>
      rpc(id, 'tools/call', { name: 'search_notes', arguments: { query: 'battery' } });
    const served = await cli(
      ['mcp', '--notebook', 'nb'],
      [
        'wait',
        searchCall(1, 'battery rack'),
        () => {
          control.enabled = false;
        },
        searchCall(2, 'battery rack'),
        hybrid(3),
      ],
    );
    const replies = served.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { result: Record<string, unknown> });
    expect(replies[0]!.result['structuredContent']).toMatchObject({ mode: 'semantic' });
    expect(replies[1]!.result['isError']).toBe(true);
    expect(JSON.stringify(replies[1]!.result['content'])).toMatch(/not set up here/);
    expect(replies[2]!.result['structuredContent']).toMatchObject({
      mode: 'full-text',
      results: [{ title: 'UPS shutdown' }],
    });
    expect(control.closed).toBe(1);
    expect(served.stderr).toMatch(/Search by Meaning is off/);
  });

  it('keeps the words-only tools without the model', async () => {
    const { meaning } = fakeMeaning({ state: 'absent' });
    const cli = machine(meaning);
    await withNotes(cli);
    const served = await cli(['mcp', '--notebook', 'nb'], [rpc(1, 'tools/list')]);
    const tools = (
      JSON.parse(served.stdout.trim()) as {
        result: { tools: Array<{ name: string; description: string }> };
      }
    ).result.tools;
    expect(tools.find((tool) => tool.name === 'search_notes')!.description).toMatch(
      /no meaning search/,
    );
  });
});
