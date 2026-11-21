/**
 * Usage analytics in the Mac app's main process (PEN-137): the stamper, the states each answer
 * gives (AC10, AC11, AC12), the switch, Reset My Analytics ID and Delete My Shared Data (AC16),
 * and sending when the endpoint is unreachable, slow or refusing (AC17), with a fake endpoint,
 * a fake clock and the real record behind the worker's protocol (in-process).
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { MessageChannel } from 'node:worker_threads';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_BACKOFF_MS,
  newConsentFile,
  SEND_EVERY_MS,
  type AnalyticsBatch,
  type ConsentFile,
  type StateName,
} from '@penmoss/core/analytics';
import {
  AnalyticsStore,
  readConsentFile,
  updateConsentFile,
  writeConsentFile,
} from '@penmoss/core/analytics/node';
import {
  Analytics,
  macFields,
  parseLimitChanges,
  parsePageEvents,
  parsePageQuery,
  watchConsent,
  type AnalyticsStatus,
} from '../../src/analytics';
import { StoreHost, type HostMessage } from '../../src/analytics-host';
import { WorkerStore } from '../../src/analytics-store';

const NOW = Date.UTC(2026, 10, 19, 12);
const DAY = 86_400_000;
const BASE = 'http://127.0.0.1:8799';

interface Sent {
  readonly url: string;
  readonly body: AnalyticsBatch & { readonly install: string };
}

type Respond = (sent: Sent, signal: AbortSignal | undefined) => Promise<Response> | Response;

const accepted: Respond = (sent) =>
  new Response(
    JSON.stringify({ accepted: sent.body.events?.length ?? 0, dropped: 0, refused: [] }),
    { status: 202 },
  );

const cleanups: Array<() => void | Promise<void>> = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
});

afterEach(async () => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function world(
  options: {
    consent?: Partial<ConsentFile>;
    env?: Record<string, string>;
    hasNotebook?: boolean;
    respond?: Respond;
  } = {},
) {
  const home = mkdtempSync(join(tmpdir(), 'penmoss-analytics-'));
  const consentPath = join(home, 'analytics.json');
  if (options.consent) writeConsentFile({ ...newConsentFile(), ...options.consent }, consentPath);
  const clock = { now: NOW };
  const store = AnalyticsStore.open(':memory:');
  const channel = new MessageChannel();
  const host = new StoreHost(
    store,
    (reply) => channel.port2.postMessage(reply),
    { 'events.days': 7, 'events.max': 5000 },
    { now: () => clock.now },
  );
  channel.port2.on('message', (message: HostMessage) => host.handle(message));
  const client = new WorkerStore(channel.port1);
  const sent: Sent[] = [];
  let respond: Respond = options.respond ?? accepted;
  const fetch = vi.fn((url: string, init?: RequestInit) => {
    const one = { url, body: JSON.parse(init?.body as string) as Sent['body'] };
    sent.push(one);
    return Promise.resolve(respond(one, init?.signal ?? undefined));
  });
  const logs = {
    bytes: vi.fn(() => Promise.resolve(2048)),
    preview: vi.fn(() => Promise.resolve(4096)),
    apply: vi.fn(() => Promise.resolve()),
  };
  const changes: AnalyticsStatus[] = [];
  const analytics = new Analytics({
    consentPath,
    store: client,
    env: options.env ?? {},
    base: BASE,
    fields: macFields({
      version: '0.2.2',
      packaged: true,
      platform: 'darwin',
      systemVersion: '15.1.2',
    }),
    hasNotebook: () => Promise.resolve(options.hasNotebook ?? true),
    logs,
    onChange: (status) => changes.push(status),
    fetch: fetch as unknown as typeof globalThis.fetch,
    now: () => clock.now,
    session: '0123456789abcdef',
  });
  cleanups.push(async () => {
    await analytics.close(50);
    await host.close();
    channel.port1.close();
    channel.port2.close();
    rmSync(home, { recursive: true, force: true });
  });
  const counts = async (): Promise<Record<StateName, number>> => client.counts();
  const page = (n: number) => ({
    kind: 'command',
    name: 'note.new',
    props: { source: 'key' },
    at: NOW + n,
  });
  return {
    analytics,
    store,
    client,
    consentPath,
    clock,
    sent,
    fetch,
    logs,
    changes,
    counts,
    page,
    setRespond: (next: Respond) => {
      respond = next;
    },
  };
}

describe('session detail refs (PEN-177)', () => {
  const NOTE = '01JB7Q3V6M8K2T9RZ4XN5C1HPD';
  const FOLDER = '01JB7Q3V6M8K2T9RZ4XN5FOLDR';
  const opened = (at: number) => ({
    kind: 'note',
    name: 'open',
    props: { how: 'open', titleChars: 12, shape: ['h1:12', 'p:40'] },
    refs: { note: NOTE, folder: FOLDER },
    at,
  });

  it('stores a ref for the note and its folder, never the id, and the same ref each time', async () => {
    const w = world();
    expect(w.analytics.recordPage([opened(NOW + 1), opened(NOW + 2)])).toBe(2);
    const events = (await w.client.page({})).events;
    for (const event of events) {
      expect(event.props['note']).toMatch(/^[0-9a-f]{16}$/);
      expect(event.props['folder']).toMatch(/^[0-9a-f]{16}$/);
      expect(JSON.stringify(event)).not.toContain(NOTE);
      expect(JSON.stringify(event)).not.toContain(FOLDER);
    }
    expect(events[0]!.props['note']).toBe(events[1]!.props['note']);
    expect(events[0]!.props['note']).not.toBe(events[0]!.props['folder']);
    expect(events[0]!.props['note']).toBe(w.analytics.refOf('note', NOTE));
  });

  it('keeps the key beside the consent file, out of it and out of the status', async () => {
    const w = world();
    w.analytics.recordPage([opened(NOW)]);
    const key = readFileSync(join(dirname(w.consentPath), 'analytics-key'), 'utf8').trim();
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(w.consentPath, 'utf8')).not.toContain(key);
    expect(JSON.stringify(await w.analytics.status())).not.toContain(key);
  });

  it('makes a new key with a new ID: Reset My Analytics ID and Delete My Shared Data', async () => {
    const w = world();
    const first = w.analytics.refOf('note', NOTE);
    await w.analytics.resetId();
    const second = w.analytics.refOf('note', NOTE);
    expect(second).not.toBe(first);
    expect(await w.analytics.forget()).toEqual({ outcome: 'ok' });
    expect(w.analytics.refOf('note', NOTE)).not.toBe(second);
  });

  it('drops a ref id that is not a string, and an event of a new kind from a page with a prop it may not have', async () => {
    const w = world();
    const kept = w.analytics.recordPage([
      { ...opened(NOW), refs: { note: 42, folder: { id: 'x' } } },
      { ...opened(NOW), props: { title: 'Plans for the week' } },
    ]);
    expect(kept).toBe(1);
    const [event] = (await w.client.page({})).events;
    expect(event!.props).toEqual({ how: 'open', titleChars: 12, shape: ['h1:12', 'p:40'] });
  });
});

describe('the stamper', () => {
  it('stamps one session, seq in arrival order and the Mac’s fields on every event', async () => {
    const w = world();
    expect(w.analytics.recordPage([w.page(1), w.page(2)])).toBe(2);
    w.clock.now = NOW + 2;
    expect(w.analytics.record('app', 'launch', { notebooks: '1' })).toBe(true);
    expect(w.analytics.recordPage([{ ...w.page(3), sizeClass: 'expanded' }])).toBe(1);
    const events = (await w.client.page({})).events;
    expect(events.map((event) => event.seq)).toEqual([3, 2, 1, 0]);
    expect(events[0]).toMatchObject({
      session: '0123456789abcdef',
      client: 'mac',
      actor: 'person',
      version: '0.2.2',
      channel: 'stable',
      os: 'macos',
      osVersion: '15.1',
      sizeClass: 'expanded',
      at: NOW + 3,
      state: 'pending',
    });
    expect(events[1]).toMatchObject({ kind: 'app', name: 'launch', at: NOW + 2 });
  });

  it('drops what the catalogue does not allow, without using up a seq', async () => {
    const w = world();
    const kept = w.analytics.recordPage([
      { kind: 'command', name: 'note.new', props: { source: 'key' }, at: NOW },
      // A name built from data, free text in a prop, an unknown prop and a field it may not set.
      { kind: 'command', name: 'note.My secret title', props: {}, at: NOW },
      { kind: 'command', name: 'note.new', props: { source: 'Okapicanary Folder' }, at: NOW },
      { kind: 'command', name: 'note.new', props: { title: 'x' }, at: NOW },
      'not an event',
      { kind: 'screen', name: 'home', at: NOW + 1, props: { from: 'home' } },
    ]);
    expect(kept).toBe(2);
    const events = (await w.client.page({})).events;
    expect(events.map((event) => [event.seq, event.name])).toEqual([
      [1, 'home'],
      [0, 'note.new'],
    ]);
    expect(w.analytics.record('menu', 'a note title')).toBe(false);
  });

  it('takes main’s clock for a page time that is far off', async () => {
    const w = world();
    w.analytics.recordPage([{ kind: 'command', name: 'note.new', props: {}, at: NOW - 3 * DAY }]);
    w.analytics.recordPage([{ kind: 'command', name: 'note.new', props: {}, at: 'soon' }]);
    const events = (await w.client.page({})).events;
    expect(events.map((event) => event.at)).toEqual([NOW, NOW]);
  });

  it('reads the Mac’s fields from the build: dev, Alpha or stable, and major.minor', () => {
    const fields = (version: string, packaged: boolean) =>
      macFields({ version, packaged, platform: 'darwin', systemVersion: '26.0.1' });
    expect(fields('0.1.0', false)).toMatchObject({ channel: 'dev', osVersion: '26.0' });
    expect(fields('0.2.2-alpha.1185', true)).toMatchObject({
      channel: 'alpha',
      version: '0.2.2-alpha.1185',
    });
    expect(fields('0.2.2', true)).toMatchObject({ channel: 'stable', client: 'mac' });
    // A version the check would refuse would drop every event: it is 0.0.0 instead.
    expect(fields('v45', true).version).toBe('0.0.0');
  });

  it('checks what a page sends before anything is made of it', () => {
    expect(parsePageEvents('x')).toEqual([]);
    expect(
      parsePageEvents(Array.from({ length: 500 }, () => ({ kind: 'app', name: 'launch', at: 1 }))),
    ).toHaveLength(200);
    expect(
      parsePageQuery({ state: 'sent', client: 'cli', limit: 5000, before: { at: 1, id: 2 } }),
    ).toEqual({
      state: 'sent',
      client: 'cli',
      limit: 1000,
      before: { at: 1, id: 2 },
    });
    expect(parsePageQuery({ state: 'drop table', client: 7, after: { at: 'x' } })).toEqual({});
    expect(
      parseLimitChanges({ 'events.days': 3, 'events.max': 1, 'logs.files': 9, other: 2 }),
    ).toEqual({
      'events.days': 3,
    });
  });
});

describe('the answer and the states (O3)', () => {
  it('records pending with no answer, and sends nothing (AC10, AC11)', async () => {
    const w = world();
    w.analytics.recordPage([w.page(1)]);
    expect(await w.analytics.sendNow()).toBeNull();
    expect(w.fetch).not.toHaveBeenCalled();
    expect(await w.counts()).toMatchObject({ pending: 1 });
  });

  it('asks once there is a notebook and no answer', async () => {
    expect((await world({ hasNotebook: false }).analytics.status()).ask).toBe(false);
    const w = world();
    expect(await w.analytics.status()).toMatchObject({ ask: true, consent: null, optedOut: false });
    await w.analytics.answer('no');
    expect((await w.analytics.status()).ask).toBe(false);
  });

  it('Yes sends what was recorded before it, the first run included, in seq order (AC12)', async () => {
    const w = world();
    w.analytics.recordPage([w.page(1), w.page(2)]);
    w.clock.now = NOW + 2;
    w.analytics.record('firstrun', 'consent');
    const status = await w.analytics.answer('yes');
    expect(status).toMatchObject({ consent: 'yes', counts: { pending: 0, waiting: 3 } });
    expect(readConsentFile(w.consentPath)).toMatchObject({
      consent: 'yes',
      answeredAt: NOW + 2,
      askedVersion: '0.2.2',
      sharingSince: NOW + 2,
    });
    w.analytics.recordPage([w.page(3)]);
    expect(await w.analytics.sendNow()).toEqual({ kind: 'sent', sent: 4, refused: 0 });
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0]!.url).toBe(`${BASE}/v1/batch`);
    expect(w.sent[0]!.body.install).toBe(status.install);
    expect(w.sent[0]!.body.events.map((event) => event.seq)).toEqual([0, 1, 2, 3]);
    expect(await w.counts()).toMatchObject({ waiting: 0, sent: 4 });
    expect((await w.analytics.status()).lastBatch).toBe(JSON.stringify(w.sent[0]!.body));
  });

  it('No keeps them here for good, even once sharing is turned on later (AC12)', async () => {
    const w = world();
    w.analytics.recordPage([w.page(1)]);
    await w.analytics.answer('no');
    w.analytics.recordPage([w.page(2)]);
    expect(await w.analytics.sendNow()).toBeNull();
    expect(w.fetch).not.toHaveBeenCalled();
    expect(await w.counts()).toMatchObject({ local: 2, pending: 0 });
    // On later: only what is recorded from now on goes.
    const on = await w.analytics.setSharing(true);
    expect(on).toMatchObject({ consent: 'yes', sharingSince: NOW, counts: { local: 2 } });
    w.analytics.recordPage([w.page(3)]);
    await w.analytics.sendNow();
    expect(w.sent.flatMap((batch) => batch.body.events.map((event) => event.seq))).toEqual([2]);
    expect(await w.counts()).toMatchObject({ local: 2, sent: 1 });
  });

  it('keeps every event here with DO_NOT_TRACK, whatever the answer', async () => {
    const w = world({ env: { DO_NOT_TRACK: '1' }, consent: { consent: 'yes', sharingSince: NOW } });
    w.analytics.recordPage([w.page(1)]);
    expect(await w.analytics.sendNow()).toBeNull();
    expect(w.fetch).not.toHaveBeenCalled();
    expect(await w.analytics.status()).toMatchObject({ optedOut: true, counts: { local: 1 } });
  });

  it('turning the switch on with no answer yet is the answer: what waited goes too', async () => {
    const w = world();
    w.analytics.recordPage([w.page(1)]);
    await w.analytics.setSharing(true);
    expect(await w.counts()).toMatchObject({ waiting: 1, pending: 0 });
  });
});

describe('Settings → Privacy (AC16)', () => {
  it('sharing off: waiting events are Not Shared at once, and a batch in flight stops', async () => {
    const w = world({ consent: { consent: 'yes', sharingSince: NOW } });
    let started!: () => void;
    const inFlight = new Promise<void>((resolve) => {
      started = resolve;
    });
    w.setRespond(
      (_sent, signal) =>
        new Promise<Response>((_resolve, reject) => {
          started();
          signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    w.analytics.recordPage([w.page(1), w.page(2)]);
    const sending = w.analytics.sendNow();
    await inFlight;
    const off = await w.analytics.setSharing(false);
    expect(await sending).toBeNull();
    expect(off).toMatchObject({
      consent: 'no',
      sharingSince: null,
      counts: { waiting: 0, local: 2 },
    });
    expect(await w.counts()).toMatchObject({ sent: 0, local: 2 });
    w.analytics.recordPage([w.page(3)]);
    expect(await w.counts()).toMatchObject({ local: 3 });
    expect(w.changes.at(-1)?.consent).toBe('no');
  });

  it('Reset My Analytics ID: a new ID, and what was not sent stays here, Not Shared', async () => {
    const w = world({ consent: { consent: 'yes', sharingSince: NOW } });
    const before = (await w.analytics.status()).install;
    w.analytics.recordPage([w.page(1)]);
    const after = await w.analytics.resetId();
    expect(after.install).not.toBe(before);
    expect(after.install).toMatch(/^[0-9a-f]{32}$/);
    expect(readConsentFile(w.consentPath).install).toBe(after.install);
    expect(after.counts).toMatchObject({ waiting: 0, local: 1 });
    // Sharing stays on: what is recorded now goes under the new ID.
    w.analytics.recordPage([w.page(2)]);
    await w.analytics.sendNow();
    expect(w.sent[0]!.body.install).toBe(after.install);
    expect(w.sent[0]!.body.events.map((event) => event.seq)).toEqual([1]);
  });

  it('Delete My Shared Data: the server forgets the old ID, then a new one', async () => {
    const w = world({
      consent: { consent: 'yes', sharingSince: NOW },
      respond: () => new Response(null, { status: 202 }),
    });
    const before = (await w.analytics.status()).install;
    w.analytics.recordPage([w.page(1)]);
    expect(await w.analytics.forget()).toEqual({ outcome: 'ok' });
    expect(w.sent[0]).toEqual({ url: `${BASE}/v1/forget`, body: { v: 1, install: before } });
    const after = await w.analytics.status();
    expect(after.install).not.toBe(before);
    expect(after.counts).toMatchObject({ waiting: 0, local: 1 });
  });

  it('Delete My Shared Data offline or refused changes nothing', async () => {
    const w = world({ consent: { consent: 'yes', sharingSince: NOW } });
    const before = await w.analytics.status();
    w.analytics.recordPage([w.page(1)]);
    w.setRespond(() => {
      throw new TypeError('fetch failed');
    });
    expect(await w.analytics.forget()).toEqual({ outcome: 'offline' });
    w.setRespond(() => new Response('{}', { status: 500 }));
    expect(await w.analytics.forget()).toEqual({ outcome: 'failed' });
    const after = await w.analytics.status();
    expect(after.install).toBe(before.install);
    expect(after.counts).toMatchObject({ waiting: 1 });
  });
});

describe('sending (AC17)', () => {
  it('offline, a 5xx or a timeout keeps the events and backs off to an hour, never throwing', async () => {
    const w = world({ consent: { consent: 'yes', sharingSince: NOW } });
    w.analytics.recordPage([w.page(1), w.page(2)]);
    w.setRespond(() => {
      throw new TypeError('fetch failed');
    });
    expect(await w.analytics.sendNow()).toEqual({ kind: 'retry', status: null });
    expect(w.analytics.nextSendIn).toBe(SEND_EVERY_MS);
    w.setRespond(() => new Response('', { status: 503 }));
    expect(await w.analytics.sendNow()).toEqual({ kind: 'retry', status: 503 });
    expect(w.analytics.nextSendIn).toBe(2 * SEND_EVERY_MS);
    // Slow: given up after 10 s.
    w.setRespond(
      (_sent, signal) =>
        new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('timeout')));
        }),
    );
    const slow = w.analytics.sendNow();
    await vi.waitFor(() => expect(w.fetch).toHaveBeenCalledTimes(3));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await slow).toEqual({ kind: 'retry', status: null });
    expect(w.analytics.nextSendIn).toBe(4 * SEND_EVERY_MS);
    w.setRespond(() => {
      throw new TypeError('fetch failed');
    });
    for (let i = 0; i < 10; i++) await w.analytics.sendNow();
    expect(w.analytics.nextSendIn).toBe(MAX_BACKOFF_MS);
    expect(await w.counts()).toMatchObject({ waiting: 2, sent: 0 });
    // Back: sent, and the pace is a minute again.
    w.setRespond(accepted);
    expect(await w.analytics.sendNow()).toEqual({ kind: 'sent', sent: 2, refused: 0 });
    expect(w.analytics.nextSendIn).toBe(SEND_EVERY_MS);
  });

  it('a 4xx refuses the batch; 429 waits as long as Retry-After says', async () => {
    const w = world({ consent: { consent: 'yes', sharingSince: NOW } });
    w.analytics.recordPage([w.page(1)]);
    w.setRespond(() => new Response('', { status: 429, headers: { 'retry-after': '120' } }));
    expect(await w.analytics.sendNow()).toEqual({
      kind: 'retry',
      status: 429,
      retryAfterMs: 120_000,
    });
    expect(w.analytics.nextSendIn).toBe(120_000);
    w.setRespond(() => new Response('', { status: 400 }));
    expect(await w.analytics.sendNow()).toEqual({ kind: 'refused', refused: 1, status: 400 });
    expect(await w.counts()).toMatchObject({ refused: 1, waiting: 0 });
  });

  it('marks refused the events the endpoint names by index', async () => {
    const w = world({
      consent: { consent: 'yes', sharingSince: NOW },
      respond: () =>
        new Response(JSON.stringify({ accepted: 1, dropped: 1, refused: [1] }), { status: 202 }),
    });
    w.analytics.recordPage([w.page(1), w.page(2)]);
    expect(await w.analytics.sendNow()).toEqual({ kind: 'sent', sent: 1, refused: 1 });
    const events = (await w.client.page({})).events;
    expect(events.map((event) => [event.seq, event.state])).toEqual([
      [1, 'refused'],
      [0, 'sent'],
    ]);
  });

  it('sends every minute, and at once when 25 wait', async () => {
    const w = world({ consent: { consent: 'yes', sharingSince: NOW } });
    w.analytics.start();
    expect(w.analytics.nextSendIn).toBe(SEND_EVERY_MS);
    w.analytics.recordPage(Array.from({ length: 24 }, (_, i) => w.page(i)));
    expect(w.analytics.nextSendIn).toBe(SEND_EVERY_MS);
    w.analytics.recordPage([w.page(25)]);
    expect(w.analytics.nextSendIn).toBe(0);
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(w.sent).toHaveLength(1));
    expect(w.sent[0]!.body.events).toHaveLength(25);
  });

  it('sends at most 200 at a time, the next batch soon after', async () => {
    const w = world({ consent: { consent: 'yes', sharingSince: NOW } });
    for (let i = 0; i < 3; i++)
      w.analytics.recordPage(Array.from({ length: 100 }, (_, n) => w.page(i * 100 + n)));
    expect(await w.analytics.sendNow()).toEqual({ kind: 'sent', sent: 200, refused: 0 });
    expect(w.analytics.nextSendIn).toBeLessThan(SEND_EVERY_MS);
    expect(await w.analytics.sendNow()).toEqual({ kind: 'sent', sent: 100, refused: 0 });
    expect(await w.counts()).toMatchObject({ sent: 300 });
  });

  it('records quit and starts a last send as the app quits', async () => {
    const w = world({ consent: { consent: 'yes', sharingSince: NOW } });
    w.analytics.recordPage([w.page(1)]);
    w.clock.now = NOW + 5;
    w.analytics.quitting();
    w.analytics.quitting();
    await vi.waitFor(() => expect(w.sent).toHaveLength(1));
    expect(w.sent[0]!.body.events.map((event) => event.name)).toEqual(['note.new', 'quit']);
  });
});

describe('the limits', () => {
  it('previews what lower limits would delete, and saves and prunes them at once', async () => {
    const w = world({ consent: { consent: 'no' } });
    w.analytics.recordPage([
      { kind: 'command', name: 'note.new', props: {}, at: NOW - 20 * 3_600_000 },
    ]);
    w.clock.now = NOW + 3 * DAY;
    w.analytics.recordPage([{ kind: 'command', name: 'note.new', props: {}, at: NOW + 3 * DAY }]);
    expect(await w.analytics.preview({ 'events.days': 2 })).toEqual({ events: 1, logBytes: 4096 });
    expect(w.logs.preview).toHaveBeenCalledWith(
      expect.objectContaining({ 'events.days': 2, 'logs.days': 7 }),
    );
    expect(await w.counts()).toMatchObject({ local: 2 });
    const status = await w.analytics.setLimits({ 'events.days': 2, 'report.lines': 50 });
    expect(status.limits).toMatchObject({
      'events.days': 2,
      'report.lines': 50,
      'events.max': 200_000,
    });
    expect(status.counts).toMatchObject({ local: 1 });
    expect(readConsentFile(w.consentPath).limits).toEqual({ 'events.days': 2, 'report.lines': 50 });
    expect(w.logs.apply).toHaveBeenLastCalledWith(expect.objectContaining({ 'report.lines': 50 }));
    // Out of range is never saved; Reset to Defaults clears every change.
    await w.analytics.setLimits({ 'events.days': 999 });
    expect(readConsentFile(w.consentPath).limits).toEqual({ 'events.days': 2, 'report.lines': 50 });
    await w.analytics.setLimits(null);
    expect(readConsentFile(w.consentPath).limits).toEqual({});
  });
});

describe('the CLI’s changes to the file', () => {
  it('follows an answer, a new ID and new limits written by another process', async () => {
    const w = world();
    w.analytics.recordPage([w.page(1)]);
    updateConsentFile((file) => ({ ...file, consent: 'yes', sharingSince: NOW }), w.consentPath);
    await w.analytics.reload();
    expect(await w.counts()).toMatchObject({ waiting: 1 });
    w.analytics.recordPage([w.page(2)]);
    expect(await w.counts()).toMatchObject({ waiting: 2 });
    updateConsentFile((file) => ({ ...file, install: 'f'.repeat(32) }), w.consentPath);
    await w.analytics.reload();
    expect(await w.counts()).toMatchObject({ waiting: 0, local: 2 });
    expect(w.changes.at(-1)?.install).toBe('f'.repeat(32));
    updateConsentFile((file) => ({ ...file, consent: 'no', sharingSince: null }), w.consentPath);
    w.analytics.recordPage([w.page(3)]);
    await w.analytics.reload();
    expect(await w.counts()).toMatchObject({ waiting: 0, local: 3 });
    updateConsentFile((file) => ({ ...file, limits: { 'logs.files': 1 } }), w.consentPath);
    await w.analytics.reload();
    expect(w.logs.apply).toHaveBeenLastCalledWith(expect.objectContaining({ 'logs.files': 1 }));
  });

  it('watches the file, so a change made by a rename is seen', async () => {
    vi.useRealTimers();
    const w = world();
    const seen = vi.fn();
    const watcher = watchConsent(w.consentPath, seen, 20, 50);
    cleanups.push(() => watcher.close());
    // The watcher's first look at the file, before the change.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(seen).not.toHaveBeenCalled();
    updateConsentFile((file) => ({ ...file, consent: 'yes' }), w.consentPath);
    await vi.waitFor(() => expect(seen).toHaveBeenCalled(), { timeout: 5000 });
  });
});
