/**
 * The dashboard's API (PEN-137, AC30–AC34) against the fixture D1: each view's JSON, the filters
 * checked and applied, Paths' small-numbers rule, nothing per install outside Sessions (PEN-173),
 * the 5-minute cache, and no way to send SQL.
 */
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { fixtureInstalls, seedFixture } from '../../telemetry/test/fixture';
import { ACCESS_HEADER, AccessVerifier } from '../src/access';
import { insertEvent } from '../../telemetry/src/ingest';
import { MIN_SESSIONS, pathTree } from '../src/api';
import { handle, type Deps } from '../src/handler';
import { createSigner } from './signer';

const NOW = Date.UTC(2026, 10, 19, 18, 0);
/** The fixture's first install, a Mac, and its session today. */
const INSTALL = 'a0'.repeat(16);
const SESSION = '0000000000000000';
const ORIGIN = 'https://stats.penmoss.test';
let token: string;
let deps: Deps;

beforeAll(async () => {
  await seedFixture(env.DB, NOW);
  const signer = await createSigner();
  // The clock is the fixture's: the token is valid then.
  token = await signer.sign({ iat: NOW / 1000, nbf: NOW / 1000, exp: NOW / 1000 + 3600 });
  deps = { verifier: new AccessVerifier(signer.fetchCerts), now: () => NOW, cache: null };
});

async function get(path: string, using = deps): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await handle(
    new Request(`${ORIGIN}${path}`, { headers: { [ACCESS_HEADER]: token } }),
    env,
    ctx,
    using,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

async function view<T = Record<string, unknown>>(path: string): Promise<T> {
  const response = await get(path);
  expect(response.status, path).toBe(200);
  return response.json<T>();
}

type Rows = Record<string, string | number>[];

describe('each view', () => {
  it('overview: the tiles, weekly actives by client, the actor split and top versions', async () => {
    const data = await view<{
      totals: Record<string, number>;
      active: Rows;
      actors: Rows;
      versions: Rows;
      today: string;
    }>('/api/overview?days=30');
    expect(data.today).toBe('2026-11-19');
    expect(data.totals).toEqual({ today: 10, last7: 10, last30: 12 });
    expect(new Set(data.active.map((row) => row['client']))).toEqual(
      new Set(['mac', 'android', 'cli', 'mcp']),
    );
    expect(new Set(data.actors.map((row) => row['actor']))).toEqual(new Set(['person', 'agent']));
    // Ten installs ran 1.3.0 earlier in the month, eight Macs and two phones; each row is a
    // version on a client (a Mac's CLI and MCP server count as their own clients).
    for (const row of data.versions)
      expect(Object.keys(row).sort()).toEqual(['client', 'installs', 'version']);
    const of = (version: string, client: string) =>
      data.versions.find((row) => row['version'] === version && row['client'] === client)?.[
        'installs'
      ];
    expect(Number(of('1.3.0', 'mac')) + Number(of('1.3.0', 'android'))).toBe(10);
    expect(data.versions[0]).toMatchObject({ version: '1.3.0', installs: 8 });
  });

  it('commands: top commands by source, shortcuts and the never-used', async () => {
    const data = await view<{ commands: Rows; shortcuts: Rows; unused: Rows }>(
      '/api/commands?days=30',
    );
    expect(data.commands[0]).toMatchObject({ name: 'note.new' });
    expect(new Set(data.commands.map((row) => row['name'])).size).toBeLessThanOrEqual(25);
    // Two Macs rebound New Note; its default comes from the shortcut map every client shares.
    expect(data.shortcuts.find((row) => row['keys'] === 'Mod+Alt+N')).toMatchObject({
      rebound_installs: 2,
      default_keys: 'Alt+N',
    });
    expect(data.shortcuts.find((row) => row['name'] === 'app.palette')).toMatchObject({
      default_keys: 'Mod+K',
    });
    expect(data.unused.length).toBeGreaterThan(10);
  });

  it('firstrun: the steps in the first run’s order, capped at 90 days, and where installs gave up', async () => {
    const data = await view<{ days: number; steps: Rows; gaveUp: Rows }>('/api/firstrun?days=365');
    expect(data.days).toBe(90);
    const order = [...new Set(data.steps.map((row) => row['step']))];
    expect(order.slice(0, 4)).toEqual(['welcome', 'goal', 'way', 'github']);
    expect(order.at(-1)).toBe('consent');
    expect(data.gaveUp).toHaveLength(2);
  });

  it('paths: the catalogue to start from, then a tree three deep with shares', async () => {
    const empty = await view<{ options: { event: string; events: number }[]; tree: unknown }>(
      '/api/paths?days=30',
    );
    // Every catalogued event, with how often it occurred in the period, the most frequent first.
    const counts = empty.options.map((option) => option.events);
    expect(counts).toEqual([...counts].sort((a, b) => b - a));
    expect(empty.options.find((o) => o.event === 'command:app.palette')!.events).toBeGreaterThan(0);
    expect(empty.options.find((o) => o.event === 'command:app.graph')!.events).toBe(0);
    expect(empty.tree).toBeNull();
    const data = await view<{
      tree: {
        event: string;
        sessions: number;
        children: { event: string; share: number; children: unknown[] }[];
      };
    }>('/api/paths?days=30&start=command:app.palette');
    expect(data.tree.event).toBe('command:app.palette');
    expect(data.tree.children[0]).toMatchObject({ event: 'command:note.new' });
    expect(data.tree.children.length).toBeLessThanOrEqual(3);
    expect(data.tree.children[0]!.share).toBeGreaterThan(50);
    expect(data.tree.children[0]!.children.length).toBeGreaterThan(0);
  });

  it('platforms: clients × OS versions, version adoption (top 6 and Other), size classes and window sizes', async () => {
    const data = await view<{ platforms: Rows; adoption: Rows; sizes: Rows; windowSizes: Rows }>(
      '/api/platforms?days=90',
    );
    // Main windows only, sizes under 5 installs in Other (PEN-174).
    expect(
      data.windowSizes.map((row) => [row['client'], row['width'], row['height'], row['installs']]),
    ).toEqual([
      ['android', null, null, 2],
      ['mac', 1440, 900, 6],
      ['mac', 1280, 800, 5],
      ['mac', null, null, 2],
    ]);
    expect(data.platforms.map((row) => `${row['client']} ${row['os_version']}`)).toContain(
      'android 16',
    );
    expect(new Set(data.adoption.map((row) => row['version']))).toEqual(
      new Set(['1.4.0', '1.3.2', '1.3.0', '1.2.0']),
    );
    expect(new Set(data.sizes.map((row) => row['size_class']))).toEqual(
      new Set(['expanded', 'compact']),
    );
  });

  it('agents: events by actor, and CLI commands and MCP tools by agent client', async () => {
    const data = await view<{ actors: Rows; agents: Rows }>('/api/agents?days=30');
    expect(new Set(data.agents.map((row) => row['agent']))).toEqual(
      new Set(['claude-code', 'codex', 'agent', 'person']),
    );
    // Every call ended in exactly one result.
    for (const row of data.agents) {
      const results = ['ok', 'invalid', 'not_found', 'conflict', 'failed'].map((key) =>
        Number(row[key]),
      );
      expect(results.reduce((sum, n) => sum + n, 0)).toBe(row['calls']);
    }
    expect(data.agents.some((row) => Number(row['ok']) < Number(row['calls']))).toBe(true);
  });

  it('every view says how fresh it is: when it was made, the newest event, the rollup', async () => {
    const data = await view<{ asOf: number; receivedAt: number; rolledUpThrough: string }>(
      '/api/health?days=7',
    );
    expect(data.asOf).toBe(NOW);
    expect(data.receivedAt).toBeGreaterThan(NOW - 2 * 86_400_000);
    expect(data.rolledUpThrough).toBe('2026-11-18');
  });

  it('health: the ingest counts per day and the write cap', async () => {
    const data = await view<{ health: Rows; writeCap: number; sync: Rows }>('/api/health?days=7');
    expect(data.health).toHaveLength(7);
    expect(data.writeCap).toBe(100_000);
    expect(data.sync.length).toBeGreaterThan(0);
  });

  it('versions: the filter’s list', async () => {
    const data = await view<{ versions: string[] }>('/api/versions?days=395');
    expect(data.versions).toEqual(expect.arrayContaining(['1.4.0', '1.3.2', '1.3.0', '1.2.0']));
  });
});

describe('the filters', () => {
  it('narrow a view: client, actor, channel, version', async () => {
    const phones = await view<{ totals: Record<string, number> }>(
      '/api/overview?days=30&client=android',
    );
    expect(phones.totals['today']).toBe(2);
    const agents = await view<{ actors: Rows }>('/api/agents?days=30&actor=agent');
    expect(new Set(agents.actors.map((row) => row['actor']))).toEqual(new Set(['agent']));
    const alpha = await view<{ totals: Record<string, number> }>(
      '/api/overview?days=30&channel=alpha',
    );
    expect(alpha.totals['today']).toBe(3);
    const version = await view<{ versions: Rows }>('/api/overview?days=30&version=1.3.2');
    expect(new Set(version.versions.map((row) => row['version']))).toEqual(new Set(['1.3.2']));
  });

  it('refuse anything not on their lists, and any other parameter: no SQL gets in', async () => {
    for (const path of [
      '/api/overview?days=31',
      '/api/overview?days=7;DROP TABLE events',
      '/api/overview?client=ios',
      "/api/overview?client=mac' OR '1'='1",
      '/api/overview?actor=robot',
      '/api/overview?channel=beta',
      '/api/overview?version=latest',
      '/api/overview?sql=SELECT%20*%20FROM%20events',
      '/api/overview?query=events',
      '/api/paths?start=command:not.a.command',
      '/api/paths?start=SELECT:1',
      // Sessions' own parameters (PEN-173): checked, and refused on every other route.
      '/api/sessions?page=0',
      '/api/sessions?page=-1',
      '/api/sessions?page=1.5',
      '/api/sessions?page=10000',
      '/api/sessions?page=2%20OR%201',
      `/api/sessions?install=${INSTALL}`,
      '/api/session',
      `/api/session?install=${INSTALL}`,
      `/api/session?session=${SESSION}`,
      `/api/session?install=${INSTALL.toUpperCase()}&session=${SESSION}`,
      `/api/session?install=${INSTALL.slice(1)}&session=${SESSION}`,
      `/api/session?install=${INSTALL}&session=${SESSION}x`,
      `/api/session?install=${INSTALL}&session=x'%20OR%201=1`,
      `/api/session?install=${INSTALL}&session=${SESSION}&page=2`,
      '/api/overview?page=2',
      `/api/overview?install=${INSTALL}`,
      `/api/paths?session=${SESSION}`,
    ]) {
      const response = await get(path);
      expect(response.status, path).toBe(400);
    }
    for (const path of ['/api/events', '/api/sql', '/api/../api/overview/x', '/api/']) {
      expect((await get(path)).status, path).toBe(404);
    }
  });
});

describe('nothing per install outside Sessions (PEN-173)', () => {
  it('no other view’s JSON holds an install or session id', async () => {
    const ids = fixtureInstalls(NOW).flatMap(({ install, events }) => [
      install,
      ...events.map((e) => e.session),
    ]);
    for (const path of [
      '/api/overview?days=395',
      '/api/commands?days=395',
      '/api/firstrun?days=90',
      '/api/paths?days=90&start=command:app.palette',
      '/api/platforms?days=395',
      '/api/agents?days=395',
      '/api/health?days=395',
      '/api/versions?days=395',
    ]) {
      const text = await (await get(path)).text();
      for (const id of new Set(ids)) expect(text, path).not.toContain(id);
    }
  });

  it('a path fewer than 5 sessions took is never shown, at any depth', async () => {
    const data = await view<{ tree: unknown }>('/api/paths?days=90&start=command:app.palette');
    const counts: number[] = [];
    const walk = (node: { sessions: number; event: string; children: unknown[] }) => {
      counts.push(node.sessions);
      expect(node.event).not.toBe('command:app.trash');
      node.children.forEach((child) => walk(child as typeof node));
    };
    walk(data.tree as Parameters<typeof walk>[0]);
    expect(Math.min(...counts)).toBeGreaterThanOrEqual(MIN_SESSIONS);
    // A start too rare for 5 sessions has no tree at all.
    const rare = await view<{ tree: unknown }>('/api/paths?days=90&start=command:app.trash');
    expect(rare.tree).toBeNull();
  });

  it('pathTree drops rows under 5 sessions even if a query let them through', () => {
    const tree = pathTree('command:x', [
      { depth: 0, n1: '', n2: '', n3: '', sessions: 9 },
      { depth: 1, n1: 'command:a', n2: '', n3: '', sessions: 5 },
      { depth: 1, n1: 'command:b', n2: '', n3: '', sessions: 4 },
    ]);
    expect(tree?.children.map((child) => child.event)).toEqual(['command:a']);
    expect(pathTree('command:x', [{ depth: 0, n1: '', n2: '', n3: '', sessions: 4 }])).toBeNull();
  });
});

describe('sessions (PEN-173)', () => {
  type SessionsAnswer = { days: number; page: number; total: number; sessions: Rows };

  it('lists the newest sessions first, 50 a page, with the total', async () => {
    const data = await view<SessionsAnswer>('/api/sessions?days=30');
    expect(data).toMatchObject({ days: 30, page: 1 });
    expect(data.sessions).toHaveLength(50);
    expect(data.total).toBeGreaterThan(100);
    const started = data.sessions.map((row) => Number(row['started']));
    expect(started).toEqual([...started].sort((a, b) => b - a));
    expect(Object.keys(data.sessions[0]!).sort()).toEqual(
      [
        'client',
        'ended',
        'events',
        'first_screen',
        'install',
        'last_screen',
        'os',
        'os_version',
        'session',
        'started',
        'took',
        'version',
      ].sort(),
    );
    const second = await view<SessionsAnswer>('/api/sessions?days=30&page=2');
    expect(second.page).toBe(2);
    expect(Number(second.sessions[0]!['started'])).toBeLessThanOrEqual(started.at(-1)!);
  });

  it('answers the first page for a page past the end', async () => {
    const data = await view<SessionsAnswer>('/api/sessions?days=30&page=9999');
    expect(data.page).toBe(1);
    expect(data.sessions).toHaveLength(50);
  });

  it('reads at most 90 days, and the filters narrow it', async () => {
    const year = await view<SessionsAnswer>('/api/sessions?days=365');
    expect(year.days).toBe(90);
    const phones = await view<SessionsAnswer>('/api/sessions?days=30&client=android');
    expect(phones.total).toBeLessThan(year.total);
    expect(new Set(phones.sessions.map((row) => row['client']))).toEqual(new Set(['android']));
    const none = await view<SessionsAnswer>('/api/sessions?days=7&client=android&actor=script');
    expect(none).toMatchObject({ total: 0, page: 1, sessions: [] });
  });

  it('gives one session’s events in order, props parsed, and its install’s sessions', async () => {
    const data = await view<{
      days: number;
      install: string;
      session: string;
      events: { seq: number; kind: string; name: string; props: unknown }[];
      more: boolean;
      others: Rows;
      othersTotal: number;
    }>(`/api/session?install=${INSTALL}&session=${SESSION}`);
    expect(data).toMatchObject({ days: 90, install: INSTALL, session: SESSION, more: false });
    const own = fixtureInstalls(NOW)[0]!.events.filter((e) => e.session === SESSION);
    expect(data.events.map((e) => e.seq)).toEqual(own.map((e) => e.seq));
    expect(data.events[2]).toMatchObject({
      kind: 'command',
      name: 'app.palette',
      props: { source: 'key', keys: 'Mod+K', custom: false, ran: true },
    });
    // The install's sessions in 90 days, oldest first, the open one among them.
    const sessions = new Set(fixtureInstalls(NOW)[0]!.events.map((e) => e.session));
    expect(data.othersTotal).toBe(sessions.size);
    expect(data.others).toHaveLength(sessions.size);
    expect(data.others.at(-1)).toMatchObject({ session: SESSION, client: 'mac' });
    expect(data.others[0]).not.toHaveProperty('total');
  });

  it('gives no events for a session it does not have, and says when there were more than 5,000', async () => {
    const missing = await view<{ events: unknown[]; others: unknown[] }>(
      `/api/session?install=${INSTALL}&session=0123456789abcdef`,
    );
    expect(missing).toMatchObject({ events: [], others: [] });
    const long = 'c3'.repeat(16);
    const session = '00000000000c0de1';
    const statements = Array.from({ length: 5001 }, (_, seq) =>
      insertEvent(
        env.DB,
        long,
        {
          session,
          seq,
          at: NOW - 86_400_000 + seq * 1000,
          client: 'mac',
          actor: 'person',
          version: '1.4.0',
          channel: 'stable',
          os: 'macos',
          osVersion: '26.1',
          sizeClass: 'expanded',
          kind: 'screen',
          name: 'home',
          props: {},
        },
        NOW,
      ),
    );
    for (let start = 0; start < statements.length; start += 100) {
      await env.DB.batch(statements.slice(start, start + 100));
    }
    const data = await view<{ events: unknown[]; more: boolean; others: Rows }>(
      `/api/session?install=${long}&session=${session}`,
    );
    expect(data.events).toHaveLength(5000);
    expect(data.more).toBe(true);
    // Its row in others has the whole session's count.
    expect(data.others[0]).toMatchObject({ session, events: 5001 });
  });
});

describe('the cache', () => {
  it('keeps an answer 5 minutes, keyed by its URL, after Access', async () => {
    const cache = await caches.open('dashboard-test');
    const cached: Deps = { ...deps, cache };
    const first = await get('/api/health?days=30', cached);
    expect(first.headers.get('x-dashboard-cache')).toBeNull();
    const second = await get('/api/health?days=30', cached);
    expect(second.headers.get('x-dashboard-cache')).toBe('hit');
    expect(await second.json()).toEqual(await first.json());
    // Parameters in another order are the same answer.
    const reordered = await get('/api/overview?client=mac&days=7', cached);
    expect(reordered.headers.get('x-dashboard-cache')).toBeNull();
    expect(
      (await get('/api/overview?days=7&client=mac', cached)).headers.get('x-dashboard-cache'),
    ).toBe('hit');
    // Sessions' answers are cached the same way (PEN-173).
    for (const path of [
      '/api/sessions?days=30&page=2',
      `/api/session?install=${INSTALL}&session=${SESSION}`,
    ]) {
      expect((await get(path, cached)).headers.get('x-dashboard-cache'), path).toBeNull();
      expect((await get(path, cached)).headers.get('x-dashboard-cache'), path).toBe('hit');
    }
    // Without a token, a cached answer is still 403.
    const ctx = createExecutionContext();
    const anonymous = await handle(new Request(`${ORIGIN}/api/health?days=30`), env, ctx, cached);
    expect(anonymous.status).toBe(403);
  });
});
