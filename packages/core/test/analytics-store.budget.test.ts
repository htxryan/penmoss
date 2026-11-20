// A wall-clock budget (A1244): `task budgets` runs it, never `task check`. The local usage
// record at its largest limit (PEN-137, AC35, "Staying fast at the maximums"): 800,000 events in
// a database file, as the Mac keeps it. What the store does is unit tested in
// analytics-store.test.ts; here only how long it takes. The budgets are the plan's ceilings,
// with 2× slack on CI's slower runners.
import { closeSync, fsyncSync, mkdtempSync, openSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { STATES, type AnalyticsEvent, type StateCode } from '../src/analytics/events';
import { AnalyticsStore, STEP_MS, type PruneStep } from '../src/analytics/node/store';

const ON_CI = Boolean(process.env['CI']);
const SLACK = ON_CI ? 2 : 1;
const EVENTS = 800_000;
const DAY = 86_400_000;
const NOW = Date.parse('2026-11-19T12:00:00.000Z');
/** The record spans 360 days, the longest Keep Events For. */
const SPAN = 360 * DAY;

const CLIENTS = ['mac', 'mac', 'mac', 'cli', 'mcp'] as const;
const STATE_MIX: readonly StateCode[] = [
  STATES.sent,
  STATES.sent,
  STATES.local,
  STATES.waiting,
  STATES.refused,
  STATES.pending,
];

function event(i: number): AnalyticsEvent {
  const client = CLIENTS[i % CLIENTS.length]!;
  return {
    session: (Math.floor(i / 1000) + 1).toString(16).padStart(16, '0'),
    seq: i % 1000,
    at: NOW - SPAN + Math.floor((i * SPAN) / EVENTS),
    client,
    actor: client === 'mcp' ? 'agent' : 'person',
    version: '1.4.0',
    channel: 'stable',
    os: 'macos',
    osVersion: '26.1',
    ...(client === 'mac' ? { sizeClass: 'expanded' as const } : {}),
    kind: client === 'mac' ? 'command' : client === 'cli' ? 'cli' : 'tool',
    name: client === 'mac' ? 'note.new' : client === 'cli' ? 'search' : 'search_notes',
    props: client === 'mac' ? { source: 'key', keys: 'Mod+N', ran: true } : { took: '<1s' },
  };
}

/** The time `work` takes, in ms. */
function timed<T>(work: () => T): { result: T; ms: number } {
  const started = performance.now();
  const result = work();
  return { result, ms: performance.now() - started };
}

/** The fastest of `runs` runs after one to warm up, so one stall on a busy Mac does not fail it. */
function best(runs: number, work: () => unknown): number {
  work();
  return Math.min(...Array.from({ length: runs }, () => timed(work).ms));
}

let dir: string;
let path: string;
let store: AnalyticsStore;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'penmoss-analytics-budget-'));
  path = join(dir, 'analytics', 'events.db');
  const seeding = AnalyticsStore.open(path);
  const CHUNK = 50_000;
  for (let start = 0; start < EVENTS; start += CHUNK) {
    seeding.insert(
      Array.from({ length: CHUNK }, (_, k) => ({
        event: event(start + k),
        state: STATE_MIX[(start + k) % STATE_MIX.length]!,
      })),
    );
  }
  seeding.close();
  // The seeding wrote about 300 MB a moment ago, which the kernel would otherwise still be
  // writing back while the prune runs (a record that grew over months has none waiting), so it
  // goes to the disk before anything is timed.
  const file = openSync(path, 'r+');
  fsyncSync(file);
  closeSync(file);
  store = AnalyticsStore.open(path);
}, 300_000);

afterAll(() => {
  store?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('the usage record at 800,000 events', () => {
  it('holds them all', () => {
    expect(store.size()).toBe(EVENTS);
  });

  it('shows the viewer’s first page in under 200 ms', () => {
    const first = timed(() => store.page());
    expect(first.result.events).toHaveLength(100);
    expect(first.result.total).toBe(EVENTS);
    expect(first.ms).toBeLessThan(200 * SLACK);
    for (const query of [
      { state: 'local' as const },
      { client: 'cli' as const },
      { client: 'app' as const },
    ]) {
      expect(store.page(query).events).toHaveLength(100);
      expect(
        best(3, () => store.page(query)),
        JSON.stringify(query),
      ).toBeLessThan(200 * SLACK);
    }
  });

  it('shows the next page, and the one before, in under 100 ms', () => {
    const first = store.page();
    const middle = store.page({ before: { at: NOW - SPAN / 2, id: EVENTS / 2 } });
    expect(best(3, () => store.page({ before: first.events.at(-1) }))).toBeLessThan(100 * SLACK);
    expect(best(3, () => store.page({ before: middle.events.at(-1) }))).toBeLessThan(100 * SLACK);
    expect(best(3, () => store.page({ after: middle.events[0] }))).toBeLessThan(100 * SLACK);
    const state = store.page({ state: 'waiting' });
    expect(
      best(3, () => store.page({ state: 'waiting', before: state.events.at(-1) })),
    ).toBeLessThan(100 * SLACK);
  });

  it('counts by state in under 10 ms', () => {
    expect(best(5, () => store.counts())).toBeLessThan(10 * SLACK);
    let sent = 0;
    for (let i = 0; i < EVENTS; i++) if (STATE_MIX[i % STATE_MIX.length] === STATES.sent) sent++;
    expect(store.counts().sent).toBe(sent);
  });

  it('takes the next batch to send in under 20 ms', () => {
    const batch = timed(() => store.nextBatch(200));
    expect(batch.result).toHaveLength(200);
    expect(best(3, () => store.nextBatch(200))).toBeLessThan(20 * SLACK);
  });

  it('counts what a lower limit would remove in under 100 ms', () => {
    const limits = { 'events.days': 7, 'events.max': 5000 };
    const outside = timed(() => store.outside(limits, NOW));
    expect(outside.result).toBe(EVENTS - 5000);
    expect(best(3, () => store.outside(limits, NOW))).toBeLessThan(100 * SLACK);
  });

  it('prunes 800,000 to 5,000 in under 30 s, every delete, checkpoint and vacuum step short', async () => {
    const steps: Array<{ step: PruneStep; ms: number; rows: number }> = [];
    let last = performance.now();
    const started = last;
    const removed = await store.prune({ 'events.days': 360, 'events.max': 5000 }, NOW, {
      between: (step, done) => {
        const now = performance.now();
        steps.push({ step, ms: now - last, rows: done.rows ?? 0 });
        last = now;
      },
    });
    const total = performance.now() - started;
    expect(removed).toBe(EVENTS - 5000);
    expect(store.size()).toBe(5000);
    const of = (kind: PruneStep) => steps.filter(({ step }) => step === kind).map(({ ms }) => ms);
    const deletes = steps.filter(({ step }) => step === 'delete');
    expect(deletes.reduce((sum, { rows }) => sum + rows, 0)).toBe(EVENTS - 5000);
    expect(of('checkpoint').length).toBeGreaterThanOrEqual(deletes.length);
    expect(of('vacuum').length).toBeGreaterThan(0);
    expect(total).toBeLessThan(30_000 * SLACK);
    // Each step runs alone between yields, off the main thread (the Mac's worker, or the CLI
    // between commands): DELETEs until STEP_MS is up, a checkpoint of what that step wrote, or
    // vacuum slices until STEP_MS is up. The plan's 16 ms holds for nearly all of them (p95),
    // and the slowest have a looser ceiling. Locally (`task budgets` on the Mac) that ceiling
    // holds for the slowest step of each kind; on CI it holds for the p99, since one small
    // DELETE stalled on a shared runner's disk is not the store's work, and main's thread is
    // proven free separately (apps/desktop's budget test). The log names the max either way.
    const slowest = [...steps].sort((a, b) => b.ms - a.ms).slice(0, 5);
    const named = slowest.map(({ step, ms }) => `${step} ${ms.toFixed(1)} ms`).join(', ');
    for (const kind of ['delete', 'checkpoint', 'vacuum'] as const) {
      const sorted = of(kind).sort((a, b) => a - b);
      const rank = (p: number) => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)]!;
      const [p95, p99, max] = [rank(0.95), rank(0.99), sorted.at(-1)!];
      process.stderr.write(
        `prune ${kind}: ${sorted.length} steps, p95 ${p95.toFixed(1)} ms, ` +
          `p99 ${p99.toFixed(1)} ms, max ${max.toFixed(1)} ms\n`,
      );
      expect(p95, `p95 of ${sorted.length} ${kind} steps (slowest: ${named})`).toBeLessThan(
        16 * SLACK,
      );
      if (ON_CI) {
        expect(p99, `p99 of ${sorted.length} ${kind} steps (slowest: ${named})`).toBeLessThan(
          50 * SLACK,
        );
      } else {
        expect(max, `the slowest ${kind} step (slowest: ${named})`).toBeLessThan(50);
      }
    }
    // A time-boxed step stops once STEP_MS is up: the median is its box plus one small chunk.
    for (const kind of ['delete', 'vacuum'] as const) {
      const sorted = of(kind).sort((a, b) => a - b);
      expect(sorted[Math.floor(sorted.length / 2)]!, `median ${kind} step`).toBeLessThan(
        STEP_MS * 2 * SLACK,
      );
    }
  }, 120_000);
});
