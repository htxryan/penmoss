import { describe, expect, it } from 'vitest';
import type { CheckRun } from '../src/checks.ts';
import { ciHistory } from '../src/ci-failure.ts';
import { failedLogs } from '../src/run.ts';
import { ciRepairText, beforeRepairInReview } from '../src/watch.ts';
import { item, testConfig } from './helpers.ts';

const red: CheckRun = {
  name: 'Check',
  state: 'FAILURE',
  bucket: 'fail',
  link: 'https://github.com/htxryan/penmoss/actions/runs/77/job/1',
  startedAt: '2026-11-10T20:00:00Z',
};

describe('a repair round in review (F11)', () => {
  it("gives the agent each failed check's last log lines, not only its link (A1278)", async () => {
    const logs = await failedLogs(
      { failedLog: () => Promise.resolve('FAIL test/a.test.ts > b\nexpected 4 to be 3') },
      [red],
    );
    const text = ciRepairText('base', 'https://github.com/htxryan/penmoss/pull/113', [red], logs);
    expect(text).toContain(
      'these checks failed: Check (https://github.com/htxryan/penmoss/actions/runs/77/job/1)',
    );
    expect(text).toContain('### Check\n\n```\nFAIL test/a.test.ts > b\nexpected 4 to be 3\n```');
    expect(text).toContain('never by weakening or skipping tests');
    // A1314: never the workflows, and nothing for the runners' infrastructure.
    expect(text).toContain("can't push changes under `.github/workflows/`");
    expect(text).toContain("isn't this branch's to fix: change nothing");
  });
});

describe('a red check in review that is infrastructure (A1312)', () => {
  const card = item(73);
  const pr = 'https://github.com/htxryan/penmoss/pull/148';
  const apt = "Temporary failure resolving 'azure.archive.ubuntu.com'";
  const fakeDeps = (ledger = '') => {
    const calls: string[] = [];
    const comments: string[] = [];
    const deps = {
      config: testConfig(),
      runId: '73-r',
      rerunFailed: (run: string) => {
        calls.push(`rerun ${run}`);
        return Promise.resolve();
      },
      comment: (_n: number, body: string) => {
        comments.push(body);
        return Promise.resolve();
      },
      log: (event: string) => void calls.push(`log ${event}`),
      setBlocked: () => {
        calls.push('set blocked');
        return Promise.resolve();
      },
      ciHistory: (issue: number, url: string) => ciHistory(ledger, issue, url),
    };
    return { calls, comments, deps };
  };

  it('re-runs the failed jobs instead of a repair round', async () => {
    const f = fakeDeps();
    expect(await beforeRepairInReview(f.deps, card, pr, [red], [`### Check\n\n${apt}`])).toBe(
      'rerun',
    );
    expect(f.calls).toEqual(['rerun 77', 'log ci-rerun']);
    expect(f.comments[0]).toContain('re-running the failed jobs');
  });

  it('leaves a failure of the branch to the repair round', async () => {
    const f = fakeDeps();
    expect(
      await beforeRepairInReview(f.deps, card, pr, [red], ['expected 4 to be 3']),
    ).toBeUndefined();
    expect(f.calls).toEqual([]);
  });

  it('sets Blocked once the ledger has two re-runs of the run', async () => {
    const e = JSON.stringify({ at: 'x', run: '73-a', event: 'ci-rerun', actionsRun: '77', pr });
    const f = fakeDeps([e, e].join('\n'));
    expect(await beforeRepairInReview(f.deps, card, pr, [red], [apt])).toBe('blocked');
    expect(f.calls).toEqual(['log blocked', 'set blocked']);
    expect(f.comments[0]).toContain("CI failed on the runners' infrastructure");
  });

  it("sets Blocked, with no repair round, once the PR's repairs in any run reach rounds.ciRepair (A1313)", async () => {
    const repaired = (run: string, extra: object) =>
      JSON.stringify({ at: 'x', run, event: 'ci-repaired', ...extra });
    const f = fakeDeps(
      [
        repaired('73-a', { round: 1 }), // Before repairs named their PR.
        repaired('73-b', { pr, phase: 'review' }),
        repaired('73-c', { pr: 'https://github.com/htxryan/penmoss/pull/1' }),
      ].join('\n'),
    );
    expect(await beforeRepairInReview(f.deps, card, pr, [red], ['expected 4 to be 3'])).toBe(
      'blocked',
    );
    expect(f.calls).toEqual(['log blocked', 'set blocked']);
    expect(f.comments[0]).toContain('CI is still red after 2 repair round(s)');
    expect(f.comments[0]).toContain('expected 4 to be 3');
  });
});

describe('a red check in review that is a flaky test outside the branch (A-NEW-1)', () => {
  const card = item(117);
  const pr = 'https://github.com/htxryan/penmoss/pull/160';
  const check: CheckRun = { ...red, workflow: 'CI' };
  const log = '### Check\n\n```\n FAIL  test/notebook.test.ts > notebook > lists a folder\n```';
  const fakeDeps = (ledger = '', paths = ['apps/web/src/a.ts']) => {
    const calls: string[] = [];
    const comments: string[] = [];
    const deps = {
      config: testConfig(),
      runId: '117-r',
      rerunFailed: (run: string) => {
        calls.push(`rerun ${run}`);
        return Promise.resolve();
      },
      comment: (_n: number, body: string) => {
        comments.push(body);
        return Promise.resolve();
      },
      log: (event: string) => void calls.push(`log ${event}`),
      setBlocked: () => {
        calls.push('set blocked');
        return Promise.resolve();
      },
      ciHistory: (issue: number, url: string) => ciHistory(ledger, issue, url),
      diff: (branch: string) => {
        calls.push(`diff ${branch}`);
        return Promise.resolve({ paths, commits: 1 });
      },
      mainRunJobs: () => Promise.resolve([[{ name: 'Check', conclusion: 'success' }]]),
    };
    return { calls, comments, deps };
  };

  it('re-runs the failed jobs once instead of a repair round', async () => {
    const f = fakeDeps();
    expect(await beforeRepairInReview(f.deps, card, pr, [check], [log])).toBe('rerun');
    expect(f.calls).toEqual(['diff factory/117-issue-117', 'rerun 77', 'log ci-flake-rerun']);
    expect(f.comments[0]).toContain("CI failed in tests this branch doesn't change");
  });

  it('gives the repair round once the PR has had its re-run, in any run', async () => {
    const e = JSON.stringify({ at: 'x', run: '117-a', event: 'ci-flake-rerun', pr });
    const f = fakeDeps(e);
    expect(await beforeRepairInReview(f.deps, card, pr, [check], [log])).toBeUndefined();
    expect(f.calls).toEqual([]);
  });

  it('gives the repair round when the branch changed the test', async () => {
    const f = fakeDeps('', ['packages/cli/test/notebook.test.ts']);
    expect(await beforeRepairInReview(f.deps, card, pr, [check], [log])).toBeUndefined();
    expect(f.calls).toEqual(['diff factory/117-issue-117']);
  });
});
