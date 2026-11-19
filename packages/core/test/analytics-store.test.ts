/**
 * The local usage record (PEN-137, N10, AC10, AC12, AC16, AC17): one SQLite database shared by
 * the Mac app, the CLI and the MCP server. Events are stored once, change state as the answer
 * does, leave oldest first, page newest first by keyset, and are pruned by age and by cap a
 * batch at a time. Wall-clock budgets at 800,000 events are in analytics-store.budget.test.ts.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { STATES, type AnalyticsEvent, type StateCode } from '../src/analytics/events';
import {
  AnalyticsStore,
  wireEvent,
  type PruneStep,
  type StoredEvent,
} from '../src/analytics/node/store';

const DAY = 86_400_000;
const NOW = Date.parse('2026-11-19T12:00:00.000Z');

function ev(seq: number, at: number, overrides: Partial<AnalyticsEvent> = {}): AnalyticsEvent {
  return {
    session: '0123456789abcdef',
    seq,
    at,
    client: 'mac',
    actor: 'person',
    version: '1.4.0',
    channel: 'stable',
    os: 'macos',
    osVersion: '26.1',
    sizeClass: 'expanded',
    kind: 'command',
    name: 'note.new',
    props: { source: 'key', keys: 'Mod+N' },
    ...overrides,
  };
}

/** `n` events a second apart, ending at `end`, all in `state`. */
function many(
  n: number,
  state: StateCode,
  end = NOW,
  overrides: Partial<AnalyticsEvent> = {},
  first = 0,
) {
  return Array.from({ length: n }, (_, i) => ({
    event: ev(first + i, end - (n - 1 - i) * 1000, overrides),
    state,
  }));
}

/** The states as the rows hold them, counted the slow way. */
function rowCounts(store: AnalyticsStore): Record<string, number> {
  const counts: Record<string, number> = {};
  let before: StoredEvent | undefined;
  for (;;) {
    const page = store.page({ limit: 1000, ...(before ? { before } : {}) });
    for (const each of page.events) counts[each.state] = (counts[each.state] ?? 0) + 1;
    if (page.events.length < 1000) break;
    before = page.events.at(-1);
  }
  return counts;
}

function nonZero(counts: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(counts).filter(([, n]) => n > 0));
}

let store: AnalyticsStore;

beforeEach(() => {
  store = AnalyticsStore.open(':memory:');
});

afterEach(() => {
  store.close();
});

describe('insert', () => {
  it('stores each event once, by its session and seq', () => {
    expect(store.insert(many(3, STATES.pending))).toBe(3);
    expect(store.insert(many(3, STATES.waiting))).toBe(0);
    expect(store.insert([{ event: ev(0, NOW, { session: 'fedcba9876543210' }), state: 1 }])).toBe(
      1,
    );
    expect(store.counts()).toEqual({ pending: 3, local: 1, waiting: 0, sent: 0, refused: 0 });
    expect(store.size()).toBe(4);
    expect(store.insert([])).toBe(0);
  });

  it('gives back each event as it was recorded', () => {
    const event: AnalyticsEvent = { ...ev(7, NOW, { kind: 'cli', name: 'search', props: {} }) };
    delete (event as { sizeClass?: unknown }).sizeClass;
    store.insert([{ event: { ...event, props: { flags: ['json'], tty: false } }, state: 2 }]);
    const [stored] = store.page().events;
    expect(stored).toMatchObject({
      ...event,
      props: { flags: ['json'], tty: false },
      state: 'waiting',
      sentAt: null,
    });
    expect(stored).not.toHaveProperty('sizeClass');
    expect(wireEvent(stored!)).toEqual({ ...event, props: { flags: ['json'], tty: false } });
    expect(Object.keys(wireEvent(stored!))).not.toContain('id');
  });

  it('writes nothing when one event of a batch fails', () => {
    const bad = { event: ev(1, NOW, { props: { n: 1n } as never }), state: STATES.pending };
    expect(() => store.insert([...many(1, STATES.pending), bad])).toThrow();
    expect(store.size()).toBe(0);
    expect(store.page().events).toEqual([]);
  });

  it('skips a row the table refuses, keeping the rest', () => {
    const bad = { event: { ...ev(1, NOW), kind: null as never }, state: STATES.pending };
    expect(store.insert([...many(1, STATES.pending), bad])).toBe(1);
    expect(store.counts().pending).toBe(1);
  });
});

describe('state changes', () => {
  beforeEach(() => {
    store.insert([
      ...many(4, STATES.pending, NOW - 10_000, {}, 0),
      ...many(3, STATES.local, NOW - 5_000, {}, 10),
      ...many(2, STATES.waiting, NOW - 2_000, {}, 20),
      ...many(1, STATES.sent, NOW, {}, 30),
    ]);
  });

  it('sends what was recorded before a first Yes', () => {
    expect(store.applyAnswer('yes')).toBe(4);
    expect(nonZero(store.counts())).toEqual({ local: 3, waiting: 6, sent: 1 });
  });

  it('never sends what was recorded before a first No, even after turning sharing on', () => {
    expect(store.applyAnswer('no')).toBe(4);
    expect(nonZero(store.counts())).toEqual({ local: 7, waiting: 2, sent: 1 });
    // Turning sharing on later changes no local event.
    expect(store.applyAnswer('yes')).toBe(0);
    expect(store.counts().local).toBe(7);
  });

  it('keeps waiting events here when sharing is turned off', () => {
    expect(store.sharingOff()).toBe(2);
    expect(nonZero(store.counts())).toEqual({ pending: 4, local: 5, sent: 1 });
  });

  it('keeps every unsent event here under a new ID', () => {
    expect(store.unsentToLocal()).toBe(6);
    expect(nonZero(store.counts())).toEqual({ local: 9, sent: 1 });
  });

  it('keeps the counts by state with the rows through every change', () => {
    store.applyAnswer('yes');
    const batch = store.nextBatch(3);
    store.markSent([batch[0]!.id], NOW);
    store.markRefused([batch[1]!.id]);
    store.sharingOff();
    store.pruneNow({ 'events.days': 7, 'events.max': 6 }, NOW);
    expect(nonZero(store.counts())).toEqual(rowCounts(store));
    expect(store.size()).toBe(6);
  });
});

describe('sending', () => {
  beforeEach(() => {
    store.insert([
      { event: ev(0, NOW - 3000), state: STATES.waiting },
      { event: ev(1, NOW - 1000), state: STATES.local },
      { event: ev(2, NOW - 5000), state: STATES.waiting },
      { event: ev(3, NOW - 5000), state: STATES.waiting },
      { event: ev(4, NOW - 9000), state: STATES.pending },
      { event: ev(5, NOW), state: STATES.waiting },
    ]);
  });

  it('takes the oldest waiting events first, at most the limit', () => {
    expect(store.nextBatch(3).map((each) => each.seq)).toEqual([2, 3, 0]);
    expect(store.nextBatch().map((each) => each.seq)).toEqual([2, 3, 0, 5]);
    expect(store.nextBatch().every((each) => each.state === 'waiting')).toBe(true);
  });

  it('marks events sent or refused only from waiting', () => {
    const ids = new Map(store.page().events.map((each) => [each.seq, each.id]));
    store.markSent([ids.get(2)!, ids.get(1)!, ids.get(4)!], NOW + 1);
    store.markRefused([ids.get(3)!, ids.get(1)!]);
    const bySeq = new Map(store.page().events.map((each) => [each.seq, each]));
    expect(bySeq.get(2)).toMatchObject({ state: 'sent', sentAt: NOW + 1 });
    expect(bySeq.get(3)).toMatchObject({ state: 'refused', sentAt: null });
    // A local or pending event never becomes sent or refused.
    expect(bySeq.get(1)).toMatchObject({ state: 'local', sentAt: null });
    expect(bySeq.get(4)).toMatchObject({ state: 'pending', sentAt: null });
    // A sent event is not refused later.
    store.markRefused([ids.get(2)!]);
    expect(store.page({ state: 'sent' }).events.map((each) => each.seq)).toEqual([2]);
    expect(store.nextBatch().map((each) => each.seq)).toEqual([0, 5]);
    store.markSent([], NOW);
    expect(nonZero(store.counts())).toEqual({
      local: 1,
      pending: 1,
      sent: 1,
      refused: 1,
      waiting: 2,
    });
  });
});

describe('page', () => {
  beforeEach(() => {
    // 255 events: mac, cli and mcp in turn; every fifth is local, the rest waiting.
    store.insert(
      Array.from({ length: 255 }, (_, i) => ({
        event: ev(i, NOW - (255 - i) * 1000, {
          client: (['mac', 'cli', 'mcp'] as const)[i % 3]!,
        }),
        state: i % 5 === 0 ? STATES.local : STATES.waiting,
      })),
    );
  });

  it('pages newest first, 100 at a time, by keyset', () => {
    const first = store.page();
    expect(first.events).toHaveLength(100);
    expect(first.total).toBe(255);
    expect(first.newer).toBe(0);
    expect(first.events[0]!.seq).toBe(254);
    expect(first.events.at(-1)!.seq).toBe(155);
    const second = store.page({ before: first.events.at(-1) });
    expect(second.events.map((each) => each.seq)).toEqual(
      Array.from({ length: 100 }, (_, i) => 154 - i),
    );
    expect(second.newer).toBe(100);
    const third = store.page({ before: second.events.at(-1) });
    expect(third.events).toHaveLength(55);
    expect(third.newer).toBe(200);
    expect(store.page({ before: third.events.at(-1) }).events).toEqual([]);
  });

  it('pages back to newer events with after (Later)', () => {
    const first = store.page();
    const second = store.page({ before: first.events.at(-1) });
    const back = store.page({ after: second.events[0] });
    expect(back.events).toEqual(first.events);
    expect(back.newer).toBe(0);
    const later = store.page({ after: store.page({ before: second.events.at(-1) }).events[0] });
    expect(later).toEqual(second);
    expect(store.page({ after: first.events[0] }).events).toEqual([]);
  });

  it('breaks ties on the same time by id', () => {
    const tied = AnalyticsStore.open(':memory:');
    tied.insert(Array.from({ length: 5 }, (_, i) => ({ event: ev(i, NOW), state: STATES.local })));
    const first = tied.page({ limit: 2 });
    expect(first.events.map((each) => each.seq)).toEqual([4, 3]);
    const next = tied.page({ limit: 2, before: first.events.at(-1) });
    expect(next.events.map((each) => each.seq)).toEqual([2, 1]);
    expect(next.newer).toBe(2);
    expect(tied.page({ limit: 2, after: next.events[0] }).events).toEqual(first.events);
    tied.close();
  });

  it('filters by state and client, counting total and newer within the filter', () => {
    const local = store.page({ state: 'local' });
    expect(local.total).toBe(51);
    expect(local.events.every((each) => each.state === 'local')).toBe(true);
    expect(local.events).toHaveLength(51);
    const cli = store.page({ client: 'cli', limit: 50 });
    expect(cli.total).toBe(85);
    expect(cli.events.every((each) => each.client === 'cli')).toBe(true);
    const cliNext = store.page({ client: 'cli', limit: 50, before: cli.events.at(-1) });
    expect(cliNext.events).toHaveLength(35);
    expect(cliNext.newer).toBe(50);
    const app = store.page({ client: 'app' });
    expect(app.total).toBe(85);
    expect(app.events.every((each) => each.client === 'mac')).toBe(true);
    const both = store.page({ client: 'mcp', state: 'waiting' });
    expect(both.events.every((each) => each.client === 'mcp' && each.state === 'waiting')).toBe(
      true,
    );
    expect(both.total).toBe(both.events.length);
    expect(both.total).toBe(68);
    expect(store.page({ state: 'all', client: 'all' }).total).toBe(255);
    expect(store.total({ state: 'sent' })).toBe(0);
  });

  it('keeps the page size between 1 and 1,000', () => {
    expect(store.page({ limit: 0 }).events).toHaveLength(1);
    expect(store.page({ limit: 5000 }).events).toHaveLength(255);
  });

  it('finds an event’s place by its id', () => {
    const [newest] = store.page().events;
    expect(store.cursor(newest!.id)).toEqual({ at: newest!.at, id: newest!.id });
    expect(store.cursor(999_999)).toBeNull();
  });
});

describe('limits', () => {
  beforeEach(() => {
    // 10 days of events: 100 a day, each day's at noon and after.
    store.insert(
      Array.from({ length: 1000 }, (_, i) => ({
        event: ev(i, NOW - (9 - Math.floor(i / 100)) * DAY + (i % 100) * 1000),
        state: i % 2 ? STATES.local : STATES.waiting,
      })),
    );
  });

  it('counts what would go, by age and by cap', () => {
    // Older than 7 days: the first two days (9 and 8 days ago); 7 days ago to the ms stays.
    expect(store.outside({ 'events.days': 7, 'events.max': 800_000 }, NOW)).toBe(200);
    expect(store.outside({ 'events.days': 360, 'events.max': 600 }, NOW)).toBe(400);
    expect(store.outside({ 'events.days': 7, 'events.max': 500 }, NOW)).toBe(500);
    expect(store.outside({ 'events.days': 360, 'events.max': 800_000 }, NOW)).toBe(0);
  });

  it('prunes by age, oldest first, a batch at a time, yielding after every step', async () => {
    const steps: PruneStep[] = [];
    const removed = await store.prune({ 'events.days': 7, 'events.max': 800_000 }, NOW, {
      batch: 30,
      between: (step) => {
        steps.push(step);
      },
    });
    expect(removed).toBe(200);
    // Seven DELETEs (six of 30 and one of 20), a checkpoint after every fourth and one after the
    // last, then the vacuum a slice at a time, each slice checkpointed.
    const deletes = (n: number) => Array.from({ length: n }, () => 'delete');
    expect(steps.slice(0, 9)).toEqual([...deletes(4), 'checkpoint', ...deletes(3), 'checkpoint']);
    expect(new Set(steps.slice(9))).toEqual(new Set(['vacuum', 'checkpoint']));
    expect(steps.filter((step) => step === 'delete')).toHaveLength(7);
    expect(store.size()).toBe(800);
    expect(store.page({ limit: 1000 }).events.at(-1)!.seq).toBe(200);
  });

  it('prunes by cap, keeping the newest', async () => {
    const removed = await store.prune({ 'events.days': 360, 'events.max': 500 }, NOW, {
      batch: 64,
    });
    expect(removed).toBe(500);
    expect(store.size()).toBe(500);
    const kept = store.page({ limit: 1000 }).events.map((each) => each.seq);
    expect(Math.min(...kept)).toBe(500);
    expect(nonZero(store.counts())).toEqual(rowCounts(store));
  });

  it('prunes by age, then by cap', () => {
    expect(store.pruneNow({ 'events.days': 7, 'events.max': 500 }, NOW, 128)).toBe(500);
    expect(store.size()).toBe(500);
    expect(store.outside({ 'events.days': 7, 'events.max': 500 }, NOW)).toBe(0);
    expect(store.pruneNow({ 'events.days': 7, 'events.max': 500 }, NOW)).toBe(0);
  });

  it('waits for an async between', async () => {
    const order: string[] = [];
    await store.prune({ 'events.days': 1, 'events.max': 800_000 }, NOW, {
      batch: 400,
      between: async (step) => {
        order.push(step);
        await new Promise((resolve) => setTimeout(resolve, 1));
        order.push('resumed');
      },
    });
    expect(order.slice(0, 6)).toEqual([
      'delete',
      'resumed',
      'delete',
      'resumed',
      'checkpoint',
      'resumed',
    ]);
    expect(order.filter((_, i) => i % 2 === 1).every((each) => each === 'resumed')).toBe(true);
    expect(store.size()).toBe(200);
  });
});

describe('meta', () => {
  it('keeps values by key', () => {
    expect(store.meta('schema')).toBe('1');
    expect(store.meta('lastBatch')).toBeNull();
    store.setMeta('lastBatch', '{"v":1}');
    store.setMeta('lastBatch', '{"v":1,"events":[]}');
    expect(store.meta('lastBatch')).toBe('{"v":1,"events":[]}');
  });
});

describe('a database file', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'penmoss-analytics-'));
    path = join(dir, 'analytics', 'events.db');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('is made with its folder, in WAL with incremental vacuum', () => {
    const file = AnalyticsStore.open(path);
    file.insert(many(3, STATES.pending));
    const raw = new DatabaseSync(path);
    expect(raw.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
    expect(raw.prepare('PRAGMA auto_vacuum').get()).toEqual({ auto_vacuum: 2 });
    raw.close();
    file.close();
  });

  it('keeps what it holds when it is opened again', () => {
    const first = AnalyticsStore.open(path);
    first.insert(many(5, STATES.waiting));
    first.setMeta('lastBatchAt', '1');
    first.close();
    const again = AnalyticsStore.open(path);
    expect(again.counts().waiting).toBe(5);
    expect(again.meta('lastBatchAt')).toBe('1');
    again.close();
  });

  it('is shared by two connections, both writing (the app and the CLI)', () => {
    const app = AnalyticsStore.open(path);
    const cli = AnalyticsStore.open(path);
    app.insert(many(50, STATES.pending, NOW, { session: '1111111111111111' }));
    cli.insert(many(30, STATES.local, NOW, { client: 'cli', session: '2222222222222222' }));
    app.insert(many(20, STATES.pending, NOW + 60_000, { session: '1111111111111111' }, 50));
    expect(cli.counts()).toEqual({ pending: 70, local: 30, waiting: 0, sent: 0, refused: 0 });
    expect(app.page({ client: 'cli' }).total).toBe(30);
    // The app's answer reaches the CLI's pending events too.
    expect(app.applyAnswer('yes')).toBe(70);
    expect(cli.nextBatch(200)).toHaveLength(70);
    cli.pruneNow({ 'events.days': 7, 'events.max': 500 }, NOW);
    expect(app.size()).toBe(100);
    app.close();
    cli.close();
  });

  it('gives back the pages a large prune frees', () => {
    const file = AnalyticsStore.open(path);
    file.insert(many(20_000, STATES.local));
    const raw = new DatabaseSync(path);
    const pages = () =>
      (raw.prepare('PRAGMA page_count').get() as { page_count: number }).page_count;
    const before = pages();
    file.pruneNow({ 'events.days': 360, 'events.max': 500 }, NOW);
    expect(file.size()).toBe(500);
    raw.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    expect(pages()).toBeLessThan(before / 4);
    expect(
      (raw.prepare('PRAGMA freelist_count').get() as { freelist_count: number }).freelist_count,
    ).toBe(0);
    raw.close();
    file.close();
  });

  it('reads an event with broken props as having none', () => {
    const file = AnalyticsStore.open(path);
    file.insert(many(1, STATES.local));
    const raw = new DatabaseSync(path);
    raw.exec("UPDATE events SET props = '{broken'");
    raw.close();
    expect(file.page().events[0]!.props).toEqual({});
    file.close();
  });

  it('does not loop when the kept counts disagree with the rows', () => {
    const file = AnalyticsStore.open(path);
    file.insert(many(600, STATES.local));
    const raw = new DatabaseSync(path);
    raw.exec('UPDATE state_counts SET n = n + 1000 WHERE state = 1');
    raw.close();
    expect(file.pruneNow({ 'events.days': 360, 'events.max': 500 }, NOW)).toBe(600);
    file.close();
  });
});
