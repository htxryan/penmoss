import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Board } from '../src/board.ts';
import { buildView, desktopLink, type FactoryView } from '../src/ui/model.ts';
import { createUiServer, listen } from '../src/ui/server.ts';
import { pageHtml } from '../src/ui/page.ts';
import { item, testConfig } from './helpers.ts';

const config = testConfig();
const NOW = new Date('2026-11-07T18:00:00Z');
const board = (items: Board['items']): Board => ({
  projectId: 'P',
  status: { id: 'S', options: {} },
  blocked: { id: 'B', options: {} },
  items,
});
const line = (run: string, event: string, at: string, extra: object = {}) =>
  JSON.stringify({ at, run, slot: 1, event, ...extra });

describe('the view (F20)', () => {
  const ledger = [
    line('11-a', 'claimed', '2026-11-07T17:00:00Z', { issue: 11 }),
    line('11-a', 'agent-started', '2026-11-07T17:01:00Z', { round: 2 }),
    line('12-b', 'claimed', '2026-11-07T16:00:00Z', { issue: 12 }),
    line('12-b', 'pr-opened', '2026-11-07T16:40:00Z', {
      pr: 'https://github.com/htxryan/penmoss/pull/99',
    }),
    line('12-b', 'in-review', '2026-11-07T16:50:00Z', {
      pr: 'https://github.com/htxryan/penmoss/pull/99',
    }),
    line('13-c', 'claimed', '2026-11-07T15:00:00Z', { issue: 13 }),
    line('13-c', 'blocked', '2026-11-07T15:30:00Z', { reason: 'CI stayed red after 2 repairs' }),
    line('14-d', 'done', '2026-10-01T15:30:00Z', { sha: 'x' }),
    line('15-e', 'done', '2026-11-06T15:30:00Z', { sha: 'y' }),
    '{"torn',
  ].join('\n');
  const view = buildView({
    config,
    board: board([
      item(10, { status: 'Planning' }),
      item(11, { status: 'In progress' }),
      item(12, { status: 'In review' }),
      item(13, { status: 'In progress', blocked: true }),
      item(14, { status: 'Done', state: 'CLOSED' }),
      item(15, { status: 'Done', state: 'CLOSED' }),
      item(16, { status: 'Ready' }),
      item(17, { status: 'Backlog' }),
      item(18, { status: 'Planning', blocked: true }),
    ]),
    ledger,
    plans: {
      10: {
        meta: {
          sessionId: 'S10',
          chatUrl: 'https://claude.ai/code/session_ABC',
          messagedAt: '2026-11-07T17:30:00Z',
        },
        state: {
          status: 'drafting',
          planUrl: 'https://claude.ai/artifact/p10',
          designUrl: null,
          open: [],
          questions: [],
          agreed: null,
        },
      },
      18: {
        meta: {
          sessionId: 'S18',
          askedAt: '2026-11-07T17:45:00Z',
          messagedAt: '2026-11-07T17:00:00Z',
        },
        state: {
          status: 'waiting',
          planUrl: 'https://claude.ai/artifact/p18',
          designUrl: null,
          open: ['Sheet on phones?'],
          questions: [],
          agreed: null,
        },
      },
    },
    busySessions: new Set([10]),
    daemon: { pid: 42, updatedAt: '2026-11-07T17:59:30Z' },
    now: NOW,
  });
  const column = (name: string) => view.columns.find((c) => c.name === name)?.cards ?? [];

  it('puts each issue in flight in its column with its step', () => {
    expect(column('Planning').map((c) => [c.number, c.step])).toEqual([
      [10, 'Planning session working'],
    ]);
    expect(column('In progress').map((c) => [c.number, c.step])).toEqual([
      [11, 'Agent working (round 2)'],
    ]);
    expect(column('In review').map((c) => [c.number, c.step])).toEqual([
      [12, 'Waiting for your review'],
    ]);
    expect(column('Ready').map((c) => c.number)).toEqual([16]);
  });

  it('lists Blocked cards under Waiting on you, with the reason and the open points', () => {
    expect(view.waiting.map((c) => [c.number, c.reason])).toEqual([
      [13, 'CI stayed red after 2 repairs'],
      [18, 'The plan has open points'],
    ]);
    expect(view.waiting[1]?.open).toEqual(['Sheet on phones?']);
    expect(view.waiting[1]?.canComplete).toBe(true);
    expect(view.waiting[0]?.canComplete).toBe(false);
    expect(view.waiting[0]?.step).toBe('Paused: Claimed');
    expect(column('In progress').some((c) => c.number === 13)).toBe(false);
  });

  it('says "You set Blocked" when the factory had no reason of its own', () => {
    const v = buildView({
      config,
      board: board([item(20, { status: 'In review', blocked: true })]),
      ledger: '',
      plans: {},
      busySessions: new Set(),
      daemon: null,
      now: NOW,
    });
    expect(v.waiting[0]?.reason).toBe('You set Blocked');
    expect(v.daemon).toBeNull();
  });

  it('keeps Done cards for doneDays, and leaves out statuses the factory ignores', () => {
    expect(column('Done').map((c) => c.number)).toEqual([15]);
    expect(view.columns.flatMap((c) => c.cards).some((c) => c.number === 17)).toBe(false);
  });

  it('links the issue, PR, CI, artifacts, the chat and the desktop app', () => {
    const pr = column('In review')[0]?.links.map((l) => l.label);
    expect(pr).toEqual(['#12', 'Pull request', 'CI']);
    const planning = column('Planning')[0]?.links;
    expect(planning?.map((l) => l.label)).toEqual(['#10', 'Plan', 'Chat', 'Open in Claude']);
    expect(planning?.at(-1)?.href).toBe('claude://claude.ai/code/session_ABC');
    expect(desktopLink('https://evil.example/code/session_x')).toBeNull();
  });

  it('flags a daemon that stopped writing its status', () => {
    expect(view.daemon?.stale).toBe(false);
    const late = buildView({
      config,
      board: board([]),
      ledger: '',
      plans: {},
      busySessions: new Set(),
      daemon: { pid: 1, updatedAt: '2026-11-07T17:50:00Z' },
      now: NOW,
    });
    expect(late.daemon?.stale).toBe(true);
  });
});

describe('the server (F20)', () => {
  const token = 'a'.repeat(48);
  const empty: FactoryView = {
    updatedAt: NOW.toISOString(),
    writable: false,
    daemon: null,
    waiting: [],
    columns: [],
  };
  const server = createUiServer({
    port: 0,
    token,
    page: pageHtml,
    view: () => Promise.resolve(empty),
  });
  let port = 0;
  beforeAll(async () => {
    port = await listen(server, 0);
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const get = (path: string, headers: Record<string, string> = {}) =>
    new Promise<{ status: number; headers: Record<string, unknown>; body: string }>(
      (resolve, reject) => {
        const req = request(
          { host: '127.0.0.1', port, path, headers: { host: `127.0.0.1:${port}`, ...headers } },
          (res) => {
            let body = '';
            res.on('data', (c: Buffer) => (body += c.toString()));
            res.on('end', () =>
              resolve({ status: res.statusCode ?? 0, headers: res.headers, body }),
            );
          },
        );
        req.on('error', reject);
        req.end();
      },
    );

  it('listens on 127.0.0.1 only', () => {
    expect((server.address() as AddressInfo).address).toBe('127.0.0.1');
  });
  it('refuses a request without the token', async () => {
    expect((await get('/view.json')).status).toBe(403);
    expect((await get('/view.json', { cookie: 'penmoss-factory-ui=wrong' })).status).toBe(403);
  });
  it('swaps the link token for a cookie, then serves with the cookie', async () => {
    const first = await get(`/?token=${token}`);
    expect(first.status).toBe(302);
    expect(first.headers['location']).toBe('/');
    expect(String(first.headers['set-cookie'])).toContain('HttpOnly; SameSite=Strict');
    const next = await get('/view.json', { cookie: `penmoss-factory-ui=${token}` });
    expect(next.status).toBe(200);
    expect(JSON.parse(next.body)).toEqual(empty);
  });
  it('refuses a foreign Origin or Host, even with the token', async () => {
    const cookie = `penmoss-factory-ui=${token}`;
    expect((await get('/view.json', { cookie, origin: 'https://evil.example' })).status).toBe(403);
    expect((await get('/view.json', { cookie, host: 'evil.example' })).status).toBe(403);
    expect((await get('/view.json', { cookie, origin: `http://localhost:${port}` })).status).toBe(
      200,
    );
  });
  it('serves the page with a strict CSP', async () => {
    const page = await get('/', { cookie: `penmoss-factory-ui=${token}` });
    expect(page.body).toContain('<title>Penmoss Factory</title>');
    expect(String(page.headers['content-security-policy'])).toContain("default-src 'none'");
  });
});
