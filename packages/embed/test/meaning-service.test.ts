import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageChannel } from 'node:worker_threads';
import { MemoryVectorCache, fakeEmbedder, type Embedder } from '@penmoss/core/search';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Lease, leasePath } from '../src/lease';
import {
  MeaningService,
  type MeaningSource,
  type ServiceNote,
  type ServiceStatus,
} from '../src/meaning-service';
import { NodeMeaning, meaningEnabled } from '../src/node-meaning';
import type { MeaningStatus, OpenedMeaning } from '../src/node-meaning';
import { serveService, serviceCalls, serviceClient } from '../src/service-rpc';
import { TINY, fixtureServer, type FixtureServer } from './support';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'penmoss-service-'));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const note = (
  id: string,
  title: string,
  text: string,
  version: number | string = 1,
): ServiceNote => ({
  id,
  version,
  title,
  sections: [{ heading: null, path: [], text }],
});

const NOTES = [
  note('ups', 'Server room', 'The UPS battery keeps the rack running through a power cut.'),
  note('bread', 'Sourdough', 'Feed the starter, then knead the dough and bake the loaf.'),
  note('trip', 'Lisbon', 'Flights, the hotel near the river, and trams up the hill.'),
];

/** A `NodeMeaning` stand-in: the fake embedder, a memory cache and the real lease. */
function fakeSource(options: { embedder?: Embedder; ready?: boolean } = {}) {
  let enabled = true;
  let ready = options.ready ?? true;
  const cache = Object.assign(new MemoryVectorCache(), {
    compacted: [] as Set<string>[],
    compact(keep: ReadonlySet<string>) {
      this.compacted.push(new Set(keep));
      return Promise.resolve(0);
    },
    claim: () => Promise.resolve(),
  });
  const embedder = options.embedder ?? fakeEmbedder();
  const opens: string[] = [];
  const status = (): MeaningStatus => ({
    enabled,
    state: ready ? 'ready' : 'absent',
    bytes: ready ? 10 : 0,
    totalBytes: 10,
    model: embedder.model,
    repository: 'fake',
    revision: 'fake',
    dir: home,
    license: { name: 'none', url: '' },
  });
  const leases: Lease[] = [];
  const source: MeaningSource = {
    status: () => Promise.resolve(status()),
    fetch: (onProgress) => {
      onProgress?.(5, 10);
      onProgress?.(10, 10);
      ready = true;
      return Promise.resolve(status());
    },
    remove: () => {
      ready = false;
      return Promise.resolve();
    },
    setEnabled: (value) => {
      enabled = value;
      return Promise.resolve();
    },
    open: (writer) => {
      if (!enabled || !ready) return Promise.resolve(null);
      opens.push(writer);
      const opened: OpenedMeaning = {
        embedder,
        cache,
        lease: async () => {
          const lease = await Lease.acquire(home, writer);
          if (lease) leases.push(lease);
          return lease;
        },
        close: async () => {
          for (const lease of leases.splice(0)) await lease.release();
        },
      };
      return Promise.resolve(opened);
    },
  };
  return { source, cache, opens };
}

/** Waits until the service reports `state`. */
function until(statuses: ServiceStatus[], test: (status: ServiceStatus) => boolean) {
  return vi.waitFor(
    () => {
      if (!statuses.some(test)) throw new Error(`not yet: ${JSON.stringify(statuses.at(-1))}`);
    },
    { timeout: 5_000, interval: 10 },
  );
}

describe('the embedding service (T76)', () => {
  it('indexes what the page sends and answers by meaning over a message port', async () => {
    const { source } = fakeSource();
    const statuses: ServiceStatus[] = [];
    const service = new MeaningService(source, (status) => statuses.push(status), { sliceMs: 50 });
    const { port1, port2 } = new MessageChannel();
    serveService(port2, serviceCalls(service));
    const seen: ServiceStatus[] = [];
    const client = serviceClient(port1, (status) => seen.push(status));
    await service.start();
    // Versions first: the service asks for the sections of what it does not have.
    const versions = NOTES.map(({ id, version }) => ({ id, version }));
    expect((await client.update('nb', versions)).sort()).toEqual(['bread', 'trip', 'ups']);
    expect(await client.update('nb', NOTES)).toEqual([]);
    await until(statuses, (status) => status.state === 'ready' && status.indexed === 3);
    const answer = await client.search('nb', 'power cut battery');
    expect(answer?.floor).toBe(fakeEmbedder().floor);
    expect(answer?.hits[0]).toMatchObject({ id: 'ups', heading: null });
    // Only the ids the page's filters allow.
    const filtered = await client.search('nb', 'power cut battery', { ids: ['bread', 'trip'] });
    expect(filtered?.hits.map((hit) => hit.id)).not.toContain('ups');
    // Unchanged notes need nothing again; a changed one is asked for.
    const next = NOTES.map(({ id, version }) => ({ id, version: id === 'bread' ? 2 : version }));
    expect(await client.update('nb', next)).toEqual(['bread']);
    expect((await client.status()).total).toBe(3);
    // A notebook the page closed is forgotten.
    await client.close('nb');
    expect(await client.search('nb', 'bread')).toBeNull();
    await service.stop();
    port1.close();
  });

  it('answers null until the model opens, keeping the notes sent before', async () => {
    const { source } = fakeSource({ ready: false });
    const statuses: ServiceStatus[] = [];
    const service = new MeaningService(source, (status) => statuses.push(status), {
      download: false,
    });
    await service.start();
    expect((await service.status()).state).toBe('absent');
    expect(await service.update('nb', NOTES)).toEqual([]);
    expect(await service.search('nb', 'bread')).toBeNull();
    expect(service.floor()).toBeNull();
    await source.fetch();
    await service.start();
    await until(statuses, (status) => status.state === 'ready' && status.indexed === 3);
    expect((await service.search('nb', 'sourdough loaf'))?.[0]?.id).toBe('bread');
    await service.stop();
  });

  it('downloads the model in the background, reporting progress', async () => {
    const { source } = fakeSource({ ready: false });
    const statuses: ServiceStatus[] = [];
    const service = new MeaningService(source, (status) => statuses.push(status));
    await service.start();
    expect(statuses.map((status) => status.state)).toContain('downloading');
    expect(statuses.some((status) => status.received === 5)).toBe(true);
    expect(statuses.at(-1)?.state).toMatch(/indexing|ready/);
    await service.stop();
  });

  it('only searches while another app holds the lease, and indexes once it is free', async () => {
    const { source } = fakeSource();
    const other = await Lease.acquire(home, 'app');
    const statuses: ServiceStatus[] = [];
    const service = new MeaningService(source, (status) => statuses.push(status), {
      leaseRetryMs: 20,
    });
    await service.start();
    await service.update('nb', NOTES);
    expect((await service.status()).leaseElsewhere).toBe(true);
    expect((await service.status()).indexed).toBe(0);
    await other!.release();
    await until(statuses, (status) => status.indexed === 3 && !status.leaseElsewhere);
    await service.stop();
  });

  it('takes the lease from an agent’s penmoss mcp as it starts (A1350)', async () => {
    const { source } = fakeSource();
    let lost = false;
    const mcp = await Lease.acquire(home, 'mcp', { onLost: () => (lost = true) });
    const statuses: ServiceStatus[] = [];
    const service = new MeaningService(source, (status) => statuses.push(status));
    await service.start();
    await service.update('nb', NOTES);
    await until(statuses, (status) => status.indexed === 3 && !status.leaseElsewhere);
    expect(statuses.some((status) => status.leaseElsewhere)).toBe(false);
    expect(await mcp!.held()).toBe(false);
    expect(lost).toBe(true);
    await service.stop();
  });

  it('keeps trying for the lease after the holder dies, and tries at once on a search (A1350)', async () => {
    const { source } = fakeSource();
    const other = await Lease.acquire(home, 'app');
    const statuses: ServiceStatus[] = [];
    // A retry an hour away: only the search can bring the lease in time.
    const service = new MeaningService(source, (status) => statuses.push(status), {
      leaseRetryMs: 60 * 60_000,
    });
    await service.start();
    await service.update('nb', NOTES);
    expect((await service.status()).leaseElsewhere).toBe(true);
    // The other app died without letting go: its file stays, naming a pid that is gone.
    await other!.release();
    const dead = spawnSync(process.execPath, ['-e', '']).pid;
    await writeFile(leasePath(home), JSON.stringify({ writer: 'app', pid: dead, token: 'dead' }));
    expect(await service.search('nb', 'bread')).toEqual([]);
    await until(statuses, (status) => status.indexed === 3 && !status.leaseElsewhere);
    expect((await service.search('nb', 'bread'))?.length).toBe(3);
    await service.stop();
  });

  it('indexes a change that arrives while it is indexing', async () => {
    const { source } = fakeSource({ embedder: fakeEmbedder({ delayMs: 30 }) });
    const statuses: ServiceStatus[] = [];
    const service = new MeaningService(source, (status) => statuses.push(status), { batch: 1 });
    await service.start();
    await service.update('nb', NOTES);
    await until(statuses, (status) => status.state === 'ready' && status.indexed === 3);
    // The page's two calls for an edit: versions (the service asks for the note), then sections,
    // the second while the first's indexing run is still going.
    const edited = note('bread', 'Sourdough', 'A diesel generator stands behind the shed.', 2);
    const versions = NOTES.map(({ id, version }) => ({
      id,
      version: id === 'bread' ? 2 : version,
    }));
    expect(await service.update('nb', versions)).toEqual(['bread']);
    await service.update('nb', [...NOTES.filter((each) => each.id !== 'bread'), edited]);
    await vi.waitFor(async () => {
      const hits = await service.search('nb', 'diesel generator shed');
      expect(hits?.[0]?.id).toBe('bread');
      expect(hits?.[0]?.preview).toContain('diesel');
    });
    await service.stop();
  });

  it('compacts the cache to the keys every open notebook uses', async () => {
    const { source, cache } = fakeSource();
    const statuses: ServiceStatus[] = [];
    const service = new MeaningService(source, (status) => statuses.push(status), {
      compactEveryMs: 0,
    });
    await service.start();
    await service.update('a', NOTES.slice(0, 2));
    await service.update('b', NOTES.slice(2));
    await until(statuses, (status) => status.state === 'ready' && status.indexed === 3);
    await vi.waitFor(() => expect(cache.compacted.at(-1)?.size).toBe(3));
    await service.stop();
  });

  it('waits to compact until every notebook has sent the text of its notes (A-NEW-1)', async () => {
    const { source, cache } = fakeSource();
    const statuses: ServiceStatus[] = [];
    const service = new MeaningService(source, (status) => statuses.push(status), {
      compactEveryMs: 0,
    });
    await service.start();
    await service.update('a', NOTES.slice(0, 2));
    // Notebook b's versions are here, its sections not yet: its keys are still unknown.
    const versions = NOTES.slice(2).map(({ id, version }) => ({ id, version }));
    expect(await service.update('b', versions)).toEqual(['trip']);
    await until(statuses, (status) => status.state === 'ready' && status.indexed === 2);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(cache.compacted).toEqual([]);
    await service.update('b', NOTES.slice(2));
    await vi.waitFor(() => expect(cache.compacted.at(-1)?.size).toBe(3));
    await service.stop();
  });

  it('forgets a removed notebook: its count, its search and its keys (A-NEW-1)', async () => {
    const { source, cache } = fakeSource();
    const statuses: ServiceStatus[] = [];
    const service = new MeaningService(source, (status) => statuses.push(status), {
      compactEveryMs: 0,
    });
    await service.start();
    await service.update('a', NOTES.slice(0, 2));
    await service.update('b', NOTES.slice(2));
    await until(statuses, (status) => status.state === 'ready' && status.indexed === 3);
    await vi.waitFor(() => expect(cache.compacted.at(-1)?.size).toBe(3));
    await service.close('b');
    // The page hears the new count at once.
    expect(statuses.at(-1)).toMatchObject({ indexed: 2, total: 2 });
    expect(await service.search('b', 'Lisbon trams')).toBeNull();
    // The next compaction keeps a's keys alone.
    const before = cache.compacted.length;
    await service.update('a', NOTES.slice(0, 2));
    await vi.waitFor(() => expect(cache.compacted.length).toBeGreaterThan(before));
    expect(cache.compacted.at(-1)?.size).toBe(2);
    await service.stop();
  });

  it('stops everything when switched off, and starts again when switched on (A1158)', async () => {
    const { source, opens } = fakeSource();
    const statuses: ServiceStatus[] = [];
    const service = new MeaningService(source, (status) => statuses.push(status));
    await service.start();
    await service.update('nb', NOTES);
    await until(statuses, (status) => status.indexed === 3);
    const off = await service.setEnabled(false);
    expect(off).toMatchObject({ state: 'off', enabled: false, indexed: 0, total: 0 });
    expect(await service.search('nb', 'bread')).toBeNull();
    expect((await source.status()).state).toBe('absent');
    await service.setEnabled(true);
    await until(statuses, (status) => status.enabled && status.state !== 'off' && status !== off);
    await vi.waitFor(() => expect(opens).toHaveLength(2));
    await service.stop();
  });

  it('lets an indexing run finish before Off removes the vectors', async () => {
    const inner = fakeEmbedder();
    let release = () => undefined as void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let embedding = false;
    const embedder: Embedder = {
      ...inner,
      embedDocuments: async (texts) => {
        embedding = true;
        await gate;
        return inner.embedDocuments(texts);
      },
    };
    const { source, cache } = fakeSource({ embedder });
    const order: string[] = [];
    const put = cache.put.bind(cache);
    cache.put = (entries) => {
      order.push('put');
      return put(entries);
    };
    const remove = source.remove;
    source.remove = () => {
      order.push('remove');
      return remove();
    };
    const service = new MeaningService(source, () => undefined, { sliceMs: 50 });
    await service.start();
    await service.update('nb', NOTES);
    await vi.waitFor(() => expect(embedding).toBe(true), { timeout: 5_000 });
    const off = service.setEnabled(false);
    await new Promise((resolve) => setTimeout(resolve, 50));
    release();
    await off;
    await new Promise((resolve) => setTimeout(resolve, 100));
    // Nothing is written after the vectors are removed.
    expect(order.at(-1)).toBe('remove');
    await service.stop();
  });

  it('reports a failure to open, with its reason', async () => {
    const { source } = fakeSource();
    const statuses: ServiceStatus[] = [];
    const failing: MeaningSource = { ...source, open: () => Promise.reject(new Error('corrupt')) };
    const service = new MeaningService(failing, (status) => statuses.push(status));
    await service.start();
    expect(statuses.at(-1)).toMatchObject({ state: 'failed', error: 'corrupt' });
  });
});

describe('the embedding service with the real model store (T76)', () => {
  let server: FixtureServer;
  beforeEach(async () => {
    server = await fixtureServer();
  });
  afterEach(async () => {
    await server.close();
  });

  it('downloads under a temporary home, indexes, and removes it all when switched off', async () => {
    const node = new NodeMeaning({ home, manifest: TINY, baseUrl: server.url, threads: 1 });
    const statuses: ServiceStatus[] = [];
    const service = new MeaningService(node, (status) => statuses.push(status), { sliceMs: 50 });
    await service.start();
    await service.update('nb', NOTES);
    await until(statuses, (status) => status.state === 'ready' && status.indexed === 3);
    expect(await service.search('nb', 'bread')).toHaveLength(3);
    expect(await readdir(join(home, 'vectors'))).not.toHaveLength(0);
    await service.setEnabled(false);
    expect(await meaningEnabled(home)).toBe(false);
    expect((await node.status()).state).toBe('absent');
    expect(await readdir(join(home, 'vectors'))).toHaveLength(0);
    await service.stop();
  });
});
