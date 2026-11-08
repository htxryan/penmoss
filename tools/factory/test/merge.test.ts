import { describe, expect, it } from 'vitest';
import type { CheckRun } from '../src/checks.ts';
import { mergeApproved, type MainRun, type MergeDeps } from '../src/merge.ts';
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

function fake(checks: CheckRun[], mains: MainRun[][]) {
  const calls: string[] = [];
  let clock = Date.parse('2026-11-07T12:00:00Z');
  const deps: MergeDeps = {
    config,
    runId: 'm1',
    checks: () => Promise.resolve(checks),
    merge: () => {
      calls.push('merge');
      return Promise.resolve('abcdef1234567890');
    },
    mainRuns: () => Promise.resolve(mains.shift() ?? []),
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
  it('sets Blocked when main goes red after the merge, keeping the status', async () => {
    const f = fake([green], [[{ status: 'completed', conclusion: 'failure', url: 'r9' }]]);
    expect(await mergeApproved(f.deps, card, 'pr')).toEqual({
      kind: 'blocked',
      reason: "main's CI failed after the merge: r9",
    });
    expect(f.calls.slice(-1)).toEqual(['blocked']);
    expect(f.calls).not.toContain('status Done');
  });
});
