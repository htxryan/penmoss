import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { readdir, rm, stat, truncate, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MeaningIndex, chunkKey, fakeEmbedder, type MeaningNote } from '@penmoss/core/search';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileVectorCache, removeOtherVectors, vectorsDir } from '../src/file-cache';
import { Lease, leaseHolder, leasePath } from '../src/lease';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'penmoss-vectors-'));
});
afterEach(() => rm(home, { recursive: true, force: true }));

const MODEL = 'tiny@01234567/4/p1';
const cache = (writer: string, model = MODEL, dimensions = 4) =>
  new FileVectorCache({ home, model, dimensions, writer });
const key = (n: number) => chunkKey(MODEL, `chunk ${n}`);
const vec = (...values: number[]) => Float32Array.from(values);
const entries = async (...ns: number[]) =>
  new Map(
    await Promise.all(ns.map(async (n) => [await key(n), vec(n, n + 1, n + 2, n + 3)] as const)),
  );

describe('the file vector cache (A1153)', () => {
  it('keeps vectors across processes, by writer segment', async () => {
    const app = cache('app');
    await app.put(await entries(1, 2));
    const cli = cache('cli');
    const found = await cli.get([await key(1), await key(2), await key(3)]);
    expect([...found.values()]).toEqual([vec(1, 2, 3, 4), vec(2, 3, 4, 5)]);
    await cli.put(await entries(3));
    expect((await readdir(app.dir)).sort()).toEqual(['seg-app.bin', 'seg-cli.bin']);
    // The app reads the CLI's appends without reopening.
    expect((await app.get([await key(3)])).get(await key(3))).toEqual(vec(3, 4, 5, 6));
  });

  it('writes one header when two processes share a writer id', async () => {
    const [a, b] = [cache('mcp'), cache('mcp')];
    await Promise.all([a.put(await entries(1, 2)), b.put(await entries(3, 4))]);
    const all = await cache('cli').get(await Promise.all([1, 2, 3, 4].map(key)));
    expect(all.size).toBe(4);
  });

  it('lets two writers append at once', async () => {
    const [a, b] = [cache('app'), cache('mcp')];
    await Promise.all([a.put(await entries(1, 2, 3)), b.put(await entries(4, 5, 6))]);
    const all = await cache('cli').get(await Promise.all([1, 2, 3, 4, 5, 6].map(key)));
    expect(all.size).toBe(6);
  });

  it('ignores a record torn by a crash, and a corrupt one', async () => {
    const app = cache('app');
    await app.put(await entries(1, 2));
    const path = join(app.dir, 'seg-app.bin');
    const { size } = await stat(path);
    await truncate(path, size - 7);
    const reader = cache('cli');
    expect((await reader.get([await key(1), await key(2)])).size).toBe(1);
    // The next writer (a restarted app) fills the torn record out, so the records after it read.
    await cache('app').put(await entries(3));
    const again = await cache('mcp').get([await key(1), await key(2), await key(3)]);
    expect([...again.keys()]).toEqual([await key(1), await key(3)]);
  });

  it('compacts into a base, collecting keys no longer used, while another reads', async () => {
    const holder = cache('app');
    await holder.put(await entries(1, 2));
    const reader = cache('cli');
    await reader.put(await entries(3));
    expect((await reader.get([await key(1)])).size).toBe(1);
    const dropped = await holder.compact(new Set([await key(1), await key(3)]));
    expect(dropped).toBe(1);
    expect(await readdir(holder.dir)).toEqual(['base.bin']);
    // The reader notices the new base and drops the collected key.
    const seen = await reader.get([await key(1), await key(2), await key(3)]);
    expect([...seen.keys()].sort()).toEqual([await key(1), await key(3)].sort());
    await reader.put(await entries(4));
    expect((await cache('mcp').get([await key(4), await key(1)])).size).toBe(2);
  });

  it('starts empty for another model, and removes other models’ vectors', async () => {
    await cache('app').put(await entries(1));
    const other = cache('app', 'other@abcdef01/8/p1', 8);
    expect((await other.get([await key(1)])).size).toBe(0);
    await other.put(new Map([[await key(9), new Float32Array(8).fill(1)]]));
    expect(await removeOtherVectors(home, MODEL)).toEqual([
      vectorsDir(home, 'other@abcdef01/8/p1'),
    ]);
    expect((await cache('cli').get([await key(1)])).size).toBe(1);
  });

  it('ignores a segment of another dimension', async () => {
    await cache('app', MODEL, 4).put(await entries(1));
    expect((await cache('cli', MODEL, 8).get([await key(1)])).size).toBe(0);
  });

  it('serves MeaningIndex: a second process embeds nothing, and a deleted note’s vectors go', async () => {
    const notes: MeaningNote[] = [
      {
        id: 'a',
        version: 1,
        title: 'Sourdough',
        sections: [{ heading: null, path: [], text: 'Feed the starter.' }],
      },
      {
        id: 'b',
        version: 1,
        title: 'VLANs',
        sections: [{ heading: null, path: [], text: 'IoT devices apart.' }],
      },
    ];
    const embedder = fakeEmbedder();
    const first = new MeaningIndex(
      embedder,
      new FileVectorCache({ home, model: embedder.model, dimensions: 1024, writer: 'app' }),
    );
    await first.update(notes);
    const second = new MeaningIndex(
      { ...embedder, embedDocuments: () => Promise.reject(new Error('should not embed')) },
      new FileVectorCache({ home, model: embedder.model, dimensions: 1024, writer: 'cli' }),
    );
    expect(await second.update(notes)).toEqual({ indexed: 2, total: 2 });
    // "Delete for good": the holder's index forgets b, and compaction collects its vectors.
    await first.update([notes[0]!]);
    const holderCache = new FileVectorCache({
      home,
      model: embedder.model,
      dimensions: 1024,
      writer: 'app',
    });
    expect(await holderCache.compact(first.index.keys())).toBe(1);
  });
});

describe('the indexer lease (A1157)', () => {
  it('has one holder; a second process waits', async () => {
    const app = await Lease.acquire(home, 'app');
    expect(app).toBeDefined();
    expect(await Lease.acquire(home, 'mcp')).toBeUndefined();
    expect((await leaseHolder(home))?.writer).toBe('app');
    await app!.release();
    expect(await leaseHolder(home)).toBeUndefined();
    const mcp = await Lease.acquire(home, 'mcp');
    expect(mcp?.holder.writer).toBe('mcp');
    await mcp!.release();
  });

  it('is taken over once its heartbeat stops, and the old holder learns it lost it', async () => {
    let lost = false;
    const app = await Lease.acquire(home, 'app', {
      heartbeatMs: 60_000,
      onLost: () => (lost = true),
    });
    const old = new Date(Date.now() - 120_000);
    await utimes(leasePath(home), old, old);
    const cli = await Lease.acquire(home, 'cli', { staleMs: 30_000 });
    expect(cli?.holder.writer).toBe('cli');
    expect(await app!.held()).toBe(false);
    expect(lost).toBe(true);
    // The old holder's release leaves the new holder's lease alone.
    await app!.release();
    expect((await leaseHolder(home))?.writer).toBe('cli');
    await cli!.release();
  });

  it('keeps itself fresh with a heartbeat', async () => {
    const app = await Lease.acquire(home, 'app', { heartbeatMs: 20 });
    const old = new Date(Date.now() - 120_000);
    await utimes(leasePath(home), old, old);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(await Lease.acquire(home, 'cli', { staleMs: 30_000 })).toBeUndefined();
    await app!.release();
  });

  it('takes over at once from a holder whose process died (a crashed service)', async () => {
    const dead = spawnSync(process.execPath, ['-e', '']).pid;
    await Lease.acquire(home, 'app').then((lease) => lease?.release());
    await writeFile(leasePath(home), JSON.stringify({ writer: 'app', pid: dead, token: 'old' }));
    const lease = await Lease.acquire(home, 'app');
    expect(lease).toBeDefined();
    await lease!.release();
    // A live holder keeps it, however new the taker.
    await writeFile(
      leasePath(home),
      JSON.stringify({ writer: 'mcp', pid: process.pid, token: 'live' }),
    );
    expect(await Lease.acquire(home, 'app')).toBeUndefined();
  });

  it('treats a half-written lease file as stale once old', async () => {
    await Lease.acquire(home, 'app').then((lease) => lease?.release());
    await writeFile(leasePath(home), '{"writer":');
    const old = new Date(Date.now() - 120_000);
    await utimes(leasePath(home), old, old);
    const lease = await Lease.acquire(home, 'cli');
    expect(lease).toBeDefined();
    await lease!.release();
  });
});
