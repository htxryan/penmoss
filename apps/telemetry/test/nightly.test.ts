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
import { PRUNE_BATCH } from '../src/nightly';

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
