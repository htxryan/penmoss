import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildView } from '../src/ui/model.ts';
import { chatLink } from '../src/ui/card.ts';
import type { FactoryView } from '../src/ui/view.ts';
import { uiToken, uiTokenPath } from '../src/ui/link.ts';
import { tailFile, viewFromState } from '../src/ui/run.ts';
import { createUiServer, listen } from '../src/ui/server.ts';
import { pageHtml } from '../src/ui/page.ts';
import { item, testConfig } from './helpers.ts';
import {
  evening,
  line,
  NOW,
  pen,
  writeEvening,
  base,
  input,
  view,
  card,
  minutesAgo,
} from './ui-fixture.ts';

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
    // Nothing in the ledger says who set Blocked, so the card doesn't say it was Ryan (A1377).
    expect([card(v, 'PEN-20').group, card(v, 'PEN-20').step]).toEqual(['queue', 'Blocked']);
  });

  it('says Paused by you only when the ledger says Ryan stopped it (A1377)', () => {
    const v = buildView(
      input({
        board: {
          items: [
            pen(20, { status: 'In Review', labels: ['Blocked'], blocked: true, blockedSet: true }),
          ],
        },
        ledger: [
          line('20-a', 'claimed', minutesAgo(50), { issue: 20 }),
          line('20-a', 'failed', minutesAgo(40), {
            stopped: 'Blocked set by Ryan: stopped before a push',
          }),
        ].join('\n'),
        status: null,
      }),
    );
    expect(card(v, 'PEN-20').step).toBe('Paused by you');
  });

  it("says why a rebase onto main stopped, and asks for a retry, not Ryan's pause (A1377)", () => {
    const v = buildView(
      input({
        board: {
          items: [
            pen(59, { status: 'In Review', labels: ['Blocked'], blocked: true, blockedSet: true }),
          ],
        },
        ledger: [
          line('59-a', 'claimed', minutesAgo(90), { issue: 59 }),
          line('59-a', 'in-review', minutesAgo(80), {
            pr: 'https://github.com/htxryan/penmoss/pull/188',
          }),
          line('59-b', 'claimed', minutesAgo(6), { issue: 59, phase: 'rebase' }),
          line('59-b', 'failed', minutesAgo(6), {
            error:
              "git fetch failed: error: cannot lock ref 'refs/remotes/origin/main': is at 5545ce3 but expected a48dcfe",
          }),
        ].join('\n'),
        status: null,
      }),
    );
    const c = card(v, 'PEN-59');
    expect(c.step).toMatch(/^Rebasing onto main stopped: git fetch failed/);
    expect(c.step).not.toContain('Paused by you');
    expect(v.needs.map((n) => n.key)).toContain(c.key);
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
    // Cards without the factory label aren't the factory's, wherever they wait.
    expect(view.cards.some((c) => c.key === 'PEN-91' || c.key === 'PEN-92')).toBe(false);
  });

  it('says a validation mismatch sent the work back, not that the gate failed', () => {
    const v = buildView(
      input({
        ledger: `${base.ledger}\n${line('79-d', 'validation-mismatch', minutesAgo(1), { round: 0, criteria: ['AC1', 'AC3'] })}`,
      }),
    );
    expect(card(v, 'PEN-79').step).toBe(
      'Validation: 2 criteria not met (AC1, AC3); fix round 2 of 3',
    );
    // On validation's step, where its `validated` puts a card, not back on the gate's.
    expect(card(v, 'PEN-79').stage).toBe(4);
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

  it("says when CI is re-run, or stopped, on the runners' infrastructure (A1312)", () => {
    const board = (blocked: boolean) => ({
      items: [
        pen(23, {
          status: 'In Progress',
          ...(blocked ? { labels: ['Blocked'], blocked: true, blockedSet: true } : {}),
        }),
      ],
    });
    const rerun = line('23-a', 'ci-rerun', minutesAgo(20), {
      actionsRun: '88',
      signature: 'Temporary failure resolving',
    });
    const claimed = line('23-a', 'claimed', minutesAgo(30), { issue: 23 });
    const live = buildView(
      input({
        board: board(false),
        ledger: [claimed, rerun].join('\n'),
        status: {
          ...base.status,
          running: [{ issue: 23, slot: 1, startedAt: minutesAgo(30), why: 'picked' }],
        },
      }),
    );
    expect(card(live, 'PEN-23').step).toBe(
      "CI re-run: the runners' infrastructure failed (Temporary failure resolving)",
    );
    const stopped = buildView(
      input({
        board: board(true),
        ledger: [
          claimed,
          rerun,
          line('23-a', 'blocked', minutesAgo(10), { reason: 'ci-infra' }),
        ].join('\n'),
      }),
    );
    expect(card(stopped, 'PEN-23').need?.brief).toBe(
      "CI failed on the runners' infrastructure, not the branch (Temporary failure resolving)",
    );
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

  it("links a running card to its agent session's chat in the Claude app (A1287)", () => {
    const v = buildView(input({ runChat: () => 'https://claude.ai/code/session_R79' }));
    expect(card(v, 'PEN-79').chatUrl).toBe('https://claude.ai/code/session_R79');
    // Only a card with a live run: the link goes when the session ends.
    expect(card(v, 'PEN-74').chatUrl).toBeNull();
    const bad = buildView(input({ runChat: () => 'https://evil.example/code/session_x' }));
    expect(card(bad, 'PEN-79').chatUrl).toBeNull();
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
