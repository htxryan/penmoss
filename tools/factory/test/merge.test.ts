import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CheckRun } from '../src/checks.ts';
import type { IssueSpec } from '../src/labels.ts';
import {
  ciRunsFor,
  mergeApproved,
  newestDescendantRun,
  type MainRun,
  type MergeDeps,
  type RunJob,
} from '../src/merge.ts';
import type { Gh } from '../src/github.ts';
import type { Factory } from '../src/start.ts';
import { findPr, nextReviewAction, roundPrompt } from '../src/watch.ts';
import { item, testConfig } from './helpers.ts';

const config = testConfig();
const green: CheckRun = {
  name: 'Check',
  state: 'SUCCESS',
  bucket: 'pass',
  link: 'l',
  startedAt: '2026-11-07T12:00:00Z',
};
const card = item(5, { status: 'In review' });

function fake(
  checks: CheckRun[],
  mains: MainRun[][],
  options: {
    merged?: string;
    runsCi?: boolean;
    jobs?: RunJob[][];
    /** What each look for a newer run on main finds, in order (A1315). */
    newer?: (MainRun | undefined)[];
  } = {},
) {
  const calls: string[] = [];
  let clock = Date.parse('2026-11-07T12:00:00Z');
  const deps: MergeDeps = {
    config,
    runId: 'm1',
    checks: () => Promise.resolve(checks),
    mergedSha: () => Promise.resolve(options.merged),
    merge: () => {
      calls.push('merge');
      return Promise.resolve('abcdef1234567890');
    },
    mainRuns: () => Promise.resolve(mains.shift() ?? []),
    mainRunsCi: () => Promise.resolve(options.runsCi ?? true),
    runJobs: () =>
      Promise.resolve(options.jobs?.shift() ?? [{ name: 'Check', conclusion: 'failure' }]),
    rerun: (r) => {
      calls.push(`rerun ${r.url}`);
      return Promise.resolve();
    },
    ...(options.newer
      ? {
          newerMainRun: (sha: string, r: MainRun) => {
            calls.push(`newer than ${r.url} on ${sha.slice(0, 6)}`);
            return Promise.resolve(options.newer!.shift());
          },
        }
      : {}),
    comment: (_n, body) => {
      calls.push(`comment ${body.split('\n')[0]}`);
      return Promise.resolve();
    },
    closeIssue: () => {
      calls.push('close');
      return Promise.resolve();
    },
    setStatus: (_i, s) => {
      calls.push(`status ${s}`);
      return Promise.resolve();
    },
    setBlocked: () => {
      calls.push('blocked');
      return Promise.resolve();
    },
    notify: () => Promise.resolve(),
    sleep: () => Promise.resolve(),
    now: () => new Date((clock += 60_000)),
    log: () => undefined,
  };
  return { deps, calls };
}

describe('mergeApproved', () => {
  it('merges, waits for main, then closes the issue and moves the card to Done', async () => {
    const f = fake(
      [green],
      [
        [],
        [{ status: 'in_progress', conclusion: null, url: 'r1' }],
        [{ status: 'completed', conclusion: 'success', url: 'r1' }],
      ],
    );
    expect(await mergeApproved(f.deps, card, 'pr')).toEqual({
      kind: 'done',
      sha: 'abcdef1234567890',
    });
    expect(f.calls).toEqual([
      'merge',
      "comment Merged pr as abcdef1234. Watching main's CI.",
      'close',
      'status Done',
    ]);
  });
  it("doesn't merge while CI isn't green", async () => {
    const f = fake([{ ...green, bucket: 'pending', state: 'IN_PROGRESS' }], []);
    expect((await mergeApproved(f.deps, card, 'pr')).kind).toBe('not-yet');
    expect(f.calls).toEqual([]);
  });
  it('sets Blocked when main goes red after the merge, naming the failed jobs', async () => {
    const f = fake([green], [[{ status: 'completed', conclusion: 'failure', url: 'r9' }]], {
      jobs: [
        [
          { name: 'E2E smoke', conclusion: 'failure' },
          { name: 'Build', conclusion: 'success' },
          { name: 'Check', conclusion: 'cancelled' },
        ],
      ],
    });
    expect(await mergeApproved(f.deps, card, 'pr')).toEqual({
      kind: 'blocked',
      reason: "main's CI failed after the merge: r9 (E2E smoke, Check)",
    });
    expect(f.calls.slice(-1)).toEqual(['blocked']);
    expect(f.calls).not.toContain('status Done');
  });
  it('picks up an already merged PR after a restart, without merging again (R12)', async () => {
    const f = fake([], [[{ status: 'completed', conclusion: 'success', url: 'r1' }]], {
      merged: '1234567890abcdef',
    });
    expect(await mergeApproved(f.deps, card, 'pr')).toEqual({
      kind: 'done',
      sha: '1234567890abcdef',
    });
    expect(f.calls).not.toContain('merge');
    expect(f.calls.slice(-2)).toEqual(['close', 'status Done']);
  });
  it('is Done for a change main runs no CI for, instead of Blocked an hour later (A1095)', async () => {
    const f = fake([green], [[], []], { runsCi: false });
    expect((await mergeApproved(f.deps, card, 'pr')).kind).toBe('done');
    expect(f.calls).not.toContain('blocked');
    expect(f.calls.slice(-1)).toEqual(['status Done']);
  });
  it('starts a run GitHub failed with no jobs again once, instead of Blocking on it', async () => {
    const failed: MainRun = { status: 'completed', conclusion: 'failure', url: 'r3' };
    const f = fake(
      [green],
      [
        [failed],
        [{ status: 'in_progress', conclusion: null, url: 'r3' }],
        [{ ...failed, conclusion: 'success' }],
      ],
      { jobs: [[]] },
    );
    expect((await mergeApproved(f.deps, card, 'pr')).kind).toBe('done');
    expect(f.calls).toContain('rerun r3');
    expect(f.calls).not.toContain('blocked');
  });
  it('Blocks when the restarted run fails with no jobs again', async () => {
    const failed: MainRun = { status: 'completed', conclusion: 'failure', url: 'r3' };
    const f = fake([green], [[failed], [failed]], { jobs: [[], []] });
    expect(await mergeApproved(f.deps, card, 'pr')).toEqual({
      kind: 'blocked',
      reason: "main's CI failed after the merge: r3 (no jobs started, twice)",
    });
    expect(f.calls.filter((c) => c.startsWith('rerun'))).toEqual(['rerun r3']);
  });
  it('still Blocks when main should have run CI and none started', async () => {
    const f = fake([green], [], { runsCi: true });
    expect((await mergeApproved(f.deps, card, 'pr')).kind).toBe('blocked');
  });

  describe('a job a newer merge cancelled (A1315)', () => {
    // PEN-63's merge (d1085ac): two minutes later another merge's run took the release jobs'
    // concurrency group and cancelled d1085ac's "Mac app dmg (on Ryan's Mac)".
    const cancelled: MainRun = {
      status: 'completed',
      conclusion: 'cancelled',
      url: 'r1',
      workflowName: 'CI',
    };
    const jobs: RunJob[] = [
      { name: 'Check', conclusion: 'success' },
      { name: "Mac app dmg (on Ryan's Mac)", conclusion: 'cancelled' },
      { name: 'Mac release', conclusion: 'skipped' },
    ];
    const newer = (o: Partial<MainRun>): MainRun => ({
      status: 'completed',
      conclusion: 'success',
      url: 'r2',
      ...o,
    });

    it('waits for the newer run on main and is Done when it passes', async () => {
      const f = fake([green], [[cancelled], [cancelled]], {
        jobs: [jobs, jobs],
        newer: [newer({ status: 'in_progress', conclusion: null }), newer({})],
      });
      const outcome = await mergeApproved(f.deps, card, 'pr');
      expect(outcome).toEqual({ kind: 'done', sha: 'abcdef1234567890' });
      expect(f.calls).toContain('newer than r1 on abcdef');
      expect(f.calls).not.toContain('blocked');
      expect(f.calls.slice(-2)).toEqual(['close', 'status Done']);
    });

    it('Blocks naming the newer run when it fails', async () => {
      const f = fake([green], [[cancelled]], {
        jobs: [jobs, [{ name: 'E2E smoke', conclusion: 'failure' }]],
        newer: [newer({ conclusion: 'failure' })],
      });
      expect(await mergeApproved(f.deps, card, 'pr')).toEqual({
        kind: 'blocked',
        reason: "main's CI failed after the merge: r2 (E2E smoke)",
      });
    });

    it('still Blocks on a cancelled job when main has no newer run', async () => {
      const f = fake([green], [[cancelled]], { jobs: [jobs], newer: [undefined] });
      expect(await mergeApproved(f.deps, card, 'pr')).toEqual({
        kind: 'blocked',
        reason: "main's CI failed after the merge: r1 (Mac app dmg (on Ryan's Mac))",
      });
    });

    it("doesn't look for a newer run when a job failed, not only cancelled", async () => {
      const f = fake([green], [[cancelled]], {
        jobs: [[...jobs, { name: 'E2E smoke', conclusion: 'failure' }]],
        newer: [newer({})],
      });
      expect((await mergeApproved(f.deps, card, 'pr')).kind).toBe('blocked');
      expect(f.calls.some((c) => c.startsWith('newer'))).toBe(false);
    });

    it("finds main's newest run of the workflow on a commit that descends from the merge", async () => {
      const at = (min: number) => `2026-11-11T10:${String(min).padStart(2, '0')}:00Z`;
      const ours: MainRun = { ...cancelled, headSha: 'd1085ac', createdAt: at(0) };
      const runs: MainRun[] = [
        newer({ url: 'r4', headSha: 'f00', createdAt: at(9), workflowName: 'Deploy' }),
        newer({ url: 'r3', headSha: 'e33', createdAt: at(5), workflowName: 'CI' }),
        newer({ url: 'r2', headSha: 'c22', createdAt: at(2), workflowName: 'CI' }),
        ours,
        // Started with ours, before it: never newer.
        newer({ url: 'r0', headSha: 'b00', createdAt: at(0), workflowName: 'CI' }),
      ];
      // r3's commit is on another history (a force-push); r2's descends from d1085ac.
      const ahead = (base: string, head: string) =>
        Promise.resolve(base === 'd1085ac' && head === 'c22');
      expect((await newestDescendantRun(runs, 'd1085ac', ours, ahead))?.url).toBe('r2');
      expect(await newestDescendantRun(runs, 'd1085ac', ours, () => Promise.resolve(false))).toBe(
        undefined,
      );
    });
  });
});

describe('nextReviewAction', () => {
  it("finishes a PR that was merged while the daemon was away, so the card can't stay In review (R12)", async () => {
    const gh: Gh = {
      run: () => Promise.reject(new Error('unused')),
      json: () => Promise.reject(new Error('unused')),
      graphql: () => Promise.reject(new Error('a merged PR needs no conversation')),
    };
    const factory = { config, gh } as unknown as Factory;
    const merged = { number: 9, url: 'https://github.com/htxryan/penmoss/pull/9' } as const;
    expect(await nextReviewAction(factory, { ...merged, state: 'MERGED' }, new Date())).toEqual({
      kind: 'merge',
    });
    expect((await nextReviewAction(factory, { ...merged, state: 'CLOSED' }, new Date())).kind).toBe(
      'none',
    );
  });

  it('rebases an approved, green PR that main has moved past, instead of merging it (F6)', async () => {
    const conversation = {
      repository: {
        pullRequest: {
          createdAt: '2026-11-08T10:00:00Z',
          reviewThreads: { nodes: [] },
          reviews: {
            nodes: [
              {
                state: 'APPROVED',
                body: '',
                submittedAt: '2026-11-08T11:00:00Z',
                author: { login: config.owner },
              },
            ],
          },
          comments: { nodes: [] },
        },
      },
    };
    const gh: Gh = {
      run: () => Promise.reject(new Error('unused')),
      json: <T>() => Promise.resolve([green] as T),
      graphql: <T>() => Promise.resolve(conversation as T),
    };
    const factory = { config, gh } as unknown as Factory;
    const open = {
      number: 9,
      url: 'https://github.com/htxryan/penmoss/pull/9',
      state: 'OPEN',
    } as const;
    const now = new Date('2026-11-08T12:00:00Z');
    expect(await nextReviewAction(factory, { ...open, mergeable: 'CONFLICTING' }, now)).toEqual({
      kind: 'rebase',
    });
    expect(await nextReviewAction(factory, { ...open, mergeStateStatus: 'BEHIND' }, now)).toEqual({
      kind: 'rebase',
    });
    // Still being worked out by GitHub, or clean: merge as before.
    expect(await nextReviewAction(factory, { ...open, mergeable: 'UNKNOWN' }, now)).toEqual({
      kind: 'merge',
    });
    expect(
      await nextReviewAction(
        factory,
        { ...open, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' },
        now,
      ),
    ).toEqual({ kind: 'merge' });
  });

  it("asks GitHub whether the factory's PR still merges into main", async () => {
    const asked: string[][] = [];
    const gh: Gh = {
      run: () => Promise.reject(new Error('unused')),
      json: <T>(args: readonly string[]) => {
        asked.push([...args]);
        return Promise.resolve([] as T);
      },
      graphql: () => Promise.reject(new Error('unused')),
    };
    await findPr({ config, gh } as unknown as Factory, card);
    expect(asked[0]?.at(-1)).toBe('number,url,state,mergeable,mergeStateStatus');
  });
});

describe("ciRunsFor (ci.yml's push paths, A1095)", () => {
  const ci = readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8');
  it('reads the workflow on main: docs, the site and Markdown run nothing', () => {
    expect(ciRunsFor(ci, ['docs/factory.md'])).toBe(false);
    expect(ciRunsFor(ci, ['site/src/content/docs/docs/index.md', 'README.md'])).toBe(false);
    expect(ciRunsFor(ci, ['.claude/settings.json', 'prototype/a.html'])).toBe(false);
  });
  it('runs for code, and for Markdown under a test folder', () => {
    expect(ciRunsFor(ci, ['docs/factory.md', 'tools/factory/src/merge.ts'])).toBe(true);
    expect(ciRunsFor(ci, ['packages/codec/test/fixtures/a.md'])).toBe(true);
    expect(ciRunsFor(ci, ['test/a.md'])).toBe(true);
  });
  it('assumes CI runs when it finds no push paths, or no files', () => {
    expect(ciRunsFor('on:\n  push:\n    branches: [main]\n', ['docs/a.md'])).toBe(true);
    expect(ciRunsFor(ci, [])).toBe(true);
  });
});

describe('the prompt a review, rebase or CI round starts from', () => {
  const spec = (planSkip: boolean): IssueSpec => ({
    agent: 'claude',
    modelAlias: 'opus',
    model: 'opus',
    planSkip,
    platforms: null,
    priority: 3,
  });
  it('fills the plan, which it lacked, so every round threw before the agent started', () => {
    const c = { ...config, stateDir: mkdtempSync(join(tmpdir(), 'round-')) };
    const skipped = roundPrompt(c, card, spec(true), '# PEN-5 Fix it');
    expect(skipped).toContain('# PEN-5 Fix it');
    expect(skipped).toContain('so the issue is the spec');
    expect(skipped).toContain('There are no `platform:*` labels');
    // A planned card whose plan copy has gone still gets its round.
    expect(roundPrompt(c, card, spec(false), '# PEN-5')).toContain('None kept');
  });
});
