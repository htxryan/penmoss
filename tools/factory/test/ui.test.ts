import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildView,
  chatLink,
  cleanError,
  pointsOf,
  type FactoryView,
  type ViewInput,
} from '../src/ui/model.ts';
import { uiToken, uiTokenPath } from '../src/ui/link.ts';
import { tailFile, viewFromState } from '../src/ui/run.ts';
import { createUiServer, listen } from '../src/ui/server.ts';
import { pageHtml } from '../src/ui/page.ts';
import { item, testConfig } from './helpers.ts';
import { evening, line, NOW, pen, writeEvening } from './ui-fixture.ts';

const base = evening();
const input = (o: Partial<ViewInput> = {}): ViewInput => ({
  config: base.config,
  board: base.board,
  ledger: base.ledger,
  plans: base.plans,
  busySessions: new Set([76]),
  status: base.status,
  alive: () => true,
  now: NOW,
  ...o,
});
const view = buildView(input());
const card = (v: FactoryView, key: string) => {
  const c = v.cards.find((x) => x.key === key);
  if (!c) throw new Error(`${key} isn't in the view`);
  return c;
};
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();

describe("Needs you: only the factory's own claims (A1233)", () => {
  it('lists what the factory stopped on or handed back, oldest first', () => {
    expect(view.needs.map((c) => [c.key, c.need?.kind])).toEqual([
      ['PEN-73', 'unblock'],
      ['PEN-75', 'machine'],
      ['PEN-74', 'review'],
      ['PEN-78', 'answer'],
      ['PEN-77', 'machine'],
      ['PEN-84', 'card'],
    ]);
  });

  it('leaves out In Progress cards the factory never claimed, and counts them', () => {
    // The old page listed PEN-36 ("Blocked by PEN-35") and PEN-37 ("You set Blocked") as waiting.
    expect(view.cards.map((c) => c.key)).not.toContain('PEN-36');
    expect(view.cards.map((c) => c.key)).not.toContain('PEN-37');
    expect(view.outside).toEqual(['PEN-36', 'PEN-37']);
  });

  it('lists a card the factory blocked after a failed run (PEN-75)', () => {
    const c = card(view, 'PEN-75');
    expect(c.group).toBe('needs');
    expect(c.blocked).toBe(true);
    expect(c.paused).toBe(false);
  });

  it('keeps a card Ryan blocked himself out of Needs you: it is paused', () => {
    const v = buildView(
      input({
        board: {
          items: [
            pen(20, { status: 'In Review', labels: ['Blocked'], blocked: true, blockedSet: true }),
          ],
        },
        ledger: [
          line('20-a', 'claimed', minutesAgo(50), { issue: 20 }),
          line('20-a', 'in-review', minutesAgo(40), {
            pr: 'https://github.com/htxryan/penmoss/pull/9',
          }),
        ].join('\n'),
        status: null,
      }),
    );
    expect(v.needs).toEqual([]);
    expect([card(v, 'PEN-20').group, card(v, 'PEN-20').step]).toEqual(['queue', 'Paused by you']);
  });

  it('says which unfinished issue holds a card, with no Blocked to clear (LD8)', () => {
    const c = card(view, 'PEN-82');
    expect([c.group, c.step, c.blocked, c.heldBy]).toEqual([
      'queue',
      'Held: blocked by PEN-77',
      false,
      ['PEN-77'],
    ]);
  });
});

describe('a run that failed before the agent started (A1233)', () => {
  it('shows the failure, not "Paused: Agent working (round 0)"', () => {
    const c = card(view, 'PEN-75');
    expect(c.step).toBe('Failed before the agent started: claude: command not found (exit 127)');
    expect(c.step).not.toMatch(/Paused|round 0/);
    expect(c.need?.label).toBe('Fix the Mac');
    expect(c.need?.command).toBe('task factory:install');
    expect(c.runs.map((r) => [r.outcome, r.summary])).toEqual([
      ['failed', 'Failed before the agent started: claude: command not found (exit 127)'],
    ]);
  });

  it('says so when the run failed before the agent was even launched', () => {
    const v = buildView(
      input({
        board: {
          items: [
            pen(21, {
              status: 'In Progress',
              labels: ['Blocked'],
              blocked: true,
              blockedSet: true,
            }),
          ],
        },
        ledger: [
          line('21-a', 'claimed', minutesAgo(5), { issue: 21 }),
          line('21-a', 'failed', minutesAgo(4), { error: 'git worktree add failed: disk full' }),
        ].join('\n'),
      }),
    );
    expect(card(v, 'PEN-21').step).toBe(
      'Failed before the agent started: git worktree add failed: disk full',
    );
    expect(card(v, 'PEN-21').need?.kind).toBe('unblock');
  });

  it('counts agent rounds from 1, as people do', () => {
    expect(card(view, 'PEN-79').step).toBe('Agent round 1 of 3');
    expect(card(view, 'PEN-79').round).toBe('Agent round 1 of 3');
  });

  it("cleans an agent CLI's error into one line", () => {
    expect(
      cleanError('claude-code exited with code 127:\n/bin/sh: claude: command not found\n'),
    ).toBe('claude: command not found (exit 127)');
    expect(cleanError('spawn terminal-notifier ENOENT')).toBe('spawn terminal-notifier ENOENT');
  });
});

describe("the daemon's health (A1233)", () => {
  it('is running while the pid is alive and polls are fresh', () => {
    expect(view.health).toMatchObject({
      state: 'running',
      fresh: true,
      pid: 4242,
      ageSeconds: 14,
      slots: { total: 2, busy: 2 },
    });
  });

  it('says the status is stale when the daemon stopped polling', () => {
    const late = { ...base.status, updatedAt: minutesAgo(13) };
    const v = buildView(input({ status: late }));
    expect(v.health).toMatchObject({
      state: 'stale',
      fresh: false,
      headline: 'Daemon not polling',
    });
    expect(v.health.detail).toContain('13 min ago');
  });

  it('says the daemon is dead when its pid is, and shows nothing as live', () => {
    const v = buildView(input({ alive: (pid) => pid !== 4242 }));
    expect(v.health).toMatchObject({ state: 'dead', fresh: false, headline: 'Daemon not running' });
    expect(v.health.detail).toContain('pid 4242 has exited');
    expect(v.health.fix).toBe('task factory:start');
    expect(v.slots.every((s) => s.issue === null)).toBe(true);
    expect(card(v, 'PEN-79').step).toBe('Stopped mid-run; the daemon restarts it on its branch');
  });

  it('says so when there is no status at all', () => {
    expect(buildView(input({ status: null })).health).toMatchObject({
      state: 'missing',
      fresh: false,
    });
  });

  it('names a wrong checkout and a failing doctor check', () => {
    const v = buildView(
      input({
        codeDir: '/elsewhere/code',
        doctor: [{ slot: 1, at: minutesAgo(60), failed: ['pnpm install'] }],
      }),
    );
    expect(v.health.problems.map((p) => p.fix)).toEqual([
      'task factory:install',
      'task factory:doctor -- --slot 1',
    ]);
    // A few words each, for the header's one pill.
    expect(v.health.problems.map((p) => p.label)).toEqual([
      'wrong checkout',
      'doctor failing on slot 1',
    ]);
    expect(v.health.doctor).toBe('doctor failing');
  });
});

describe("the plan's open points, asked once each", () => {
  const q = (text: string, ...options: string[]) => ({ text, options });

  it('pairs each question with its open point when the planner wrote both lists', () => {
    expect(card(view, 'PEN-78').points).toEqual([
      {
        text: 'Include attachments?',
        context: 'Proposed: attachments go in the zip beside their notes. OK?',
        options: [
          {
            value: 'Yes, beside their notes (proposed)',
            label: 'Yes, beside their notes',
            proposed: true,
          },
          { value: 'No', label: 'No', proposed: false },
        ],
      },
      {
        text: 'One zip or one per folder?',
        context: 'Proposed: one zip for the whole library, with its folders kept. OK?',
        options: [
          {
            value: 'One zip, folders kept (proposed)',
            label: 'One zip, folders kept',
            proposed: true,
          },
          { value: 'One zip per folder', label: 'One zip per folder', proposed: false },
        ],
      },
    ]);
    expect(card(view, 'PEN-78').notes).toEqual([]);
  });

  it('takes the first option as the proposal when none is marked', () => {
    expect(
      pointsOf(['A?'], [q('A?', 'Yes', 'No')]).points[0]?.options.map((o) => o.proposed),
    ).toEqual([true, false]);
  });

  it('asks a point with no options as a question of its own, when the rest repeat their points', () => {
    expect(
      pointsOf(['Include attachments?', 'Zip name?'], [q('Include attachments?', 'Yes', 'No')]),
    ).toEqual({
      points: [
        expect.objectContaining({ text: 'Include attachments?', context: null }),
        { text: 'Zip name?', context: null, options: [] },
      ],
      notes: [],
    });
  });

  it("shows points it can't pair once, as notes, rather than twice", () => {
    const { points, notes } = pointsOf(
      ['Proposed: attachments beside notes. OK?', 'Proposed: one zip. OK?'],
      [q('Include attachments?', 'Yes', 'No')],
    );
    expect(points.map((p) => [p.text, p.context])).toEqual([['Include attachments?', null]]);
    expect(notes).toEqual(['Proposed: attachments beside notes. OK?', 'Proposed: one zip. OK?']);
  });
});

describe('the pipeline (A1233)', () => {
  it("puts each card on its lifecycle step, with its marker's tone", () => {
    const at = (key: string) => [view.stages[card(view, key).stage], card(view, key).tone];
    expect(at('PEN-84')).toEqual(['Todo', 'card']);
    expect(at('PEN-78')).toEqual(['Plan', 'you']);
    expect(at('PEN-79')).toEqual(['Build', 'live']);
    expect(at('PEN-75')).toEqual(['Build', 'you']);
    expect(at('PEN-77')).toEqual(['Proof', 'you']);
    expect(at('PEN-73')).toEqual(['PR + CI', 'stop']);
    expect(at('PEN-74')).toEqual(['Review', 'you']);
    expect(at('PEN-72')).toEqual(['Done', 'done']);
  });

  it('groups the rest: working, the queue in pickup order, done recently', () => {
    const group = (g: string) => view.cards.filter((c) => c.group === g).map((c) => c.key);
    expect(group('working')).toEqual(['PEN-79', 'PEN-76']);
    expect(group('queue')).toEqual(['PEN-80', 'PEN-82']);
    expect(group('done')).toEqual(['PEN-72']);
    expect(card(view, 'PEN-80').step).toBe('Next when a slot frees · plans first');
    expect(view.cards.some((c) => c.key === 'PEN-90')).toBe(false);
  });

  it('says why CI stopped it, and what to do', () => {
    expect(card(view, 'PEN-73').step).toBe('CI stayed red after 2 repair rounds: android-emulator');
    expect(card(view, 'PEN-74').need?.brief).toBe('Review PR #65');
    expect(card(view, 'PEN-74').need?.what).toContain('Approve it on GitHub');
    expect(card(view, 'PEN-78').questions).toHaveLength(2);
    expect(card(view, 'PEN-78').canComplete).toBe(true);
    expect(card(view, 'PEN-84').need?.brief).toContain(
      'conflicting labels agent:claude and agent:opencode',
    );
  });

  it('says in one line what each card needs, and what to do next without repeating it', () => {
    expect(view.needs.map((c) => [c.key, c.need?.brief])).toEqual([
      ['PEN-73', 'CI stayed red after 2 repair rounds: android-emulator'],
      ['PEN-75', 'Failed before the agent started: claude: command not found (exit 127)'],
      ['PEN-74', 'Review PR #65'],
      ['PEN-78', 'Answer 2 questions on the plan'],
      ['PEN-77', "Waiting: the VM penmoss-test isn't made"],
      ['PEN-84', "Won't start: conflicting labels agent:claude and agent:opencode"],
    ]);
    expect(card(view, 'PEN-73').need?.what).toBe('Fix it or say how on the issue, then retry.');
    expect(card(view, 'PEN-75').need?.what).toBe('Fix it on the Mac, then retry.');
    // A stop of two clauses: the first is the brief, the second leads what to do.
    const v = buildView(
      input({
        board: {
          items: [
            pen(22, {
              status: 'In Progress',
              labels: ['Blocked'],
              blocked: true,
              blockedSet: true,
            }),
          ],
        },
        ledger: [
          line('22-a', 'claimed', minutesAgo(30), { issue: 22 }),
          line('22-a', 'gate-failed', minutesAgo(20), { round: 0 }),
          line('22-a', 'blocked', minutesAgo(10), { reason: 'gate-failed' }),
        ].join('\n'),
      }),
    );
    expect(card(v, 'PEN-22').need).toMatchObject({
      brief: 'The gate still failed after 1 round',
      what: 'The checks that failed are on the issue. Fix it or say how on the issue, then retry.',
    });
  });

  it('links the issue, PR, CI, the plan, the chat and the desktop app', () => {
    expect(card(view, 'PEN-74').links.map((l) => l.label)).toEqual(['PEN-74', 'PR #65', 'CI']);
    // A planning card's chat is beside the reply, not among the links (A1281).
    expect(card(view, 'PEN-76').links.map((l) => l.href)).toEqual([
      'https://linear.app/penmoss/issue/PEN-76/card-76',
    ]);
    expect(card(view, 'PEN-76').chat).toBe('claude attach S76abcde');
    expect(card(view, 'PEN-74').chat).toBeNull();
    // Its Claude app chat, when Remote Control gave the session one (A1286).
    expect(card(view, 'PEN-76').chatUrl).toBeNull();
    expect(card(view, 'PEN-78').chatUrl).toBe('https://claude.ai/code/session_S78');
    expect(card(view, 'PEN-74').chatUrl).toBeNull();
    expect(chatLink('https://evil.example/code/session_x')).toBeNull();
    expect(chatLink('https://claude.ai/code/session_x/../y')).toBeNull();
    expect(chatLink(undefined)).toBeNull();
  });

  it('keeps Done cards for doneDays only', () => {
    const v = buildView(
      input({
        board: {
          items: [
            pen(14, { status: 'Done', state: 'CLOSED' }),
            pen(15, { status: 'Done', state: 'CLOSED' }),
          ],
        },
        // 14: reviewed 5 weeks ago; 15: Done but never the factory's.
        ledger: [
          line('14-a', 'claimed', '2026-10-01T15:00:00Z', { issue: 14 }),
          line('14-a', 'in-review', '2026-10-01T15:30:00Z'),
        ].join('\n'),
      }),
    );
    expect(v.cards).toEqual([]);
  });

  it("works on GitHub's statuses too", () => {
    const v = buildView(
      input({
        config: testConfig(),
        board: {
          items: [item(11, { status: 'In progress' }), item(12, { status: 'In progress' })],
        },
        ledger: line('11-a', 'claimed', minutesAgo(5), { issue: 11 }),
        status: null,
      }),
    );
    expect(v.cards.map((c) => c.key)).toEqual(['#11']);
    expect(v.outside).toEqual(['#12']);
  });
});

describe("today's slots (A1233)", () => {
  it('draws each run on its slot, coloured by how it ended', () => {
    const lane = (slot: number) =>
      view.timeline.lanes.find((l) => l.slot === slot)?.bars.map((b) => [b.key, b.tone]);
    expect(lane(1)).toEqual([
      ['PEN-72', 'done'],
      ['PEN-75', 'stop'],
      ['PEN-84', 'stop'],
      ['PEN-79', 'live'],
    ]);
    expect(lane(2)).toEqual([
      ['PEN-73', 'stop'],
      ['PEN-74', 'done'],
      ['PEN-77', 'you'],
    ]);
  });

  it('totals the window', () => {
    expect(view.totals).toEqual({ started: 7, inReview: 2, merged: 0, blocked: 3 });
  });
});

describe('the state folder (A1233)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-ui-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('builds the view from runs.jsonl, status.json, the plans, the doctor and the run log', () => {
    const e = evening(dir);
    writeEvening(dir, e);
    const v = viewFromState(e.config, e.board, {
      busy: new Set(),
      alive: () => true,
      now: NOW,
      writable: false,
      readOnly: 'no Linear key',
    });
    expect(v.needs.map((c) => c.key)).toEqual(view.needs.map((c) => c.key));
    expect(card(v, 'PEN-79').log).toEqual([
      'Reading the relay handler',
      'Adding Retry-After to the 429 path',
    ]);
    expect(card(v, 'PEN-79').runFolder).toBe(join(dir, 'runs', '79-d'));
    expect(card(v, 'PEN-78').questions).toHaveLength(2);
    expect(v.health.doctor).toMatch(/^doctor passed /);
    expect(v.readOnly).toBe('no Linear key');
  });

  it('reads only the end of a long log, colours stripped', () => {
    const file = join(dir, 'long.log');
    writeFileSync(file, `${'x'.repeat(200_000)}\n\u001b[1mlast\u001b[0m line\n`);
    expect(tailFile(file, 1)).toEqual(['last line']);
    expect(tailFile(join(dir, 'missing.log'))).toEqual([]);
  });
});

describe('the server (F20)', () => {
  const token = 'a'.repeat(48);
  const empty: FactoryView = buildView({
    config: testConfig(),
    board: { items: [] },
    ledger: '',
    plans: {},
    busySessions: new Set(),
    status: null,
    alive: () => false,
    now: NOW,
  });
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
    // A page that moves on by itself, not a redirect: see the cross-site link check in e2e.
    expect(first.status).toBe(200);
    expect(first.body).toContain('location.replace("/" + location.hash)');
    expect(first.body).not.toContain(token);
    expect(String(first.headers['set-cookie'])).toContain('HttpOnly; SameSite=Strict');
    // A year, so a device signs in once: the token survives restarts (A1264).
    expect(String(first.headers['set-cookie'])).toContain('Max-Age=31536000');
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

describe("the UI's token (A1264)", () => {
  it('is kept in the state folder, mode 600, so the link is the same after a restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ui-token-'));
    try {
      const first = uiToken(dir);
      expect(first).toMatch(/^[0-9a-f]{48}$/);
      expect(uiToken(dir)).toBe(first);
      expect(statSync(uiTokenPath(dir)).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('makes a new one when the kept one is missing or not a token', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ui-token-'));
    try {
      writeFileSync(uiTokenPath(dir), 'short\n');
      const made = uiToken(dir);
      expect(made).toMatch(/^[0-9a-f]{48}$/);
      expect(readFileSync(uiTokenPath(dir), 'utf8').trim()).toBe(made);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
