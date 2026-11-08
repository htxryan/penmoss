import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BoardItem } from '../src/board.ts';
import type { Issue } from '../src/issue.ts';
import { advancePlanning, type PlanDeps } from '../src/plan-run.ts';
import { readMeta, writeMeta, type PlanFiles } from '../src/planning-host.ts';
import { item, testConfig } from './helpers.ts';

const config = testConfig();
const T0 = new Date('2026-11-07T12:00:00Z');

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'plan-'));
  const files: PlanFiles = {
    root,
    repo: join(root, 'repo'),
    out: join(root, 'out'),
    meta: join(root, 'meta.json'),
  };
  mkdirSync(files.out, { recursive: true });
  const calls: string[] = [];
  let now = T0;
  let busy = false;
  const did = (call: string) => {
    calls.push(call);
    return Promise.resolve();
  };
  const deps: PlanDeps = {
    comment: (_n, body) => did(`comment ${body.split('\n')[0]}`),
    setStatus: (_i, s) => did(`status ${s}`),
    setBlocked: () => did('blocked'),
    snapshot: () => did('snapshot'),
    launch: (message, resume) =>
      did(resume ? `resume ${message.split('\n')[0]}` : 'start').then(() => ({
        sessionId: 'S1',
        chatUrl: 'https://claude.ai/code/session_1',
      })),
    stop: () => did('stop'),
    session: () => Promise.resolve({ busy }),
    now: () => now,
  };
  const state = (status: string, at: Date, extra: object = {}) => {
    const path = join(files.out, 'state.json');
    writeFileSync(
      path,
      JSON.stringify({
        status,
        planUrl: 'https://claude.ai/artifact/p',
        designUrl: null,
        open: ['Sheet on phones?'],
        agreed: null,
        ...extra,
      }),
    );
    utimesSync(path, at, at);
  };
  return {
    files,
    calls,
    deps,
    state,
    at: (d: Date) => (now = d),
    setBusy: (b: boolean) => (busy = b),
  };
}

const issue = (comments: Issue['comments'] = []): Issue => ({
  number: 5,
  title: 'X',
  body: 'b',
  author: 'htxryan',
  url: 'u',
  labels: [],
  comments,
});
const min = (n: number) => new Date(T0.getTime() + n * 60_000);
const input = (files: PlanFiles, card: BoardItem, i = issue()) => ({
  config,
  item: card,
  issue: i,
  files,
  prompt: 'plan it',
});

describe('advancePlanning', () => {
  it('moves a Ready card to Planning, starts the session and posts the chat link', async () => {
    const t = setup();
    expect((await advancePlanning(t.deps, input(t.files, item(5)))).kind).toBe('start');
    expect(t.calls).toEqual([
      'status Planning',
      'snapshot',
      'start',
      expect.stringMatching(/^comment Planning has started/),
    ]);
    expect(readMeta(t.files)).toMatchObject({ sessionId: 'S1', messagedAt: T0.toISOString() });
  });

  it('posts the open points once, sets Blocked and stops the session', async () => {
    const t = setup();
    const card = item(5, { status: 'Planning' });
    await advancePlanning(t.deps, input(t.files, card));
    t.state('waiting', min(3));
    t.at(min(4));
    expect((await advancePlanning(t.deps, input(t.files, card))).kind).toBe('ask');
    expect(t.calls.slice(-3)).toEqual(['comment The plan has open points:', 'blocked', 'stop']);
    // Still Blocked: nothing more happens.
    t.calls.length = 0;
    await advancePlanning(t.deps, input(t.files, { ...card, blocked: true }));
    expect(t.calls).toEqual([]);
  });

  it('resumes with what Ryan wrote once he clears Blocked, and waits for a fresh state', async () => {
    const t = setup();
    const card = item(5, { status: 'Planning' });
    await advancePlanning(t.deps, input(t.files, card));
    t.state('waiting', min(3));
    t.at(min(4));
    await advancePlanning(t.deps, input(t.files, card));
    t.at(min(9));
    const answered = issue([
      { author: 'htxryan', body: 'A sheet, yes', createdAt: min(8).toISOString() },
    ]);
    expect(await advancePlanning(t.deps, input(t.files, card, answered))).toEqual({
      kind: 'resume',
      comments: ['A sheet, yes'],
    });
    expect(t.calls.at(-1)).toBe('resume Ryan commented on the issue:');
    // The old state isn't asked about again; the comment isn't delivered twice.
    t.at(min(10));
    expect((await advancePlanning(t.deps, input(t.files, card, answered))).kind).toBe('wait');
  });

  it('ignores comments from anyone but Ryan, and the factory’s own', async () => {
    const t = setup();
    const card = item(5, { status: 'Planning' });
    await advancePlanning(t.deps, input(t.files, card));
    const others = issue([
      { author: 'mallory', body: 'complete', createdAt: min(2).toISOString() },
      {
        author: 'htxryan',
        body: 'complete <!-- penmoss-factory x=y -->',
        createdAt: min(2).toISOString(),
      },
    ]);
    t.at(min(3));
    expect((await advancePlanning(t.deps, input(t.files, card, others))).kind).toBe('wait');
  });

  it('records the agreed plan, stops the session and says implementation is next', async () => {
    const t = setup();
    const card = item(5, { status: 'Planning' });
    await advancePlanning(t.deps, input(t.files, card));
    writeFileSync(
      join(t.files.out, 'plan.html'),
      '<nav></nav><svg><rect/></svg><h2>Acceptance criteria</h2><p>When X, the app shall Y.</p>',
    );
    t.state('agreed', min(5), {
      agreed: { quote: 'complete', channel: 'chat', planVersion: 3, designVersion: null },
    });
    t.at(min(6));
    expect((await advancePlanning(t.deps, input(t.files, card))).kind).toBe('agreed');
    expect(t.calls.slice(-2)).toEqual([
      'stop',
      expect.stringMatching(/^comment The plan is agreed \("complete", in the chat\)/),
    ]);
    expect(readMeta(t.files).agreed).toMatchObject({ quote: 'complete', trivial: false });
  });

  it("won't agree without a saved plan.html", async () => {
    const t = setup();
    const card = item(5, { status: 'Planning' });
    await advancePlanning(t.deps, input(t.files, card));
    t.state('agreed', min(5), {
      agreed: { quote: 'go', channel: 'artifact', planVersion: 1, designVersion: null },
    });
    t.at(min(6));
    expect((await advancePlanning(t.deps, input(t.files, card))).kind).toBe('ask');
    expect(readMeta(t.files).agreed).toBeUndefined();
    expect(t.calls).toContain('blocked');
  });

  it('reports a session that went quiet without writing its state', async () => {
    const t = setup();
    const card = item(5, { status: 'Planning' });
    writeMeta(t.files, { sessionId: 'S1', messagedAt: T0.toISOString() });
    t.at(min(11));
    expect((await advancePlanning(t.deps, input(t.files, card))).kind).toBe('stuck');
    expect(t.calls).toEqual([
      expect.stringMatching(/^comment Planning stopped/),
      'blocked',
      'stop',
    ]);
  });

  it('waits while the session is busy', async () => {
    const t = setup();
    const card = item(5, { status: 'Planning' });
    writeMeta(t.files, { sessionId: 'S1', messagedAt: T0.toISOString() });
    t.setBusy(true);
    t.at(min(30));
    expect((await advancePlanning(t.deps, input(t.files, card))).kind).toBe('wait');
    expect(t.calls).toEqual([]);
  });
});

describe('the plan contract at agreement (F16)', () => {
  const contract = `<nav></nav><svg><rect/></svg><h2>Acceptance criteria</h2><p>When X, the app shall Y.</p>`;
  it('sends a plan that breaks the contract back to the session, then to Ryan', async () => {
    const t = setup();
    const card = item(5, { status: 'Planning' });
    await advancePlanning(t.deps, input(t.files, card));
    writeFileSync(join(t.files.out, 'plan.html'), '<h1>Plan</h1>');
    const agree = (at: Date) =>
      t.state('agreed', at, {
        agreed: { quote: 'complete', channel: 'chat', planVersion: 2, designVersion: null },
      });
    agree(min(2));
    t.at(min(3));
    expect((await advancePlanning(t.deps, input(t.files, card))).kind).toBe('resume');
    expect(t.calls.at(-1)).toMatch(
      /^resume Ryan agreed \("complete", in the chat\), but before the factory can build/,
    );
    agree(min(5));
    t.at(min(6));
    expect((await advancePlanning(t.deps, input(t.files, card))).kind).toBe('resume');
    agree(min(8));
    t.at(min(9));
    expect((await advancePlanning(t.deps, input(t.files, card))).kind).toBe('ask');
    expect(t.calls).toContain('blocked');
    expect(readMeta(t.files).agreed).toBeUndefined();
  });
  it('records the artifacts and versions Ryan agreed to', async () => {
    const t = setup();
    const card = item(5, { status: 'Planning' });
    await advancePlanning(t.deps, input(t.files, card));
    writeFileSync(join(t.files.out, 'plan.html'), contract);
    t.state('agreed', min(2), {
      designUrl: 'https://claude.ai/artifact/d',
      agreed: { quote: 'complete', channel: 'artifact', planVersion: 4, designVersion: 2 },
    });
    t.at(min(3));
    expect((await advancePlanning(t.deps, input(t.files, card))).kind).toBe('agreed');
    expect(t.calls.at(-1)).toMatch(/plan v4, design v2/);
    expect(readMeta(t.files).agreed).toMatchObject({
      planUrl: 'https://claude.ai/artifact/p',
      designUrl: 'https://claude.ai/artifact/d',
      planVersion: 4,
      designVersion: 2,
    });
  });
});
