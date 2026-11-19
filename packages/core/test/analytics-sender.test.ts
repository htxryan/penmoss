/**
 * Sending (PEN-137, AC17): against a fake endpoint, the oldest waiting events go in one batch;
 * 202 marks them sent (or refused, by index); a 4xx refuses the batch; a 5xx, a timeout or being
 * offline keeps them and backs off to an hour; 429 waits as long as Retry-After says. Nothing
 * throws to the caller. And Delete My Shared Data's request.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_BACKOFF_MS,
  MAX_BATCH_BYTES,
  SEND_EVERY_MS,
  STATES,
  type AnalyticsEvent,
  type StateCode,
} from '../src/analytics/events';
import {
  ANALYTICS_BASE,
  analyticsBase,
  Backoff,
  batchBody,
  forgetShared,
  sendNext,
  type SendOutcome,
} from '../src/analytics/node/sender';
import { AnalyticsStore } from '../src/analytics/node/store';
import { validateBatch } from '../src/analytics/validate';

const INSTALL = '5c0e8f6a1b2c4d3e8f90a1b2c3d47a96';
const BASE = 'http://127.0.0.1:9';
const NOW = Date.parse('2026-11-19T12:00:00.000Z');

function ev(seq: number, overrides: Partial<AnalyticsEvent> = {}): AnalyticsEvent {
  return {
    session: '0123456789abcdef',
    seq,
    at: NOW - 100_000 + seq,
    client: 'mac',
    actor: 'person',
    version: '1.4.0',
    channel: 'stable',
    os: 'macos',
    osVersion: '26.1',
    kind: 'command',
    name: 'note.new',
    props: { source: 'key' },
    ...overrides,
  };
}

interface Call {
  readonly url: string;
  readonly init: RequestInit;
  readonly body: string;
}

/** A fake fetch answering each call with `answer`, recording the calls. */
function fakeFetch(answer: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const call = {
      url: typeof url === 'string' ? url : url instanceof URL ? url.href : url.url,
      init: init ?? {},
      body: typeof init?.body === 'string' ? init.body : '',
    };
    calls.push(call);
    return answer(call);
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

/** An answer that never comes until the request's signal aborts. */
function abortable(call: Call): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const signal = call.init.signal!;
    if (signal.aborted) reject(new DOMException('aborted', 'AbortError'));
    signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  });
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

let store: AnalyticsStore;

beforeEach(() => {
  store = AnalyticsStore.open(':memory:');
});

afterEach(() => {
  store.close();
});

function seed(
  n: number,
  state: StateCode = STATES.waiting,
  overrides: Partial<AnalyticsEvent> = {},
) {
  store.insert(Array.from({ length: n }, (_, i) => ({ event: ev(i, overrides), state })));
}

describe('analyticsBase', () => {
  it('is t.penmoss.app unless PENMOSS_ANALYTICS_URL says otherwise', () => {
    expect(analyticsBase({})).toBe(ANALYTICS_BASE);
    expect(ANALYTICS_BASE).toBe('https://t.penmoss.app');
    expect(analyticsBase({ PENMOSS_ANALYTICS_URL: ' http://127.0.0.1:8787/ ' })).toBe(
      'http://127.0.0.1:8787',
    );
    expect(analyticsBase({ PENMOSS_ANALYTICS_URL: '  ' })).toBe(ANALYTICS_BASE);
  });
});

describe('sendNext', () => {
  it('sends nothing when nothing waits', async () => {
    seed(3, STATES.local);
    seed(0);
    const { fetch, calls } = fakeFetch(() => json(202, {}));
    expect(await sendNext(store, INSTALL, { base: BASE, fetch })).toEqual({ kind: 'empty' });
    expect(calls).toEqual([]);
  });

  it('posts the oldest waiting events as one valid batch, and marks them sent', async () => {
    store.insert([
      { event: ev(0), state: STATES.local },
      { event: ev(1), state: STATES.pending },
      { event: ev(2), state: STATES.waiting },
      { event: ev(3), state: STATES.waiting },
    ]);
    const { fetch, calls } = fakeFetch(() => json(202, { accepted: 2, dropped: 0, refused: [] }));
    const outcome = await sendNext(store, INSTALL, { base: BASE, fetch, now: () => NOW });
    expect(outcome).toEqual({ kind: 'sent', sent: 2, refused: 0 });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call!.url).toBe(`${BASE}/v1/batch`);
    expect(call!.init.method).toBe('POST');
    expect(call!.init.headers).toEqual({ 'content-type': 'application/json' });
    const body = JSON.parse(call!.body) as unknown;
    expect(body).toEqual({ v: 1, install: INSTALL, events: [ev(2), ev(3)] });
    expect(validateBatch(body)).toEqual({ install: INSTALL, valid: [ev(2), ev(3)], refused: [] });
    expect(store.counts()).toMatchObject({ sent: 2, waiting: 0, local: 1, pending: 1 });
    expect(store.page({ state: 'sent' }).events.every((each) => each.sentAt === NOW)).toBe(true);
    // The viewer's Copy as JSON: the exact body of the last batch sent.
    expect(store.meta('lastBatch')).toBe(call!.body);
    expect(store.meta('lastBatchAt')).toBe(String(NOW));
  });

  it('marks the events the endpoint refused by their index in the batch', async () => {
    seed(5);
    const { fetch } = fakeFetch(() => json(202, { accepted: 3, dropped: 2, refused: [1, 4, 9] }));
    expect(await sendNext(store, INSTALL, { base: BASE, fetch })).toEqual({
      kind: 'sent',
      sent: 3,
      refused: 2,
    });
    expect(store.page({ state: 'refused' }).events.map((each) => each.seq)).toEqual([4, 1]);
    expect(store.page({ state: 'sent' }).events.map((each) => each.seq)).toEqual([3, 2, 0]);
  });

  it('takes an answer without a body as every event taken', async () => {
    seed(2);
    const { fetch } = fakeFetch(() => new Response(null, { status: 202 }));
    expect(await sendNext(store, INSTALL, { base: BASE, fetch })).toEqual({
      kind: 'sent',
      sent: 2,
      refused: 0,
    });
  });

  it('sends at most 200 events in a batch', async () => {
    seed(250);
    const { fetch, calls } = fakeFetch(() => json(202, { refused: [] }));
    await sendNext(store, INSTALL, { base: BASE, fetch });
    expect((JSON.parse(calls[0]!.body) as { events: unknown[] }).events).toHaveLength(200);
    expect(store.counts()).toMatchObject({ sent: 200, waiting: 50 });
  });

  it('trims a batch to 64 KB, leaving the rest waiting', async () => {
    // About 700 bytes an event: 200 would be about 140 KB.
    const flags = Array.from({ length: 16 }, (_, i) => `flag-${String(i).padStart(26, 'x')}`);
    seed(200, STATES.waiting, {
      client: 'cli',
      kind: 'cli',
      name: 'search',
      props: { flags, exit: 'OK', took: '<1s', tty: true },
    });
    const { fetch, calls } = fakeFetch(() => json(202, { refused: [] }));
    const outcome = await sendNext(store, INSTALL, { base: BASE, fetch });
    const body = calls[0]!.body;
    expect(new TextEncoder().encode(body).length).toBeLessThanOrEqual(MAX_BATCH_BYTES);
    const sent = (JSON.parse(body) as { events: AnalyticsEvent[] }).events;
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.length).toBeLessThan(200);
    expect(sent.map((each) => each.seq)).toEqual(sent.map((_, i) => i));
    expect(outcome).toEqual({ kind: 'sent', sent: sent.length, refused: 0 });
    expect(store.counts().waiting).toBe(200 - sent.length);
  });

  it.each([400, 404, 413])('refuses the whole batch on a %i', async (status) => {
    seed(3);
    const { fetch } = fakeFetch(() => json(status, { error: 'no' }));
    expect(await sendNext(store, INSTALL, { base: BASE, fetch })).toEqual({
      kind: 'refused',
      refused: 3,
      status,
    });
    expect(store.counts()).toMatchObject({ refused: 3, waiting: 0 });
    expect(await sendNext(store, INSTALL, { base: BASE, fetch })).toEqual({ kind: 'empty' });
  });

  it('keeps the events on a 5xx, offline, or a timeout', async () => {
    seed(3);
    const failures: Array<typeof fetch> = [
      fakeFetch(() => json(500, {})).fetch,
      fakeFetch(() => json(503, {})).fetch,
      fakeFetch(() => {
        throw new TypeError('fetch failed');
      }).fetch,
      fakeFetch(abortable).fetch,
    ];
    const outcomes: SendOutcome[] = [];
    for (const fetch of failures) {
      outcomes.push(await sendNext(store, INSTALL, { base: BASE, fetch, timeoutMs: 20 }));
    }
    expect(outcomes).toEqual([
      { kind: 'retry', status: 500 },
      { kind: 'retry', status: 503 },
      { kind: 'retry', status: null },
      { kind: 'retry', status: null },
    ]);
    expect(store.counts().waiting).toBe(3);
    expect(store.meta('lastBatch')).toBeNull();
  });

  it('gives up a send after its timeout, by default 10 s', async () => {
    seed(1);
    const started = Date.now();
    const { fetch } = fakeFetch(abortable);
    expect(await sendNext(store, INSTALL, { base: BASE, fetch, timeoutMs: 50 })).toEqual({
      kind: 'retry',
      status: null,
    });
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('stops a send when sharing is turned off, before or during it', async () => {
    seed(2);
    const before = new AbortController();
    before.abort();
    const { fetch, calls } = fakeFetch(abortable);
    const started = Date.now();
    expect(await sendNext(store, INSTALL, { base: BASE, fetch, signal: before.signal })).toEqual({
      kind: 'retry',
      status: null,
    });
    // At once, not after the 10 s timeout.
    expect(Date.now() - started).toBeLessThan(2000);
    const during = new AbortController();
    const sending = sendNext(store, INSTALL, { base: BASE, fetch, signal: during.signal });
    during.abort();
    expect(await sending).toEqual({ kind: 'retry', status: null });
    expect(calls.length).toBeLessThanOrEqual(2);
    expect(store.counts().waiting).toBe(2);
  });

  it('waits as long as a 429’s Retry-After says, at most an hour', async () => {
    seed(1);
    const cases: ReadonlyArray<readonly [Record<string, string>, number | undefined]> = [
      [{ 'retry-after': '120' }, 120_000],
      [{ 'retry-after': '0' }, 0],
      [{ 'retry-after': '999999' }, MAX_BACKOFF_MS],
      [{ 'retry-after': new Date(Date.now() + 3_600_000 * 5).toUTCString() }, MAX_BACKOFF_MS],
      [{ 'retry-after': new Date(Date.now() - 60_000).toUTCString() }, 0],
      [{ 'retry-after': 'soon' }, undefined],
      [{}, undefined],
    ];
    for (const [headers, after] of cases) {
      const { fetch } = fakeFetch(() => json(429, {}, headers));
      const outcome = await sendNext(store, INSTALL, { base: BASE, fetch });
      expect(outcome, JSON.stringify(headers)).toEqual(
        after === undefined
          ? { kind: 'retry', status: 429 }
          : { kind: 'retry', status: 429, retryAfterMs: after },
      );
    }
    expect(store.counts().waiting).toBe(1);
  });

  it('never throws, even when the store does', async () => {
    const broken = {
      nextBatch: () => store.nextBatch(200),
      markSent: () => {
        throw new Error('busy');
      },
      markRefused: () => undefined,
      setMeta: () => undefined,
    };
    seed(1);
    const { fetch } = fakeFetch(() => json(202, {}));
    expect(await sendNext(broken, INSTALL, { base: BASE, fetch })).toEqual({
      kind: 'retry',
      status: null,
    });
  });
});

describe('batchBody', () => {
  it('writes the stored fields only, and keeps a batch that fits whole', () => {
    seed(3);
    const waiting = store.nextBatch(3);
    const { body, events } = batchBody(INSTALL, waiting);
    expect(events).toEqual(waiting);
    expect(JSON.parse(body)).toEqual({ v: 1, install: INSTALL, events: [ev(0), ev(1), ev(2)] });
    expect(body).not.toMatch(/"(id|state|sentAt)"/);
  });
});

describe('Backoff', () => {
  it('waits a minute after a success, doubling after each failure to an hour', () => {
    const backoff = new Backoff();
    const retry: SendOutcome = { kind: 'retry', status: 503 };
    expect(backoff.next({ kind: 'sent', sent: 1, refused: 0 })).toBe(SEND_EVERY_MS);
    expect(backoff.failing).toBe(false);
    const waits = Array.from({ length: 9 }, () => backoff.next(retry));
    expect(waits).toEqual([1, 2, 4, 8, 16, 32, 60, 60, 60].map((minutes) => minutes * 60_000));
    expect(backoff.failing).toBe(true);
    expect(backoff.next({ kind: 'empty' })).toBe(SEND_EVERY_MS);
    expect(backoff.failing).toBe(false);
    expect(backoff.next(retry)).toBe(60_000);
  });

  it('takes Retry-After as it is, without counting a failure', () => {
    const backoff = new Backoff();
    expect(backoff.next({ kind: 'retry', status: 429, retryAfterMs: 5000 })).toBe(5000);
    expect(backoff.failing).toBe(false);
    expect(backoff.next({ kind: 'retry', status: null })).toBe(60_000);
  });

  it('starts again after a refused batch', () => {
    const backoff = new Backoff();
    backoff.next({ kind: 'retry', status: null });
    backoff.next({ kind: 'retry', status: null });
    expect(backoff.next({ kind: 'refused', refused: 1, status: 400 })).toBe(SEND_EVERY_MS);
    expect(backoff.failing).toBe(false);
  });
});

describe('forgetShared', () => {
  it('asks the server to delete everything under the ID', async () => {
    const { fetch, calls } = fakeFetch(() => json(202, { deleted: true }));
    expect(await forgetShared(INSTALL, { base: BASE, fetch })).toBe('ok');
    expect(calls[0]!.url).toBe(`${BASE}/v1/forget`);
    expect(calls[0]!.init.method).toBe('POST');
    expect(JSON.parse(calls[0]!.body)).toEqual({ v: 1, install: INSTALL });
  });

  it('says failed when the server refuses, and offline when it cannot be reached', async () => {
    expect(
      await forgetShared(INSTALL, { base: BASE, fetch: fakeFetch(() => json(200, {})).fetch }),
    ).toBe('ok');
    for (const status of [400, 429, 500, 503]) {
      const { fetch } = fakeFetch(() => json(status, {}));
      expect(await forgetShared(INSTALL, { base: BASE, fetch }), String(status)).toBe('failed');
    }
    const offline = fakeFetch(() => {
      throw new TypeError('fetch failed');
    }).fetch;
    expect(await forgetShared(INSTALL, { base: BASE, fetch: offline })).toBe('offline');
    const slow = fakeFetch(abortable).fetch;
    expect(await forgetShared(INSTALL, { base: BASE, fetch: slow, timeoutMs: 20 })).toBe('offline');
  });
});
