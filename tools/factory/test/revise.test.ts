import { describe, expect, it } from 'vitest';
import type { CheckRun } from '../src/checks.ts';
import { parseIssueSpec } from '../src/labels.ts';
import type { RebaseOutcome } from '../src/rebase.ts';
import type { AgentResult } from '../src/result.ts';
import { runRebase, type ReviseDeps } from '../src/revise.ts';
import type { RunSandbox } from '../src/run.ts';
import { item, testConfig } from './helpers.ts';

const config = testConfig();
const card = item(42, { title: 'Add a decision', labels: ['plan:skip'], status: 'In review' });
const spec = (() => {
  const r = parseIssueSpec(card.labels, config);
  if (!r.ok) throw new Error(r.error);
  return r.spec;
})();
const PR = 'https://github.com/htxryan/penmoss/pull/901';
const BRANCH = 'factory/42-add-a-decision';
const green: CheckRun = {
  name: 'Check',
  state: 'SUCCESS',
  bucket: 'pass',
  link: 'l',
  startedAt: '2026-11-08T12:00:00Z',
};
const done: AgentResult = {
  status: 'done',
  summary: 'Resolve the conflict',
  questions: [],
  platforms: {},
  tests: [],
  decisions: [],
  risks: [],
  replies: {},
};

/** A ReviseDeps whose every effect is recorded, for the In review rebase (F6). */
function fake(rebases: RebaseOutcome[]) {
  const calls: string[] = [];
  const issueComments: string[] = [];
  const prComments: string[] = [];
  const prompts: string[] = [];
  let opened = 0;
  const sandbox = (): RunSandbox => {
    const n = ++opened;
    return {
      worktreePath: `/wt/${n}`,
      exec: (command) => {
        calls.push(`exec ${n}: ${command}`);
        return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
      },
      close: () => Promise.resolve(),
    };
  };
  const deps: ReviseDeps = {
    config,
    slot: config.slots[0]!,
    runId: 'r9',
    board: { items: [card] },
    macVmCheck: () => Promise.resolve({ ok: true }),
    walk: (_sandbox, platform) => Promise.resolve({ platform, captures: [] }),
    waitingFor: () => undefined,
    comment: (_issue, body) => {
      issueComments.push(body);
      calls.push('issue comment');
      return Promise.resolve();
    },
    setStatus: (_item, status) => {
      calls.push(`status ${status}`);
      return Promise.resolve();
    },
    setBlocked: () => {
      calls.push('blocked');
      return Promise.resolve();
    },
    openSandbox: () => Promise.resolve(sandbox()),
    runAgent: (_sandbox, prompt) => {
      calls.push('agent');
      prompts.push(prompt);
      return Promise.resolve({ output: 'done' });
    },
    readResult: () => Promise.resolve({ ok: true, result: done }),
    diff: () => Promise.resolve({ paths: ['docs/decisions.md'], commits: 2 }),
    recordProof: () => Promise.resolve([]),
    prepareProof: () => Promise.resolve({ ok: true, proof: [] }),
    fetchMain: () => {
      calls.push('fetch main');
      return Promise.resolve();
    },
    behindMain: () => Promise.resolve(true),
    rebase: (work) => {
      calls.push(`rebase ${work.worktreePath}`);
      return Promise.resolve(rebases.shift() ?? { kind: 'rebased', resolved: [], renumbered: {} });
    },
    numberDecisions: () => Promise.resolve({}),
    push: (branch) => {
      calls.push(`push ${branch}`);
      return Promise.resolve();
    },
    checks: () => {
      calls.push('checks');
      return Promise.resolve([green]);
    },
    failedLog: () => Promise.resolve(''),
    stageMockups: () => Promise.resolve(),
    keepValidation: () => Promise.resolve(),
    readReview: () => Promise.resolve(null),
    collectFidelity: (_sandbox, rows) => Promise.resolve([...rows]),
    heavy: (_label, fn) => fn(),
    notify: () => Promise.resolve(),
    sleep: () => Promise.resolve(),
    now: () => new Date('2026-11-08T12:30:00Z'),
    openPr: () => Promise.reject(new Error('a rebase never opens a PR')),
    log: () => undefined,
    step: () => Promise.resolve(),
    prComment: (_pr, body) => {
      prComments.push(body);
      calls.push('pr comment');
      return Promise.resolve();
    },
    replyToThread: () => Promise.reject(new Error('a rebase answers no thread')),
    headSha: () => Promise.resolve('0123456789abcdef'),
  };
  return { deps, calls, issueComments, prComments, prompts };
}

const input = { item: card, spec, pr: PR, branch: BRANCH, items: [], prompt: 'p' };

describe('runRebase: a PR in review that main moved past (F6)', () => {
  it('rebases onto main, gates again, pushes and waits for CI, without the agent', async () => {
    const f = fake([
      { kind: 'rebased', resolved: ['docs/decisions.md'], renumbered: { A1225: 'A1226' } },
    ]);
    expect(await runRebase(f.deps, input)).toEqual({ kind: 'addressed', sha: '0123456789' });
    expect(f.calls).toEqual([
      'fetch main',
      'rebase /wt/1',
      'exec 1: pnpm install --frozen-lockfile --prefer-offline',
      'exec 1: git diff origin/main...HEAD',
      'exec 1: task lint',
      `push ${BRANCH}`,
      'pr comment',
      'checks',
    ]);
    expect(f.prComments[0]).toContain('rebased onto it as 0123456789');
    expect(f.prComments[0]).toContain('keeps all the new rows, main’s first');
    expect(f.prComments[0]).toContain('main already had A1225, so this PR’s is now A1226');
    // A marker would hide Ryan's earlier comments from the next review round.
    expect(f.prComments[0]).not.toContain('penmoss-factory');
    expect(f.calls).not.toContain('status In review');
  });

  it('gives any other conflict to the agent, then Blocks with the files named', async () => {
    const conflict: RebaseOutcome = {
      kind: 'conflict',
      files: ['apps/web/src/routes.ts'],
      output: 'CONFLICT (content): Merge conflict in apps/web/src/routes.ts',
    };
    const f = fake([conflict, conflict]);
    expect(await runRebase(f.deps, input)).toEqual({ kind: 'blocked', reason: 'rebase-conflict' });
    expect(f.prompts).toHaveLength(1);
    expect(f.prompts[0]).toContain('## `origin/main` moved: rebase onto it');
    expect(f.issueComments.at(-1)).toContain(
      'no longer rebases onto main: `apps/web/src/routes.ts` conflict',
    );
    expect(f.issueComments.at(-1)).toContain('phase=rebase event=blocked');
    expect(f.calls.some((c) => c.startsWith('push'))).toBe(false);
    expect(f.calls.at(-1)).toBe('blocked');
  });
});
