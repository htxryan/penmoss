/**
 * The nightly cron (PEN-137, AC19), on a fake clock (the controller's scheduled time): it rolls
 * the days before today into daily_counts and daily_installs, rebuilds them the same each time,
 * deletes events past 13 months and rollups past 25 months in batches, and fills the catalogue.
 */
import { CATALOGUE, type AnalyticsEvent } from '@penmoss/core/analytics';
import { createScheduledController } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import worker from '../src/index';
import { insertEvent } from '../src/ingest';
import {
  MAX_DETAIL_ROUNDS,
  NOTHING_LEFT_LOG,
  nightly,
  PRUNE_BATCH,
  PRUNE_TO_BYTES,
} from '../src/nightly';

/** 02:15 UTC on 20 November 2026: "yesterday" is the 19th. */
const CRON_AT = Date.UTC(2026, 10, 20, 2, 15);
const at = (day: string, hour = 10) => Date.parse(`${day}T${String(hour).padStart(2, '0')}:00:00Z`);

const INSTALL_A = 'a'.repeat(32);
const INSTALL_B = 'b'.repeat(32);

function event(day: string, seq: number, overrides: Partial<AnalyticsEvent> = {}): AnalyticsEvent {
  return {
    session: `${day.replaceAll('-', '')}00000000`.slice(0, 16),
    seq,
    at: at(day) + seq * 1000,
    client: 'mac',
    actor: 'person',
    version: '1.4.0',
    channel: 'stable',
    os: 'macos',
    osVersion: '15.6',
    sizeClass: 'expanded',
    kind: 'command',
    name: 'app.palette',
    props: { source: 'key', keys: 'Mod+K' },
    ...overrides,
  };
}

async function insert(install: string, events: AnalyticsEvent[]) {
  await env.DB.batch(events.map((item) => insertEvent(env.DB, install, item, CRON_AT)));
}

async function runCron(scheduledTime = CRON_AT) {
  const controller = createScheduledController({ scheduledTime, cron: '15 2 * * *' });
  await worker.scheduled(controller, env);
}

const all = async (sql: string, ...params: unknown[]) =>
  (
    await env.DB.prepare(sql)
      .bind(...params)
      .all<Record<string, unknown>>()
  ).results;

beforeEach(async () => {
  await env.DB.batch(
    ['events', 'daily_counts', 'daily_installs', 'catalogue', 'ingest_daily'].map((table) =>
      env.DB.prepare(`DELETE FROM ${table}`),
    ),
  );
});

describe('the nightly rollup', () => {
  beforeEach(async () => {
    await insert(INSTALL_A, [
      event('2026-11-19', 0),
      event('2026-11-19', 1, { props: { source: 'palette' } }),
      event('2026-11-19', 2, { props: { source: 'palette' } }),
      event('2026-11-19', 3, { kind: 'screen', name: 'home', props: {} }),
      // A newer version later that day: the install's row carries it.
      event('2026-11-19', 4, { version: '1.4.1', props: { source: 'menu' } }),
    ]);
    await insert(INSTALL_B, [
      event('2026-11-19', 0, { client: 'android', os: 'android', osVersion: '16' }),
      event('2026-11-18', 0, {
        actor: 'agent',
        client: 'mcp',
        kind: 'tool',
        name: 'read_note',
        props: { agentClient: 'codex', result: 'ok' },
      }),
      // Today's events wait for tomorrow night.
      event('2026-11-20', 0),
    ]);
  });

  it('rolls yesterday into daily_counts, with a command source and none for other kinds', async () => {
    await runCron();
    const counts = await all(
      "SELECT client, actor, version, kind, name, source, events FROM daily_counts WHERE day = '2026-11-19' ORDER BY client, version, kind, source",
    );
    expect(counts).toEqual([
      {
        client: 'android',
        actor: 'person',
        version: '1.4.0',
        kind: 'command',
        name: 'app.palette',
        source: 'key',
        events: 1,
      },
      {
        client: 'mac',
        actor: 'person',
        version: '1.4.0',
        kind: 'command',
        name: 'app.palette',
        source: 'key',
        events: 1,
      },
      {
        client: 'mac',
        actor: 'person',
        version: '1.4.0',
        kind: 'command',
        name: 'app.palette',
        source: 'palette',
        events: 2,
      },
      {
        client: 'mac',
        actor: 'person',
        version: '1.4.0',
        kind: 'screen',
        name: 'home',
        source: '',
        events: 1,
      },
      {
        client: 'mac',
        actor: 'person',
        version: '1.4.1',
        kind: 'command',
        name: 'app.palette',
        source: 'menu',
        events: 1,
      },
    ]);
    expect(await all("SELECT * FROM daily_counts WHERE day = '2026-11-20'")).toEqual([]);
  });

  it('rolls each install once per day, client and actor, as its latest event that day', async () => {
    await runCron();
    const installs = await all(
      'SELECT day, install, client, actor, version, os, os_version FROM daily_installs ORDER BY day, install',
    );
    expect(installs).toEqual([
      {
        day: '2026-11-18',
        install: INSTALL_B,
        client: 'mcp',
        actor: 'agent',
        version: '1.4.0',
        os: 'macos',
        os_version: '15.6',
      },
      {
        day: '2026-11-19',
        install: INSTALL_A,
        client: 'mac',
        actor: 'person',
        version: '1.4.1',
        os: 'macos',
        os_version: '15.6',
      },
      {
        day: '2026-11-19',
        install: INSTALL_B,
        client: 'android',
        actor: 'person',
        version: '1.4.0',
        os: 'android',
        os_version: '16',
      },
    ]);
  });

  it('gives the same rollups when it runs again, and takes in events that came late', async () => {
    await runCron();
    const first = await all('SELECT * FROM daily_counts ORDER BY 1, 2, 3, 4, 5, 6, 7, 8');
    await runCron();
    expect(await all('SELECT * FROM daily_counts ORDER BY 1, 2, 3, 4, 5, 6, 7, 8')).toEqual(first);
    // A phone that was offline sends the 17th's events on the 20th.
    await insert(INSTALL_B, [
      event('2026-11-17', 0, { client: 'android', os: 'android', osVersion: '16' }),
    ]);
    await runCron();
    expect(await all("SELECT client, events FROM daily_counts WHERE day = '2026-11-17'")).toEqual([
      { client: 'android', events: 1 },
    ]);
  });
});

describe('pruning', () => {
  it('deletes events older than 13 months, in batches, and keeps the rest', async () => {
    const old = PRUNE_BATCH * 2 + 17;
    // Seeded in SQL: more than two batches' worth of events from 2025-10-01.
    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
       INSERT INTO events (received_at, day, install, session, seq, at, client, actor, version,
         channel, os, os_version, kind, name)
       SELECT 0, '2025-10-01', ?2, '0000000000000000', i, 0, 'mac', 'person', '1.0.0', 'stable',
         'macos', '15.0', 'app', 'launch' FROM n`,
    )
      .bind(old, INSTALL_A)
      .run();
    // 13 months before 2026-11-20 is 2025-10-20: the 19th goes, the 20th stays.
    await insert(INSTALL_B, [
      event('2025-10-19', 0),
      event('2025-10-20', 0),
      event('2026-11-19', 0),
    ]);
    await runCron();
    expect(await all('SELECT day FROM events ORDER BY day')).toEqual([
      { day: '2025-10-20' },
      { day: '2026-11-19' },
    ]);
  });

  it('deletes rollups and ingest counts older than 25 months', async () => {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO daily_counts VALUES ('2024-10-19', 'mac', 'person', '1.0.0', 'stable', 'app', 'launch', '', 3),
           ('2024-10-20', 'mac', 'person', '1.0.0', 'stable', 'app', 'launch', '', 4)`,
      ),
      env.DB.prepare(
        `INSERT INTO daily_installs (day, install, client, actor, version, channel, os, os_version)
         VALUES ('2024-10-19', ?1, 'mac', 'person', '1.0.0', 'stable', 'macos', '15.0'),
           ('2024-10-20', ?1, 'mac', 'person', '1.0.0', 'stable', 'macos', '15.0')`,
      ).bind(INSTALL_A),
      env.DB.prepare(
        "INSERT INTO ingest_daily (day, batches) VALUES ('2024-10-19', 1), ('2024-10-20', 1)",
      ),
    ]);
    await runCron();
    for (const table of ['daily_counts', 'daily_installs', 'ingest_daily']) {
      expect(await all(`SELECT day FROM ${table}`), table).toEqual([{ day: '2024-10-20' }]);
    }
  });
});

/** `count` events of `kind` on `day`, seeded in SQL, `name` and `seqFrom` keeping them apart. */
async function seed(day: string, count: number, kind: string, name: string, seqFrom = 0) {
  await env.DB.prepare(
    `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
     INSERT INTO events (received_at, day, install, session, seq, at, client, actor, version,
       channel, os, os_version, kind, name)
     SELECT 0, ?2, ?3, '1111111111111111', ?4 + i, ?5 + i, 'mac', 'person', '1.4.0', 'stable',
       'macos', '15.6', ?6, ?7 FROM n`,
  )
    .bind(count, day, INSTALL_A, seqFrom, at(day), kind, name)
    .run();
}

const countOf = async (where = '1 = 1') =>
  ((await all(`SELECT COUNT(*) AS n FROM events WHERE ${where}`))[0] as { n: number }).n;

/**
 * D1 as the night sees it, its size said to be `size` bytes on every result, recording each
 * statement it prepares, so a test can count the reads of the size and the row count.
 */
function sizedDb(size: number) {
  const prepared: string[] = [];
  const sized = <T extends { meta?: object }>(result: T): T => ({
    ...result,
    meta: { ...result.meta, size_after: size },
  });
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, key) {
        if (key === 'bind') return (...args: unknown[]) => wrap(target.bind(...args));
        if (key === 'run' || key === 'all') {
          return async () => sized(await (target[key] as () => Promise<D1Result>).call(target));
        }
        const value = Reflect.get(target, key, target) as unknown;
        return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
      },
    });
  const db = {
    prepare: (sql: string) => {
      prepared.push(sql);
      return wrap(env.DB.prepare(sql));
    },
    batch: async (statements: D1PreparedStatement[]) =>
      (await env.DB.batch(statements)).map((result) => sized(result)),
  } as unknown as D1Database;
  return { db, prepared };
}

describe('session detail (PEN-177, O8)', () => {
  const GB = 1_000_000_000;

  it('keeps note, input and tree events 90 days, other kinds 13 months, and rolls them all up', async () => {
    // 90 days before 2026-11-20 is 2026-08-22: the 21st goes, the 22nd stays.
    for (const [index, kind, name] of [
      [0, 'note', 'typing'],
      [1, 'input', 'palette'],
      [2, 'tree', 'expand'],
    ] as const) {
      await seed('2026-08-21', 3, kind, name, index * 10); // 91 days old
      await seed('2026-08-23', 2, kind, name, 100 + index * 10); // 89 days old
    }
    await seed('2026-08-21', 4, 'command', 'app.palette', 200);
    // Yesterday's, which the rollup counts.
    await insert(INSTALL_B, [
      event('2026-11-19', 0, { kind: 'note', name: 'cursor', props: { block: 3 } }),
      event('2026-11-19', 1, {
        kind: 'input',
        name: 'search',
        props: { field: 'query', chars: 4 },
      }),
    ]);
    // A rollup of a day whose events are pruned stays (rollups keep 25 months).
    await env.DB.prepare(
      `INSERT INTO daily_counts VALUES ('2026-08-21', 'mac', 'person', '1.4.0', 'stable', 'note', 'typing', '', 3)`,
    ).run();
    await runCron();
    expect(await countOf(`day = '2026-08-21' AND kind IN ('note', 'input', 'tree')`)).toBe(0);
    expect(await countOf(`day = '2026-08-23' AND kind IN ('note', 'input', 'tree')`)).toBe(6);
    expect(await countOf(`day = '2026-08-21' AND kind = 'command'`)).toBe(4);
    expect(
      await all(
        "SELECT kind, name, events FROM daily_counts WHERE day = '2026-11-19' ORDER BY kind",
      ),
    ).toEqual([
      { kind: 'input', name: 'search', events: 1 },
      { kind: 'note', name: 'cursor', events: 1 },
    ]);
    expect(await all("SELECT events FROM daily_counts WHERE day = '2026-08-21'")).toEqual([
      { events: 3 },
    ]);
  });

  it('past 8 GB, deletes the computed number of the oldest session detail once, and nothing else', async () => {
    await seed('2026-10-01', 600, 'note', 'typing');
    await seed('2026-10-02', 600, 'tree', 'collapse', 1000);
    await seed('2026-11-01', 800, 'note', 'cursor', 2000);
    await seed('2026-09-01', 500, 'command', 'app.palette', 3000);
    const total = 2500;
    const size = 9 * GB;
    // (9 GB − 7.5 GB) ÷ (9 GB ÷ 2,500 rows) = 416.67, so 417 rows go.
    const expected = Math.ceil((size - PRUNE_TO_BYTES) / (size / total));
    expect(expected).toBe(417);
    const lines: string[] = [];
    const { db, prepared } = sizedDb(size);
    const report = await nightly(db, CRON_AT, (line) => lines.push(line));
    expect(report.sizeBytes).toBe(size);
    expect(report.prunedForSize).toBe(expected);
    expect(await countOf()).toBe(total - expected);
    // The oldest went: all from the 1st of October's 600, none later.
    expect(await countOf(`day = '2026-10-01'`)).toBe(600 - expected);
    expect(await countOf(`day = '2026-10-02'`)).toBe(600);
    expect(await countOf(`day = '2026-11-01'`)).toBe(800);
    expect(await countOf(`kind = 'command'`)).toBe(500);
    // Worked out once: one row count, never the size again in a loop.
    expect(
      prepared.filter((sql) => /^SELECT COUNT\(\*\) AS n FROM events$/.test(sql)),
    ).toHaveLength(1);
    expect(lines).toEqual([]);
  });

  it('logs when no session detail is left to prune, and prunes no other kind early', async () => {
    await seed('2026-10-01', 50, 'note', 'typing');
    await seed('2026-09-01', 500, 'command', 'app.palette', 1000);
    const lines: string[] = [];
    const { db } = sizedDb(9.5 * GB);
    const report = await nightly(db, CRON_AT, (line) => lines.push(line));
    expect(report.prunedForSize).toBe(50);
    expect(await countOf(`kind = 'command'`)).toBe(500);
    expect(lines).toEqual([NOTHING_LEFT_LOG]);
  });

  it('under 8 GB prunes only by age', async () => {
    await seed('2026-10-01', 50, 'note', 'typing');
    const lines: string[] = [];
    const { db, prepared } = sizedDb(7.9 * GB);
    const report = await nightly(db, CRON_AT, (line) => lines.push(line));
    expect(report.prunedForSize).toBe(0);
    expect(await countOf()).toBe(50);
    expect(
      prepared.filter((sql) => /^SELECT COUNT\(\*\) AS n FROM events$/.test(sql)),
    ).toHaveLength(0);
    expect(lines).toEqual([]);
  });

  it('has its own budget of 400 rounds of 5,000 a night', () => {
    expect(MAX_DETAIL_ROUNDS * PRUNE_BATCH).toBe(2_000_000);
  });
});

describe('the catalogue', () => {
  it('holds every catalogued name after the cron, and only grows', async () => {
    await env.DB.prepare("INSERT INTO catalogue VALUES ('command', 'old.retired')").run();
    await runCron();
    const total = new Set(
      Object.entries(CATALOGUE).flatMap(([kind, names]) => names.map((name) => `${kind}:${name}`)),
    ).size;
    const [{ n }] = (await all('SELECT COUNT(*) AS n FROM catalogue')) as [{ n: number }];
    expect(n).toBe(total + 1);
    expect(
      await all("SELECT * FROM catalogue WHERE kind = 'tool' AND name = 'search_notes'"),
    ).toHaveLength(1);
  });
});
