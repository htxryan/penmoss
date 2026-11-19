/**
 * The usage record's worker protocol (PEN-137): `StoreHost` (the worker's side) and
 * `WorkerStore` (main's), run in-process over a MessageChannel with an in-memory store, as the
 * worker thread runs them over its port.
 */
import { MessageChannel } from 'node:worker_threads';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STATES, type AnalyticsEvent, type StateCode } from '@penmoss/core/analytics';
import { AnalyticsStore } from '@penmoss/core/analytics/node';
import { StoreHost, type HostMessage } from '../../src/analytics-host';
import { WorkerStore, type StorePort } from '../../src/analytics-store';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 19, 12);

function event(seq: number, at = NOW, session = 'a1b2c3d4e5f60718'): AnalyticsEvent {
  return {
    session,
    seq,
    at,
    client: 'mac',
    actor: 'person',
    version: '0.2.2',
    channel: 'stable',
    os: 'macos',
    osVersion: '15.1',
    kind: 'command',
    name: 'note.new',
    props: { source: 'key' },
  };
}

const inserted = (events: AnalyticsEvent[], state: StateCode = STATES.pending) =>
  events.map((item) => ({ event: item, state }));

let opened: Array<{ host: StoreHost; channel: MessageChannel }> = [];

/** A host and main's client, joined by a MessageChannel. */
function connect(options: ConstructorParameters<typeof StoreHost>[3] = {}) {
  const store = AnalyticsStore.open(':memory:');
  const channel = new MessageChannel();
  const host = new StoreHost(
    store,
    (reply) => channel.port2.postMessage(reply),
    { 'events.days': 7, 'events.max': 5000 },
    { firstPruneMs: 3_600_000, now: () => NOW, ...options },
  );
  channel.port2.on('message', (message: HostMessage) => host.handle(message));
  const client = new WorkerStore(channel.port1);
  opened.push({ host, channel });
  return { store, host, client, channel };
}

beforeEach(() => {
  opened = [];
});

afterEach(async () => {
  vi.useRealTimers();
  for (const { host, channel } of opened) {
    await host.close();
    channel.port1.close();
    channel.port2.close();
  }
});

describe('the record’s worker', () => {
  it('inserts every 100 events at once, and the rest after a second', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const { store, host } = connect();
    host.handle({
      op: 'insert',
      events: inserted(Array.from({ length: 99 }, (_, i) => event(i))),
    });
    expect(store.size()).toBe(0);
    host.handle({ op: 'insert', events: inserted([event(99)]) });
    expect(store.size()).toBe(100);
    host.handle({ op: 'insert', events: inserted([event(100)]) });
    expect(host.buffered).toBe(1);
    vi.advanceTimersByTime(999);
    expect(store.size()).toBe(100);
    vi.advanceTimersByTime(1);
    expect(store.size()).toBe(101);
  });

  it('answers a call only after what was posted before it is in the store', async () => {
    const { client } = connect();
    client.insert(inserted([event(0), event(1)]));
    expect(await client.counts()).toMatchObject({ pending: 2 });
    // The answer moves the events posted just before it too.
    client.insert(inserted([event(2)]));
    expect(await client.applyAnswer('yes')).toBe(3);
    expect(await client.counts()).toMatchObject({ pending: 0, waiting: 3 });
    client.insert(inserted([event(3)], STATES.waiting));
    expect(await client.sharingOff()).toBe(4);
    expect(await client.counts()).toMatchObject({ waiting: 0, local: 4 });
  });

  it('serves the next batch, oldest first, and takes the marks main posts', async () => {
    const { client } = connect();
    client.insert(inserted([event(0, NOW - 2), event(1, NOW - 1), event(2, NOW)], STATES.waiting));
    const batch = await client.nextBatch(2);
    expect(batch.map((item) => item.seq)).toEqual([0, 1]);
    client.markSent([batch[0]!.id], NOW);
    client.markRefused([batch[1]!.id]);
    client.setMeta('lastBatch', '{"v":1}');
    expect(await client.counts()).toMatchObject({ waiting: 1, sent: 1, refused: 1 });
    expect(await client.meta('lastBatch')).toBe('{"v":1}');
    const unsent = await client.unsentToLocal();
    expect(unsent).toBe(1);
  });

  it('pages the record newest first and counts what the limits would remove', async () => {
    const { client } = connect();
    client.insert(
      inserted(
        Array.from({ length: 30 }, (_, i) => event(i, NOW - (29 - i) * DAY)),
        STATES.local,
      ),
    );
    const first = await client.page({ limit: 10 });
    expect(first.total).toBe(30);
    expect(first.events.map((item) => item.seq)).toEqual([29, 28, 27, 26, 25, 24, 23, 22, 21, 20]);
    const last = first.events.at(-1)!;
    const next = await client.page({ limit: 10, before: { at: last.at, id: last.id } });
    expect(next.events[0]!.seq).toBe(19);
    expect(next.newer).toBe(10);
    // Older than 7 days: 22 of them (days 8 to 29 back).
    expect(await client.outside({ 'events.days': 7, 'events.max': 5000 }, NOW)).toBe(22);
    expect(await client.outside({ 'events.days': 360, 'events.max': 500 }, NOW)).toBe(0);
  });

  it('prunes a batch at a time, answering calls between batches', async () => {
    const { client, store } = connect({ pruneBatch: 50 });
    store.insert(
      inserted(
        Array.from({ length: 1000 }, (_, i) => event(i, NOW - 30 * DAY + i)),
        STATES.local,
      ),
    );
    store.insert(inserted([event(1000, NOW)], STATES.local));
    const pruning = client.prune({ 'events.days': 7, 'events.max': 5000 }, NOW);
    // A count asked while it runs is answered before it ends.
    const counted = await client.counts();
    expect(counted.local).toBeGreaterThan(1);
    expect(await pruning).toBe(1000);
    expect(await client.counts()).toMatchObject({ local: 1 });
  });

  it('closes after inserting what waits, and answers nothing after', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const { store, client, host } = connect();
    client.insert(inserted([event(0)]));
    await client.close();
    expect(client.gone).toBe(true);
    expect(host.buffered).toBe(0);
    // The store is closed: `size` throws on a closed database.
    expect(() => store.size()).toThrow();
    // A gone worker's questions answer as an empty record.
    expect(await client.counts()).toEqual({
      pending: 0,
      local: 0,
      waiting: 0,
      sent: 0,
      refused: 0,
    });
    expect(await client.page({})).toEqual({ events: [], total: 0, newer: 0 });
  });

  it('answers as an empty record when the worker fails, and never throws', async () => {
    const listeners: Record<string, (value: unknown) => void> = {};
    const postMessage = vi.fn();
    const port = {
      postMessage,
      on: (name: string, listener: (value: unknown) => void) => {
        listeners[name] = listener;
        return port;
      },
    } as unknown as StorePort;
    const logged: string[] = [];
    const client = new WorkerStore(port, (message) => logged.push(message));
    const counting = client.counts();
    listeners.error!(new Error('no node:sqlite'));
    expect(await counting).toMatchObject({ pending: 0 });
    expect(await client.nextBatch(200)).toEqual([]);
    client.insert(inserted([event(0)]));
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(logged[0]).toContain('no node:sqlite');
  });

  it('keeps events for a busy database and inserts them on the next try', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const errors: string[] = [];
    const { store, host } = connect({ onError: (message) => errors.push(message) });
    const insert = store.insert.bind(store);
    let busy = true;
    vi.spyOn(store, 'insert').mockImplementation((events) => {
      if (busy) throw new Error('database is locked');
      return insert(events);
    });
    host.handle({ op: 'insert', events: inserted([event(0)]) });
    vi.advanceTimersByTime(1000);
    expect(host.buffered).toBe(1);
    expect(errors[0]).toContain('locked');
    busy = false;
    vi.advanceTimersByTime(1000);
    expect(host.buffered).toBe(0);
    expect(store.size()).toBe(1);
  });
});
