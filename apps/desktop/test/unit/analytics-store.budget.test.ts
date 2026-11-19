// Wall-clock budgets (A1244) for the Mac app's usage record at its largest limits (PEN-137,
// AC35): `task budgets` runs it, never `task check`. 800,000 events in a real events.db, served
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
const EVENTS = 800_000;
const NOW = Date.now();
const DAY = 86_400_000;
const DESKTOP = fileURLToPath(new URL('../..', import.meta.url));

let dir: string;
let worker: Worker;
let client: WorkerStore;

function event(seq: number, at: number): AnalyticsEvent {
  return {
    session: 'a1b2c3d4e5f60718',
    seq,
    at,
    client: seq % 3 === 0 ? 'cli' : 'mac',
    actor: 'person',
    version: '0.2.2',
    channel: 'stable',
    os: 'macos',
    osVersion: '15.1',
    kind: 'command',
    name: 'note.new',
    props: { source: 'key', keys: 'Mod+N' },
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
  // 800,000 events over 300 days, the newest 1,000 waiting to be sent.
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
    workerData: { path, limits: { 'events.days': 360, 'events.max': 800_000 } },
  });
  client = new WorkerStore(worker);
}, 300_000);

afterAll(async () => {
  await client?.close();
  await worker?.terminate();
  rmSync(dir, { recursive: true, force: true });
});

describe('the usage record at 800,000 events (AC35)', () => {
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
      analytics.recordPage([
        {
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

  it('prunes 800,000 to 5,000 in under 30 s, never holding main’s thread over 16 ms', async () => {
    let last = performance.now();
    let longest = 0;
    const tick = setInterval(() => {
      const now = performance.now();
      longest = Math.max(longest, now - last);
      last = now;
    }, 1);
    const [removed, took] = await timed(() =>
      client.prune({ 'events.days': 360, 'events.max': 5000 }, NOW),
    );
    clearInterval(tick);
    expect(removed).toBeGreaterThanOrEqual(EVENTS - 5000);
    expect(took).toBeLessThan(30_000 * SLACK);
    expect(longest).toBeLessThan(16 * SLACK);
    const counts = await client.counts();
    expect(Object.values(counts).reduce((sum, n) => sum + n, 0)).toBe(5000);
  }, 120_000);
});
