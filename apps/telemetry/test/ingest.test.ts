/**
 * The ingest Worker's routes (PEN-137, AC16, AC18): each valid event is written once, a retried
 * batch adds no rows, invalid events are dropped and counted, nothing holds an IP address, and
 * the answers are 202, 400, 404, 413, 429 and 503 as the clients expect. Forget deletes an
 * install's rows.
 */
import type { AnalyticsEvent } from '@penmoss/core/analytics';
import { env, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { handle } from '../src/ingest';

const ORIGIN = 'https://t.penmoss.test';
let counter = 0;

/** A fresh install id, so no test meets another's rate limit. */
const newInstall = () => (++counter).toString(16).padStart(4, '0').repeat(8);
/** A fresh documentation address (RFC 5737) per test, for the same reason. */
const newIp = () => `198.51.100.${++counter % 250}`;

function event(overrides: Partial<AnalyticsEvent> = {}): AnalyticsEvent {
  return {
    session: '0123456789abcdef',
    seq: 0,
    at: Date.now() - 60_000,
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

function post(path: string, body: unknown, ip = newIp(), init: RequestInit = {}) {
  return exports.default.fetch(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    ...init,
  });
}

const rows = async (sql: string, ...params: unknown[]) =>
  (
    await env.DB.prepare(sql)
      .bind(...params)
      .all<Record<string, unknown>>()
  ).results;

const eventCount = async (install: string) =>
  (await rows('SELECT COUNT(*) AS n FROM events WHERE install = ?1', install))[0]!['n'];

/** Every row of every table, as text: what a search for a leaked value looks through. */
async function everything(): Promise<string> {
  const tables = await rows(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> 'd1_migrations'",
  );
  const dump: unknown[] = [];
  for (const { name } of tables) dump.push(name, await rows(`SELECT * FROM "${String(name)}"`));
  return JSON.stringify(dump);
}

describe('POST /v1/batch', () => {
  it('writes each valid event and answers 202 with what it accepted', async () => {
    const install = newInstall();
    const events = [event(), event({ seq: 1, kind: 'screen', name: 'home', props: {} })];
    const response = await post('/v1/batch', { v: 1, install, events });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: 2, dropped: 0, refused: [] });
    const written = await rows(
      'SELECT install, session, seq, client, actor, version, channel, os, os_version, size_class, kind, name, props, day FROM events WHERE install = ?1 ORDER BY seq',
      install,
    );
    expect(written).toHaveLength(2);
    expect(written[0]).toMatchObject({
      session: '0123456789abcdef',
      seq: 0,
      client: 'mac',
      os_version: '15.6',
      size_class: 'expanded',
      kind: 'command',
      name: 'app.palette',
      props: '{"source":"key","keys":"Mod+K"}',
    });
    expect(written[0]!['day']).toBe(new Date(events[0]!.at).toISOString().slice(0, 10));
  });

  it('adds no rows when the same batch comes again', async () => {
    const install = newInstall();
    const batch = { v: 1, install, events: [event(), event({ seq: 1 }), event({ seq: 2 })] };
    expect((await post('/v1/batch', batch)).status).toBe(202);
    const before = await rows('SELECT written FROM ingest_daily');
    const again = await post('/v1/batch', batch);
    expect(again.status).toBe(202);
    expect(await again.json()).toEqual({ accepted: 3, dropped: 0, refused: [] });
    expect(await eventCount(install)).toBe(3);
    // The retry wrote nothing, so the day's written count didn't move.
    expect(await rows('SELECT written FROM ingest_daily')).toEqual(before);
  });

  it('drops and counts the events that are not catalogued or carry text, and keeps the rest', async () => {
    const install = newInstall();
    const [{ dropped: droppedBefore = 0 } = {}] = await rows('SELECT dropped FROM ingest_daily');
    const response = await post('/v1/batch', {
      v: 1,
      install,
      events: [
        event(),
        event({ seq: 1, name: 'note.My Secret Note' }),
        event({ seq: 2, props: { source: 'key', title: 'Shopping list' } }),
        event({ seq: 3, kind: 'setting', name: 'tooltip.delay', props: { value: 'a b c' } }),
      ],
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: 1, dropped: 3, refused: [1, 2, 3] });
    expect(await eventCount(install)).toBe(1);
    const [{ dropped }] = (await rows('SELECT dropped FROM ingest_daily')) as [{ dropped: number }];
    expect(dropped - Number(droppedBefore)).toBe(3);
  });

  it('takes app window and app layout with their own props, and refuses anything else (PEN-174)', async () => {
    const install = newInstall();
    const window = {
      kind: 'app' as const,
      name: 'window',
      props: { window: 'main', width: 1440, height: 900, fullScreen: false, maximised: true },
    };
    const layout = {
      kind: 'app' as const,
      name: 'layout',
      props: {
        window: 'main',
        sidebar: 'shown',
        sidebarWidth: 280,
        panel: 'open',
        fullWidth: false,
        themeMode: 'dark',
        tabs: '2–4',
      },
    };
    const response = await post('/v1/batch', {
      v: 1,
      install,
      events: [
        event({ seq: 0, ...window }),
        event({ seq: 1, ...layout }),
        event({ seq: 2, ...window, props: { ...window.props, width: 1441 } }),
        event({ seq: 3, ...window, props: { ...window.props, window: 'settings' } }),
        event({ seq: 4, ...layout, props: { ...layout.props, tabs: 3 } }),
        event({ seq: 5, kind: 'app', name: 'launch', props: { notebooks: '1', width: 1440 } }),
        event({ seq: 6, ...window, props: { ...window.props, display: 'Studio Display' } }),
        event({ seq: 7, ...window, props: { ...window.props, height: 10_010 } }),
      ],
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: 2, dropped: 6, refused: [2, 3, 4, 5, 6, 7] });
    const written = await rows(
      'SELECT kind, name, props FROM events WHERE install = ?1 ORDER BY seq',
      install,
    );
    expect(written).toEqual([
      { kind: 'app', name: 'window', props: JSON.stringify(window.props) },
      { kind: 'app', name: 'layout', props: JSON.stringify(layout.props) },
    ]);
  });

  it('takes scroll events from the apps with a position in hundredths, and refuses the rest by index (PEN-175)', async () => {
    const install = newInstall();
    // Some of these are wrong on purpose: the Worker must refuse them.
    const scroll = (seq: number, name: string, props: Record<string, unknown>, more = {}) =>
      event({ seq, kind: 'scroll', name, props: props as AnalyticsEvent['props'], ...more });
    const response = await post('/v1/batch', {
      v: 1,
      install,
      events: [
        scroll(0, 'note', { position: 0.42 }),
        scroll(1, 'sidebar.folders', { position: 1 }, { client: 'android', os: 'android' }),
        scroll(2, 'settings', { position: 0 }),
        scroll(3, 'note', { position: 0.421 }),
        scroll(4, 'note', { position: 1.2 }),
        scroll(5, 'note', { position: '0.42' }),
        scroll(6, 'note', { position: 0.4, length: 3000 }),
        scroll(7, 'Meeting notes', { position: 0.4 }),
        scroll(8, 'note', { position: 0.4 }, { client: 'cli', sizeClass: undefined }),
      ],
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: 3, dropped: 6, refused: [3, 4, 5, 6, 7, 8] });
    const written = await rows(
      'SELECT kind, name, client, props FROM events WHERE install = ?1 ORDER BY seq',
      install,
    );
    expect(written).toEqual([
      { kind: 'scroll', name: 'note', client: 'mac', props: '{"position":0.42}' },
      { kind: 'scroll', name: 'sidebar.folders', client: 'android', props: '{"position":1}' },
      { kind: 'scroll', name: 'settings', client: 'mac', props: '{"position":0}' },
    ]);
  });

  it('answers 400 when nothing in it is valid, or it is not a batch', async () => {
    const install = newInstall();
    const none = await post('/v1/batch', { v: 1, install, events: [event({ name: 'nope' })] });
    expect(none.status).toBe(400);
    expect(await none.json()).toMatchObject({ accepted: 0, dropped: 1, refused: [0] });
    expect(await eventCount(install)).toBe(0);
    expect((await post('/v1/batch', { v: 1, install, events: [] })).status).toBe(400);
    expect((await post('/v1/batch', 'not json')).status).toBe(400);
    expect((await post('/v1/batch', { v: 2, install, events: [event()] })).status).toBe(400);
    expect((await post('/v1/batch', { v: 1, install: 'ABC', events: [event()] })).status).toBe(400);
    const tooMany = Array.from({ length: 201 }, (_, seq) => event({ seq }));
    expect((await post('/v1/batch', { v: 1, install, events: tooMany })).status).toBe(400);
  });

  it('answers 413 to a body over 64 KB, whether or not it says its length', async () => {
    const big = JSON.stringify({
      v: 1,
      install: newInstall(),
      events: [],
      pad: 'x'.repeat(70_000),
    });
    expect((await post('/v1/batch', big)).status).toBe(413);
    const streamed = new ReadableStream<Uint8Array>({
      start(controller) {
        const chunk = new TextEncoder().encode('x'.repeat(16_384));
        for (let i = 0; i < 5; i++) controller.enqueue(chunk);
        controller.close();
      },
    });
    const response = await handle(
      new Request(`${ORIGIN}/v1/batch`, { method: 'POST', body: streamed }),
      env,
      Date.now(),
    );
    expect(response.status).toBe(413);
  });

  it('answers 429 with Retry-After past 30 batches a minute from one install', async () => {
    const install = newInstall();
    const statuses: number[] = [];
    for (let seq = 0; seq < 31; seq++) {
      statuses.push((await post('/v1/batch', { v: 1, install, events: [event({ seq })] })).status);
    }
    expect(statuses.slice(0, 30).every((status) => status === 202)).toBe(true);
    const limited = await post('/v1/batch', { v: 1, install, events: [event({ seq: 99 })] });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('60');
    expect(await eventCount(install)).toBe(30);
  });

  it('answers 429 past 120 requests a minute from one address', async () => {
    const ip = newIp();
    let last = 0;
    for (let i = 0; i < 121; i++) {
      // Not a batch: the address is limited before the body is read.
      last = (await post('/v1/batch', '{}', ip)).status;
    }
    expect(last).toBe(429);
  });

  it('answers 503 when D1 refuses the write, so the client keeps the batch', async () => {
    const broken = {
      ...env,
      DB: {
        prepare: (sql: string) => env.DB.prepare(sql),
        batch: () => Promise.reject(new Error('D1_ERROR: storage full')),
      } as unknown as D1Database,
    };
    const request = new Request(`${ORIGIN}/v1/batch`, {
      method: 'POST',
      body: JSON.stringify({ v: 1, install: newInstall(), events: [event()] }),
    });
    const response = await handle(request, broken, Date.now());
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('60');
  });

  it('writes no IP address anywhere', async () => {
    const ip = '203.0.113.77';
    const install = newInstall();
    expect((await post('/v1/batch', { v: 1, install, events: [event()] }, ip)).status).toBe(202);
    expect((await post('/v1/forget', { v: 1, install: newInstall() }, ip)).status).toBe(200);
    const dump = await everything();
    expect(dump).toContain(install);
    expect(dump).not.toContain(ip);
    expect(dump).not.toContain('203.0.113');
  });
});

describe('POST /v1/forget', () => {
  it("deletes the install's events and daily installs, and nobody else's", async () => {
    const gone = newInstall();
    const kept = newInstall();
    for (const install of [gone, kept]) {
      expect((await post('/v1/batch', { v: 1, install, events: [event()] })).status).toBe(202);
      await env.DB.prepare(
        `INSERT INTO daily_installs (day, install, client, actor, version, channel, os, os_version)
         VALUES ('2026-11-01', ?1, 'mac', 'person', '1.4.0', 'stable', 'macos', '15.6')`,
      )
        .bind(install)
        .run();
    }
    const response = await post('/v1/forget', { v: 1, install: gone });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ forgotten: true });
    expect(await eventCount(gone)).toBe(0);
    expect(await rows('SELECT * FROM daily_installs WHERE install = ?1', gone)).toEqual([]);
    expect(await eventCount(kept)).toBe(1);
    expect(await rows('SELECT * FROM daily_installs WHERE install = ?1', kept)).toHaveLength(1);
    expect(await everything()).not.toContain(gone);
    const [{ forgets }] = (await rows('SELECT SUM(forgets) AS forgets FROM ingest_daily')) as [
      { forgets: number },
    ];
    expect(forgets).toBeGreaterThan(0);
  });

  it('answers 400 to anything but a forget, and 429 past 5 a minute from one address', async () => {
    expect((await post('/v1/forget', { v: 1, install: 'not-hex' })).status).toBe(400);
    expect((await post('/v1/forget', 'nope')).status).toBe(400);
    const ip = newIp();
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      statuses.push((await post('/v1/forget', { v: 1, install: newInstall() }, ip)).status);
    }
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
  });
});

describe('every other route', () => {
  it('is 404: there is no way to read events back', async () => {
    for (const [method, path] of [
      ['GET', '/v1/batch'],
      ['GET', '/'],
      ['GET', '/v1/events'],
      ['POST', '/v1/query'],
      ['PUT', '/v1/forget'],
      ['DELETE', '/v1/batch'],
    ] as const) {
      const response = await exports.default.fetch(`${ORIGIN}${path}`, { method });
      expect(response.status, `${method} ${path}`).toBe(404);
    }
  });
});

it('the Worker entry exports nothing but its handler, as workerd requires', async () => {
  const entry = await import('../src/index');
  expect(Object.keys(entry)).toEqual(['default']);
});
