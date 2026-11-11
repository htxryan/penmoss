import { describe, expect, it } from 'vitest';
import type { CheckRun } from '../src/checks.ts';
import type { Platform } from '../src/config.ts';
import { parseIssueSpec } from '../src/labels.ts';
import type { ProofItem } from '../src/proof/manifest.ts';
import type { RebaseOutcome } from '../src/rebase.ts';
import type { AgentResult } from '../src/result.ts';
import { runRebase, runRevise, type ReviseDeps } from '../src/revise.ts';
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
    rerunFailed: (run) => {
      calls.push(`rerun ${run}`);
      return Promise.resolve();
    },
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

describe('runRevise: a review round (F11)', () => {
  const shot = (platform: Platform): ProofItem[] => [
    {
      platform,
      title: 'shows it',
      status: 'passed',
      phase: 'after',
      source: 'harness',
      screenshot: '/s.png',
    },
  ];
  const thread = {
    kind: 'thread' as const,
    threadId: 'T1',
    trusted: true,
    author: 'htxryan',
    body: 'Use the gutter token',
  };
  const androidDone: AgentResult = {
    ...done,
    summary: 'Use the gutter token',
    platforms: {
      android: { inScope: true, proofSpecs: ['app.penmoss.ui.SettingsInstrumentedTest'] },
    },
    replies: {
      T1: 'The test reads --settings-gutter now.',
      general: 'engine-host.test.ts changed because CI flaked on this PR.',
    },
  };

  it("gates with the round's own proof specs, then pushes and answers the thread", async () => {
    const f = fake([]);
    const specs: string[][] = [];
    const replies: string[] = [];
    const deps: ReviseDeps = {
      ...f.deps,
      readResult: () => Promise.resolve({ ok: true, result: androidDone }),
      diff: () =>
        Promise.resolve({
          paths: ['apps/android/app/src/main/java/app/penmoss/Settings.kt'],
          commits: 3,
        }),
      recordProof: (_gate, platform, s) => {
        specs.push([...s]);
        return Promise.resolve(shot(platform));
      },
      replyToThread: (id, body) => {
        replies.push(`${id}: ${body}`);
        return Promise.resolve();
      },
    };
    expect(await runRevise(deps, { ...input, items: [thread] })).toEqual({
      kind: 'addressed',
      sha: '0123456789',
    });
    expect(specs).toEqual([['app.penmoss.ui.SettingsInstrumentedTest']]);
    expect(f.prompts).toHaveLength(1);
    expect(replies).toEqual(['T1: The test reads --settings-gutter now. (0123456789)']);
    expect(f.calls).toContain(`push ${BRANCH}`);
    // The answer to the general comments, which has no thread, goes in the round's comment.
    expect(f.prComments.at(-1)).toContain(
      'Addressed in 0123456789: Use the gutter token\n\nengine-host.test.ts changed because CI flaked on this PR.',
    );
    expect(f.prComments.at(-1)).not.toContain('--settings-gutter');
  });

  it("says the gate's number for a new decision in the round's comment, not A-NEW-n", async () => {
    const f = fake([]);
    const deps: ReviseDeps = {
      ...f.deps,
      readResult: () =>
        Promise.resolve({
          ok: true,
          result: { ...androidDone, summary: 'Use the gutter token (decision A-NEW-1)' },
        }),
      diff: () =>
        Promise.resolve({
          paths: ['apps/android/app/src/main/java/app/penmoss/Settings.kt'],
          commits: 3,
        }),
      recordProof: (_gate, platform) => Promise.resolve(shot(platform)),
      replyToThread: () => Promise.resolve(),
      openSandbox: async (branch) => {
        const box = await f.deps.openSandbox(branch);
        return {
          ...box,
          exec: (command) =>
            command.startsWith('git log')
              ? Promise.resolve({
                  exitCode: 0,
                  stdout: 'Number the new decisions: A-NEW-1 is A1304\n',
                  stderr: '',
                })
              : box.exec(command),
        };
      },
    };
    await runRevise(deps, { ...input, items: [thread] });
    expect(f.prComments.at(-1)).toContain(
      'Addressed in 0123456789: Use the gutter token (decision A1304)',
    );
  });

  it('asks the agent again when its round names no proof spec for an affected platform', async () => {
    const f = fake([]);
    const results = [done, androidDone];
    const deps: ReviseDeps = {
      ...f.deps,
      readResult: () => Promise.resolve({ ok: true, result: results.shift() ?? androidDone }),
      diff: () =>
        Promise.resolve({
          paths: ['apps/android/app/src/main/java/app/penmoss/Settings.kt'],
          commits: 3,
        }),
      recordProof: (_gate, platform) => Promise.resolve(shot(platform)),
      replyToThread: () => Promise.resolve(),
    };
    expect((await runRevise(deps, { ...input, items: [thread] })).kind).toBe('addressed');
    expect(f.prompts).toHaveLength(2);
    expect(f.prompts[1]).toContain('names no proof spec for android');
  });

  it("counts a repair round for red CI toward the PR's rounds.ciRepair, and a review round not (A1313)", async () => {
    const logged = (ciRepair: boolean) => {
      const events: [string, unknown][] = [];
      const f = fake([]);
      const deps: ReviseDeps = {
        ...f.deps,
        log: (event, detail) => void events.push([event, detail]),
      };
      return runRevise(deps, { ...input, ...(ciRepair ? { ciRepair: true as const } : {}) }).then(
        () => events.filter(([e]) => e === 'ci-repaired'),
      );
    };
    expect(await logged(true)).toEqual([['ci-repaired', { pr: PR, phase: 'review' }]]);
    expect(await logged(false)).toEqual([]);
  });
});
