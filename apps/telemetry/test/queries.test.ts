/**
 * The named queries (PEN-137, AC19): each one runs against the fixture D1 and returns rows, each
 * is one SELECT, and the ones the dashboard leans on say what they should. `task telemetry:query`
 * runs the same files through scripts/query.mjs.
 */
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { dayOf } from '../src/day';
import {
  NAMED_QUERIES,
  QUERY_NAMES,
  bindingsFor,
  parameterCount,
  runQuery,
  type QueryParams,
} from '../src/queries';
import { seedFixture } from './fixture';

const NOW = Date.UTC(2026, 10, 19, 18, 0);
const ALL: QueryParams = {
  days: 30,
  client: '',
  actor: '',
  channel: '',
  version: '',
  today: dayOf(NOW),
  startKind: 'command',
  startName: 'app.palette',
  // The Sessions tab's (PEN-173): the fixture's first install and its session today.
  install: 'a0'.repeat(16),
  session: '0000000000000000',
};

beforeAll(async () => {
  await seedFixture(env.DB, NOW);
});

describe('every named query', () => {
  it('is the list the plan names, and more', () => {
    for (const name of [
      'active',
      'commands',
      'shortcuts',
      'unused',
      'firstrun',
      'next',
      'gave-up',
      'settings',
      'agents',
      'platforms',
      'sync',
      'feedback',
      'health',
    ]) {
      expect(QUERY_NAMES).toContain(name);
    }
  });

  it.each(QUERY_NAMES)('%s is one SELECT and returns rows from the fixture', async (name) => {
    const sql = NAMED_QUERIES[name].replace(/--.*$/gm, '').trim();
    expect(sql).toMatch(/^(WITH|SELECT)\b/);
    expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|PRAGMA|ATTACH|REPLACE)\b/i);
    // One statement: the only semicolon ends it.
    expect(sql.indexOf(';')).toBe(sql.length - 1);
    const rows = await runQuery(env.DB, name, ALL);
    expect(rows.length, name).toBeGreaterThan(0);
  });

  it('binds exactly the values a query uses', () => {
    expect(parameterCount(NAMED_QUERIES.next)).toBe(8);
    expect(parameterCount(NAMED_QUERIES.health)).toBe(6);
    expect(parameterCount(NAMED_QUERIES.sessions)).toBe(11);
    expect(bindingsFor(NAMED_QUERIES.sessions, ALL)).toEqual([
      30,
      '',
      '',
      '',
      '',
      '2026-11-19',
      'command',
      'app.palette',
      'a0'.repeat(16),
      '0000000000000000',
      1,
    ]);
    expect(bindingsFor(NAMED_QUERIES.health, ALL)).toEqual([30, '', '', '', '', '2026-11-19']);
  });
});

describe('what they say', () => {
  it('active-totals counts installs today, this week and this month', async () => {
    const [totals] = await runQuery<{ today: number; last7: number; last30: number }>(
      env.DB,
      'active-totals',
      ALL,
    );
    // Ten installs use Penmoss every day; two phones gave up in the first run 24 and 25 days ago.
    expect(totals).toEqual({ today: 10, last7: 10, last30: 12 });
  });

  it('a filter narrows a query to one client', async () => {
    const phones = await runQuery<{ client: string }>(env.DB, 'platforms', {
      ...ALL,
      client: 'android',
    });
    expect(new Set(phones.map((row) => row.client))).toEqual(new Set(['android']));
    const [totals] = await runQuery<{ today: number }>(env.DB, 'active-totals', {
      ...ALL,
      client: 'android',
    });
    expect(totals!.today).toBe(2);
  });

  it('commands are split by source, most run first', async () => {
    const rows = await runQuery<{ name: string; source: string; runs: number; total: number }>(
      env.DB,
      'commands',
      ALL,
    );
    expect(rows[0]!.name).toBe('note.new');
    const sources = rows.filter((row) => row.name === 'note.new').map((row) => row.source);
    expect(sources.sort()).toEqual(['key', 'palette']);
    const quickOpen = rows.filter((row) => row.name === 'app.quickOpen').map((row) => row.source);
    expect(quickOpen.sort()).toEqual(['menu', 'tray']);
  });

  it('shortcuts say which installs set their own combination', async () => {
    const rows = await runQuery<{ name: string; keys: string; rebound_installs: number }>(
      env.DB,
      'shortcuts',
      ALL,
    );
    const custom = rows.find((row) => row.keys === 'Mod+Alt+N');
    expect(custom).toMatchObject({ name: 'note.new', rebound_installs: 2 });
  });

  it('the first run funnel narrows, and gave-up names where two phones stopped', async () => {
    const funnel = await runQuery<{ step: string; installs: number }>(env.DB, 'firstrun', {
      ...ALL,
      days: 90,
    });
    const reached = (step: string) =>
      funnel.filter((row) => row.step === step).reduce((sum, row) => sum + row.installs, 0);
    expect(reached('welcome')).toBe(12);
    expect(reached('consent')).toBe(10);
    const gaveUp = await runQuery<{ step: string; result: string; error: string }>(
      env.DB,
      'gave-up',
      { ...ALL, days: 90 },
    );
    expect(gaveUp.map((row) => [row.step, row.result, row.error]).sort()).toEqual([
      ['github', 'failed', 'auth'],
      ['repo', 'back', ''],
    ]);
  });

  it('next hides any path fewer than 5 sessions took', async () => {
    const rows = await runQuery<{ depth: number; n1: string; sessions: number }>(
      env.DB,
      'next',
      ALL,
    );
    expect(rows.every((row) => row.sessions >= 5)).toBe(true);
    // One Mac went from the palette to the trash once: never shown.
    expect(rows.some((row) => row.n1 === 'command:app.trash')).toBe(false);
    expect(rows.find((row) => row.depth === 1 && row.n1 === 'command:note.new')).toBeDefined();
    expect(rows.find((row) => row.depth === 3)).toBeDefined();
  });

  it('agents splits MCP tools by agent client and counts each result', async () => {
    type AgentRow = Record<'ok' | 'invalid' | 'not_found' | 'conflict' | 'failed', number> & {
      kind: string;
      agent: string;
      calls: number;
    };
    const rows = await runQuery<AgentRow>(env.DB, 'agents', ALL);
    const agents = new Set(rows.filter((row) => row.kind === 'tool').map((row) => row.agent));
    expect(agents).toEqual(new Set(['claude-code', 'codex']));
    // Every call has exactly one result; a CLI exit maps to the same five.
    for (const row of rows) {
      expect(row.ok + row.invalid + row.not_found + row.conflict + row.failed).toBe(row.calls);
    }
    expect(rows.some((row) => row.ok < row.calls)).toBe(true);
  });

  it('versions splits each version by client', async () => {
    const rows = await runQuery<{ version: string; client: string; installs: number }>(
      env.DB,
      'versions',
      ALL,
    );
    const mac = rows.find((row) => row.version === '1.3.0' && row.client === 'mac');
    expect(mac?.installs).toBe(8);
    expect(new Set(rows.map((row) => row.client))).toEqual(
      new Set(['mac', 'android', 'cli', 'mcp']),
    );
  });

  it('starts counts each event in the period, the most frequent first', async () => {
    const rows = await runQuery<{ kind: string; name: string; events: number }>(
      env.DB,
      'starts',
      ALL,
    );
    const counts = rows.map((row) => row.events);
    expect(counts).toEqual([...counts].sort((a, b) => b - a));
    expect(
      rows.find((row) => row.kind === 'command' && row.name === 'app.palette')?.events,
    ).toBeGreaterThan(0);
  });

  it('freshness says when the newest event arrived and how far the rollup reached', async () => {
    const [row] = await runQuery<{ received_at: number; rolled_up_through: string }>(
      env.DB,
      'freshness',
      ALL,
    );
    expect(row!.received_at).toBeGreaterThan(0);
    expect(row!.rolled_up_through).toBe(dayOf(NOW - 86_400_000));
  });

  it('unused lists catalogued names nothing ran', async () => {
    const rows = await runQuery<{ kind: string; name: string }>(env.DB, 'unused', ALL);
    const names = rows.map((row) => `${row.kind}:${row.name}`);
    expect(names).toContain('command:app.graph');
    expect(names).not.toContain('command:app.palette');
  });

  it('window-sizes counts installs by main window size, the 10 most per client, then Other', async () => {
    type SizeRow = {
      client: string;
      width: number | null;
      height: number | null;
      installs: number;
    };
    const rows = await runQuery<SizeRow>(env.DB, 'window-sizes', ALL);
    const label = (row: SizeRow) =>
      `${row.client} ${row.width === null ? 'Other' : `${row.width}×${row.height}`} ${row.installs}`;
    // Six Macs open at 1440 × 900 and five are resized to 1280 × 800; the two at 1730 × 1080
    // and the phones (two installs a size) are under the floor of 5: Other. The note window and
    // Quick Capture are not main windows.
    expect(rows.map(label)).toEqual([
      'android Other 2',
      'mac 1440×900 6',
      'mac 1280×800 5',
      'mac Other 2',
    ]);
    expect(
      rows.filter((row) => row.client === 'mac' && row.width !== null).length,
    ).toBeLessThanOrEqual(10);
    const phones = await runQuery<SizeRow>(env.DB, 'window-sizes', { ...ALL, client: 'android' });
    expect(new Set(phones.map((row) => row.client))).toEqual(new Set(['android']));
    // A week: only today's sessions and the six days before.
    const week = await runQuery<SizeRow>(env.DB, 'window-sizes', { ...ALL, days: 7 });
    expect(week.find((row) => row.client === 'mac' && row.width === 1440)?.installs).toBe(6);
  });
});
