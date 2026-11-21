// Wall-clock budgets (A1244) for the Mac app's usage record at its largest limits (PEN-137,
// AC35; PEN-177 raised it): `task budgets` runs it, never `task check`. 2,000,000 events in a real
// events.db, session detail among them (about 2% note opens of about 4 KB, the rest mostly typing
// bursts and cursor moves), served
// by the real worker thread (analytics-worker.ts, bundled here as build.mjs bundles it), with
// main's side measured as the app's main thread sees it. Ceilings get 2× slack on CI.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { STATES, type AnalyticsEvent, type StateCode } from '@penmoss/core/analytics';
import { AnalyticsStore, writeConsentFile } from '@penmoss/core/analytics/node';
import { newConsentFile } from '@penmoss/core/analytics';
import { Analytics, macFields } from '../../src/analytics';
import { WorkerStore } from '../../src/analytics-store';

const SLACK = process.env['CI'] ? 2 : 1;
const EVENTS = 2_000_000;
const NOW = Date.now();
const DAY = 86_400_000;
const DESKTOP = fileURLToPath(new URL('../..', import.meta.url));

let dir: string;
let worker: Worker;
let client: WorkerStore;

/** A note's shape of about 4 KB: 600 tokens. */
const SHAPE = Array.from({ length: 600 }, (_, k) =>
  k % 10 === 0 ? `h2:${k % 60}` : `p:${100 + k}`,
);
const NOTE = '0123456789abcdef';

/** A Mac event: 2% note opens, then typing, cursor moves, an input and commands. */
function detail(seq: number): Pick<AnalyticsEvent, 'kind' | 'name' | 'props'> {
  const slot = seq % 50;
  if (slot === 0) {
    return {
      kind: 'note',
      name: 'open',
      props: { note: NOTE, how: 'open', titleChars: 24, shape: SHAPE },
    };
  }
  if (slot < 30) {
    return {
      kind: 'note',
      name: 'typing',
      props: { note: NOTE, block: slot, typed: 14, deleted: 2 },
    };
  }
  if (slot < 42) return { kind: 'note', name: 'cursor', props: { note: NOTE, block: slot } };
  if (slot < 45) return { kind: 'input', name: 'palette', props: { field: 'query', chars: slot } };
  return { kind: 'command', name: 'note.new', props: { source: 'key', keys: 'Mod+N' } };
}

function event(seq: number, at: number): AnalyticsEvent {
  const cli = seq % 3 === 0;
  return {
    session: 'a1b2c3d4e5f60718',
    seq,
    at,
    client: cli ? 'cli' : 'mac',
    actor: 'person',
    version: '0.2.2',
    channel: 'stable',
    os: 'macos',
    osVersion: '15.1',
    ...(cli
      ? { kind: 'command', name: 'note.new', props: { source: 'key', keys: 'Mod+N' } }
      : detail(seq)),
  };
}

const p95 = (samples: number[]) =>
  [...samples].sort((a, b) => a - b)[Math.floor(samples.length * 0.95)]!;

async function timed<T>(work: () => Promise<T>): Promise<[T, number]> {
  const started = performance.now();
  const value = await work();
  return [value, performance.now() - started];
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'penmoss-analytics-budget-'));
  const path = join(dir, 'analytics', 'events.db');
  // 2,000,000 events over 300 days, the newest 1,000 waiting to be sent.
  const seed = AnalyticsStore.open(path);
  const span = 300 * DAY;
  for (let start = 0; start < EVENTS; start += 20_000) {
    const rows: Array<{ event: AnalyticsEvent; state: StateCode }> = [];
    for (let seq = start; seq < start + 20_000; seq++) {
      rows.push({
        event: event(seq, NOW - span + Math.floor((seq / EVENTS) * span)),
        state: seq >= EVENTS - 1000 ? STATES.waiting : STATES.local,
      });
    }
    seed.insert(rows);
  }
  seed.close();
  const bundle = join(dir, 'analytics-worker.cjs');
  await build({
    absWorkingDir: DESKTOP,
    entryPoints: ['src/analytics-worker.ts'],
    outfile: bundle,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    logLevel: 'warning',
  });
  worker = new Worker(bundle, {
    workerData: { path, limits: { 'events.days': 360, 'events.max': 2_000_000 } },
  });
  client = new WorkerStore(worker);
}, 300_000);

afterAll(async () => {
  await client?.close();
  await worker?.terminate();
  rmSync(dir, { recursive: true, force: true });
});

describe('the usage record at 2,000,000 events (AC35)', () => {
  it('adds under 1 ms to main’s thread for each event recorded (p95)', async () => {
    const home = join(dir, 'home');
    writeConsentFile({ ...newConsentFile(), consent: 'no' }, join(home, 'analytics.json'));
    const analytics = new Analytics({
      consentPath: join(home, 'analytics.json'),
      store: client,
      env: {},
      base: 'http://127.0.0.1:9',
      fields: macFields({
        version: '0.2.2',
        packaged: true,
        platform: 'darwin',
        systemVersion: '15.1',
      }),
      hasNotebook: () => Promise.resolve(true),
      logs: {
        bytes: () => Promise.resolve(0),
        preview: () => Promise.resolve(0),
        apply: () => Promise.resolve(),
      },
    });
    const samples: number[] = [];
    for (let i = 0; i < 2000; i++) {
      const started = performance.now();
      // Session detail too: a typing burst and, now and then, a note's open, each with its refs.
      analytics.recordPage([
        i % 50 === 0
          ? {
              kind: 'note',
              name: 'open',
              props: { how: 'open', titleChars: 24, shape: SHAPE },
              refs: { note: `note-${i}`, folder: 'folder-1' },
              at: Date.now(),
            }
          : i % 2 === 0
            ? {
                kind: 'note',
                name: 'typing',
                props: { block: 3, typed: 12, deleted: 0 },
                refs: { note: `note-${i}` },
                at: Date.now(),
              }
            : {
                kind: 'command',
                name: 'note.new',
                props: { source: 'key', keys: 'Mod+N' },
                at: Date.now(),
              },
      ]);
      samples.push(performance.now() - started);
    }
    expect(p95(samples)).toBeLessThan(1 * SLACK);
    await client.counts();
  });

  it('counts by state in under 10 ms, and the next batch in under 20 ms', async () => {
    await client.counts();
    const [counts, counted] = await timed(() => client.counts());
    expect(counts.local + counts.waiting).toBeGreaterThanOrEqual(EVENTS);
    expect(counted).toBeLessThan(10 * SLACK);
    const [batch, batched] = await timed(() => client.nextBatch(200));
    expect(batch).toHaveLength(200);
    expect(batched).toBeLessThan(20 * SLACK);
  });

  it('pages the viewer: the first page in under 200 ms, the next in under 100 ms', async () => {
    const [first, firstTook] = await timed(() => client.page({ limit: 100 }));
    expect(first.events).toHaveLength(100);
    expect(firstTook).toBeLessThan(200 * SLACK);
    const last = first.events.at(-1)!;
    const [, nextTook] = await timed(() =>
      client.page({ limit: 100, before: { at: last.at, id: last.id } }),
    );
    expect(nextTook).toBeLessThan(100 * SLACK);
    const [filtered, filteredTook] = await timed(() =>
      client.page({ limit: 100, state: 'waiting', client: 'app' }),
    );
    expect(filtered.events.length).toBeGreaterThan(0);
    expect(filteredTook).toBeLessThan(200 * SLACK);
  });

  it('counts what a lower limit would remove in under 100 ms', async () => {
    const [outside, took] = await timed(() =>
      client.outside({ 'events.days': 7, 'events.max': 5000 }, NOW),
    );
    expect(outside).toBeGreaterThan(EVENTS - 10_000);
    expect(took).toBeLessThan(100 * SLACK);
  });

  it('prunes 2,000,000 to 5,000 in under 30 s, main’s thread free within 16 ms (p99)', async () => {
    let last = performance.now();
    const gaps: number[] = [];
    const tick = setInterval(() => {
      const now = performance.now();
      gaps.push(now - last);
      last = now;
    }, 1);
    const [removed, took] = await timed(() =>
      client.prune({ 'events.days': 360, 'events.max': 5000 }, NOW),
    );
    clearInterval(tick);
    expect(removed).toBeGreaterThanOrEqual(EVENTS - 5000);
    expect(took).toBeLessThan(30_000 * SLACK);
    // Percentiles of every tick, never the slowest one (A1638, A1651): a shared runner can pause
    // any single tick.
    const sorted = [...gaps].sort((a, b) => a - b);
    const p99 = sorted[Math.max(0, Math.ceil(sorted.length * 0.99) - 1)]!;
    process.stderr.write(
      `prune on main: ${gaps.length} ticks, p95 ${p95(gaps).toFixed(1)} ms, p99 ${p99.toFixed(1)} ms, max ${sorted.at(-1)!.toFixed(1)} ms\n`,
    );
    expect(p99).toBeLessThan(16 * SLACK);
    const counts = await client.counts();
    expect(Object.values(counts).reduce((sum, n) => sum + n, 0)).toBe(5000);
  }, 120_000);
});
