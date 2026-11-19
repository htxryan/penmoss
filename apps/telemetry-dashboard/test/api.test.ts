/**
 * The dashboard's API (PEN-137, AC30–AC34) against the fixture D1: each view's JSON, the filters
 * checked and applied, Paths' small-numbers rule, nothing per install, the 5-minute cache, and no
 * way to send SQL.
 */
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { fixtureInstalls, seedFixture } from '../../telemetry/test/fixture';
import { ACCESS_HEADER, AccessVerifier } from '../src/access';
import { MIN_SESSIONS, pathTree } from '../src/api';
import { handle, type Deps } from '../src/index';
import { createSigner } from './signer';

const NOW = Date.UTC(2026, 10, 19, 18, 0);
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
    // Ten installs ran 1.3.0 earlier in the month; six run 1.4.0 now.
    expect(data.versions.slice(0, 2)).toEqual([
      { version: '1.3.0', installs: 10 },
      { version: '1.4.0', installs: 6 },
    ]);
  });

  it('commands: top commands by source, shortcuts and the never-used', async () => {
    const data = await view<{ commands: Rows; shortcuts: Rows; unused: Rows }>(
      '/api/commands?days=30',
    );
    expect(data.commands[0]).toMatchObject({ name: 'note.new' });
    expect(new Set(data.commands.map((row) => row['name'])).size).toBeLessThanOrEqual(25);
    expect(data.shortcuts.find((row) => row['keys'] === 'Mod+Alt+N')).toMatchObject({
      rebound_installs: 2,
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
    const empty = await view<{ options: string[]; tree: unknown }>('/api/paths?days=30');
    expect(empty.options).toContain('command:app.palette');
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

  it('platforms: clients × OS versions, version adoption (top 6 and Other) and size classes', async () => {
    const data = await view<{ platforms: Rows; adoption: Rows; sizes: Rows }>(
      '/api/platforms?days=90',
    );
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
    expect(version.versions.map((row) => row['version'])).toEqual(['1.3.2']);
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
    ]) {
      const response = await get(path);
      expect(response.status, path).toBe(400);
    }
    for (const path of ['/api/events', '/api/sql', '/api/../api/overview/x', '/api/']) {
      expect((await get(path)).status, path).toBe(404);
    }
  });
});

describe('nothing per install', () => {
  it('no view’s JSON holds an install or session id', async () => {
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
    // Without a token, a cached answer is still 403.
    const ctx = createExecutionContext();
    const anonymous = await handle(new Request(`${ORIGIN}/api/health?days=30`), env, ctx, cached);
    expect(anonymous.status).toBe(403);
  });
});
