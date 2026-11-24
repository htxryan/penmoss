import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageChannel } from 'node:worker_threads';
import { dot, fakeEmbedder, type Embedder } from '@penmoss/core/search';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { leaseHolder } from '../src/lease';
import { NodeMeaning, meaningEnabled, setMeaningEnabled } from '../src/node-meaning';
import { remoteEmbedder, serveEmbedder } from '../src/remote-embedder';
import { TINY, fixtureServer, type FixtureServer } from './support';

let home: string;
let server: FixtureServer;
beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'penmoss-meaning-'));
  server = await fixtureServer();
});
afterEach(async () => {
  await server.close();
  await rm(home, { recursive: true, force: true });
});

const meaning = () => new NodeMeaning({ home, manifest: TINY, baseUrl: server.url, threads: 1 });

describe('NodeMeaning (T75)', () => {
  it('reports, fetches, opens and removes the model', async () => {
    const node = meaning();
    expect(await node.status()).toMatchObject({
      enabled: true,
      state: 'absent',
      model: 'tiny@01234567/4/p1',
    });
    expect(await node.open('cli')).toBeNull();
    const progress: number[] = [];
    expect((await node.fetch((received) => progress.push(received))).state).toBe('ready');
    expect(progress.length).toBeGreaterThan(0);
    const opened = await node.open('cli');
    expect(opened).not.toBeNull();
    const [vector] = await opened!.embedder.embedDocuments(['sourdough']);
    expect(dot(vector!, vector!)).toBeCloseTo(1, 5);
    expect(await node.indexBytes()).toBe(0);
    await opened!.cache.put(new Map([['a'.repeat(64), vector!]]));
    // The index (A1595): its bytes on disk, and Delete Index removes them and keeps the model.
    const bytes = await node.indexBytes();
    expect(bytes).toBeGreaterThan(64);
    await node.removeIndex();
    expect(await node.indexBytes()).toBe(0);
    expect((await node.status()).state).toBe('ready');
    opened!.cache.forget();
    expect(await opened!.cache.get(['a'.repeat(64)])).toEqual(new Map());
    await opened!.cache.put(new Map([['a'.repeat(64), vector!]]));
    expect(await node.indexBytes()).toBe(bytes);
    const lease = await opened!.lease();
    expect((await leaseHolder(home))?.writer).toBe('cli');
    await opened!.close();
    expect(lease && (await leaseHolder(home))).toBeUndefined();
    await node.remove();
    expect((await node.status()).state).toBe('absent');
  });

  it('fails to open, rather than waiting forever, when its worker exits first', async () => {
    const workerPath = join(home, 'exits.cjs');
    writeFileSync(workerPath, 'process.exit(3);\n');
    const node = new NodeMeaning({
      home,
      manifest: TINY,
      baseUrl: server.url,
      threads: 1,
      workerPath,
    });
    await node.fetch();
    await expect(node.open('mcp', { thread: true })).rejects.toThrow(/exit code 3/);
  });

  it('opens nothing while Search by Meaning is off (A1158)', async () => {
    const node = meaning();
    await node.fetch();
    expect(await meaningEnabled(home)).toBe(true);
    await setMeaningEnabled(home, false);
    expect(await node.status()).toMatchObject({ enabled: false, state: 'ready' });
    expect(await node.open('mcp')).toBeNull();
    await setMeaningEnabled(home, true);
    const opened = await node.open('mcp');
    expect(opened).not.toBeNull();
    await opened!.close();
  });

  it('frees an older model and its vectors once the new model opens', async () => {
    const node = meaning();
    // What the model before an update left: its folder, a partial download and its vectors.
    const oldModel = join(home, 'models', 'tiny@fedcba9876543210');
    const oldPartial = join(home, 'models', '.tiny@fedcba9876543210.partial');
    const oldVectors = join(home, 'vectors', 'tiny_fedcba98_4_p1');
    for (const dir of [oldModel, oldPartial, oldVectors]) mkdirSync(dir, { recursive: true });
    writeFileSync(join(oldModel, 'model.onnx'), 'old');
    writeFileSync(join(oldVectors, 'app.seg'), 'old');
    await node.fetch();
    // Fetched but not opened yet: nothing is removed.
    expect(existsSync(oldModel)).toBe(true);
    const opened = await node.open('app');
    await opened!.cache.put(new Map([['a'.repeat(64), new Float32Array(4).fill(0.5)]]));
    const lease = await opened!.lease();
    expect(lease).toBeDefined();
    for (const dir of [oldModel, oldPartial, oldVectors]) expect(existsSync(dir)).toBe(false);
    // This model, its vectors and the lease stay.
    expect((await node.status()).state).toBe('ready');
    expect(await node.indexBytes()).toBeGreaterThan(0);
    expect(existsSync(join(home, 'vectors', 'indexer.lease'))).toBe(true);
    expect(await node.removeOthers()).toEqual([]);
    await opened!.close();
  });
});

describe('the remote embedder (A1152)', () => {
  /** An embedder whose documents take a while, recording the order texts are embedded in. */
  function slow(): { embedder: Embedder; order: string[] } {
    const inner = fakeEmbedder();
    const order: string[] = [];
    const wait = () => new Promise((resolve) => setTimeout(resolve, 15));
    return {
      order,
      embedder: {
        ...inner,
        embedQuery: async (text) => {
          order.push(`q:${text}`);
          return inner.embedQuery(text);
        },
        embedDocuments: async (texts) => {
          await wait();
          order.push(...texts.map((text) => `d:${text}`));
          return inner.embedDocuments(texts);
        },
      },
    };
  }

  it('answers as the embedder would, a query ahead of the documents still waiting', async () => {
    const { port1, port2 } = new MessageChannel();
    const { embedder, order } = slow();
    serveEmbedder(port2, embedder, 1);
    const remote = remoteEmbedder(port1, embedder);
    const documents = remote.embedDocuments(['one', 'two', 'three', 'four']);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const query = await remote.embedQuery('now');
    const vectors = await documents;
    expect(vectors).toHaveLength(4);
    expect(vectors[2]).toEqual((await fakeEmbedder().embedDocuments(['three']))[0]);
    expect(query).toEqual(await fakeEmbedder().embedQuery('now'));
    // The query went in between two document batches, not after all four.
    expect(order.indexOf('q:now')).toBeLessThan(order.indexOf('d:four'));
    expect(await remote.embedDocuments([])).toEqual([]);
    port1.close();
  });

  it('passes an error back, and fails what is waiting when the far end goes', async () => {
    const { port1, port2 } = new MessageChannel();
    const broken: Embedder = {
      ...fakeEmbedder(),
      embedDocuments: () => Promise.reject(new Error('no model')),
    };
    serveEmbedder(port2, broken);
    const remote = remoteEmbedder(port1, broken);
    await expect(remote.embedDocuments(['x'])).rejects.toThrow('no model');
    const silent = new MessageChannel();
    const lost = remoteEmbedder(silent.port1, broken);
    const waiting = lost.embedQuery('x');
    lost.failAll('The embedding worker stopped.');
    await expect(waiting).rejects.toThrow('The embedding worker stopped.');
    port1.close();
    silent.port1.close();
  });
});
