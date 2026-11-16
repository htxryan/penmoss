// The fake RunDeps the run's tests drive runImplement with (run.test.ts and the tests of the
// modules it runs through), and the card, checks and results they share.
import type { Board } from '../src/board.ts';
import { parseIssueSpec } from '../src/labels.ts';
import type { CheckRun } from '../src/checks.ts';
import { ciHistory } from '../src/ci-failure.ts';
import type { RunJob } from '../src/merge.ts';
import type { WalkOutcome } from '../src/walk.ts';
import type { RebaseOutcome } from '../src/rebase.ts';
import type { AgentResult } from '../src/result.ts';
import type { IssueComment } from '../src/issue.ts';
import { VmUnavailable, type VmCheck } from '../src/proof/mac.ts';
import type { RunDeps, RunSandbox } from '../src/run-deps.ts';
import { item, testConfig } from './helpers.ts';

export const config = testConfig();
export const card = item(42, { title: 'Fix the typo in docs/cli.md', labels: ['plan:skip'] });
export const spec = (() => {
  const r = parseIssueSpec(card.labels, config);
  if (!r.ok) throw new Error(r.error);
  return r.spec;
})();
export const board: Board = {
  items: [card],
};

export const green: CheckRun = {
  name: 'Check',
  state: 'SUCCESS',
  bucket: 'pass',
  link: 'l',
  startedAt: '2026-11-07T12:00:00Z',
};
export const red: CheckRun = {
  name: 'Check',
  state: 'FAILURE',
  bucket: 'fail',
  link: 'https://github.com/htxryan/penmoss/actions/runs/77/job/1',
};
export const queued: CheckRun = {
  name: 'Android app',
  state: 'QUEUED',
  bucket: 'pending',
  link: 'l',
  startedAt: '0001-01-01T00:00:00Z',
};

export const done: AgentResult = {
  status: 'done',
  summary: 'Fix a typo in the CLI docs',
  questions: [],
  platforms: {},
  tests: [],
  decisions: [],
  risks: [],
  replies: {},
  releaseNote: 'none',
};

export interface Fake {
  deps: RunDeps;
  calls: string[];
  comments: string[];
  prompts: string[];
  events: string[];
  /** Each logged event with its detail. */
  details: [string, Record<string, unknown> | undefined][];
  /** What the run said it waits for, in order (`null`: it went on). */
  waits: (string | null)[];
  /** The signal each proof was given. */
  signals: (AbortSignal | undefined)[];
  /** Seconds slept, in order. */
  slept: number[];
}

export function fake(overrides: {
  result?: AgentResult | { error: string; missing?: boolean };
  paths?: string[];
  commits?: number;
  dirty?: boolean;
  gateExit?: number;
  proofPassed?: boolean;
  agentRounds?: (AgentResult | { error: string; missing?: boolean })[];
  /** The agent can resume its last session (Claude Code; A1346). */
  resumable?: boolean;
  /** Ryan's new card comments each agent round finds, in order (A1347). */
  owner?: IssueComment[][];
  ci?: CheckRun[][];
  conflict?: boolean;
  /** review.json per validation, in order (F19). */
  reviews?: string[];
  /** The first agent runs stop on a usage limit. */
  limited?: number;
  /** The branch's diff adds a test.skip in the first gate round. */
  weakened?: boolean;
  /** Whether main has moved past the branch, each time it is asked (default: no). */
  behind?: boolean[];
  /** What each rebase onto main does, in order (default: a clean rebase). */
  rebases?: RebaseOutcome[];
  /** The test VM's host checks before a Mac proof, in order; then it is ready (F10). */
  vmChecks?: VmCheck[];
  /** The first Mac proofs find the VM won't boot (the VM script's exit 75). */
  vmBootFails?: number;
  /** What each walkthrough gives back (PEN-94), or the error it throws. */
  walks?: Partial<Record<'mac' | 'android', WalkOutcome | Error>>;
  /** The gate's `pnpm install` exits with this. */
  installExit?: number;
  /** A failed check's log, by its name (default: a lint error). */
  logs?: Record<string, string>;
  /** `runs.jsonl` as earlier runs left it, for `ciHistory`. */
  ledger?: string;
  /** The jobs of main's latest completed runs, newest first, for `mainRunJobs` (A1328). */
  mainJobs?: RunJob[][];
  /** Whether the branch's diff changes `.github/workflows/ci.yml`, by sandbox (1 is the first). */
  workflowIn?: (sandbox: number) => boolean;
  /** What the mockup renderer prints (A1323). */
  rendered?: string;
  /** `git diff --raw` of the branch's own changes in the gate (carry.ts); default: none. */
  raw?: string;
  /** What each `uncommitted` call finds after an agent session, in order (PEN-141); then none. */
  uncommitted?: string[][];
}): Fake {
  const calls: string[] = [];
  const comments: string[] = [];
  let opened = 0;
  const sandbox = (): RunSandbox => {
    const n = ++opened;
    return {
      worktreePath: `/wt/${n}`,
      exec: (command) => {
        calls.push(`exec ${n}: ${command}`);
        if (command.startsWith('git diff --raw'))
          return Promise.resolve({ exitCode: 0, stdout: overrides.raw ?? '', stderr: '' });
        if (command.startsWith('git diff') && overrides.workflowIn?.(n))
          return Promise.resolve({
            exitCode: 0,
            stdout:
              'diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml\n+          for i in 1 2 3; do apt-get update && break; done\n',
            stderr: '',
          });
        if (command.startsWith('git diff'))
          return Promise.resolve({
            exitCode: 0,
            stdout:
              overrides.weakened && opened <= 2
                ? "diff --git a/apps/web/test/e2e/x.spec.ts b/apps/web/test/e2e/x.spec.ts\n+test.skip('x', () => {})\n"
                : '',
            stderr: '',
          });
        if (command.startsWith(`cd 'apps/web' && node - `))
          return Promise.resolve({ exitCode: 0, stdout: overrides.rendered ?? '', stderr: '' });
        if (command.startsWith('pnpm install'))
          return Promise.resolve({ exitCode: overrides.installExit ?? 0, stdout: '', stderr: '' });
        if (command.startsWith('git status'))
          return Promise.resolve({
            exitCode: 0,
            stdout: overrides.dirty ? ' M x' : '',
            stderr: '',
          });
        return Promise.resolve({
          exitCode: overrides.gateExit ?? 0,
          stdout: 'lint output',
          stderr: '',
        });
      },
      close: () => {
        calls.push(`close ${n}`);
        return Promise.resolve();
      },
    };
  };
  const result = overrides.result ?? done;
  let limitedLeft = overrides.limited ?? 0;
  const reviews = [...(overrides.reviews ?? [])];
  const events: string[] = [];
  const details: [string, Record<string, unknown> | undefined][] = [];
  const rounds = [...(overrides.agentRounds ?? [])];
  const prompts: string[] = [];
  const ciRounds = [...(overrides.ci ?? [])];
  const behind = [...(overrides.behind ?? [])];
  const rebases = [...(overrides.rebases ?? [])];
  const vmChecks = [...(overrides.vmChecks ?? [])];
  let bootFails = overrides.vmBootFails ?? 0;
  const waits: (string | null)[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  const slept: number[] = [];
  let clock = Date.parse('2026-11-07T12:00:00Z');
  const deps: RunDeps = {
    config,
    slot: config.slots[0]!,
    runId: 'r1',
    board,
    comment: (issue, body) => {
      comments.push(body);
      calls.push(`comment #${issue}`);
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
    openSandbox: (branch) => {
      calls.push(`open ${branch}`);
      return Promise.resolve(sandbox());
    },
    runAgent: (_sandbox, prompt) => {
      calls.push('agent');
      prompts.push(prompt);
      return Promise.resolve(
        limitedLeft-- > 0
          ? { output: 'Claude AI usage limit reached|1700000000' }
          : { output: 'done' },
      );
    },
    ...(overrides.owner
      ? {
          ownerComments: () => {
            calls.push('owner comments');
            return Promise.resolve(overrides.owner!.shift() ?? []);
          },
        }
      : {}),
    ...(overrides.resumable
      ? {
          canContinue: () => true,
          continueAgent: (_sandbox: RunSandbox, message: string) => {
            calls.push('agent continued');
            prompts.push(message);
            return Promise.resolve({ output: 'done' });
          },
        }
      : {}),
    ...(overrides.uncommitted
      ? {
          uncommitted: () => {
            calls.push('uncommitted?');
            return Promise.resolve(overrides.uncommitted!.shift() ?? []);
          },
        }
      : {}),
    readResult: () => {
      const next = rounds.shift() ?? result;
      return Promise.resolve(
        'error' in next
          ? { ok: false, error: next.error, ...(next.missing ? { missing: true } : {}) }
          : { ok: true, result: next },
      );
    },
    diff: () =>
      Promise.resolve({
        paths: overrides.paths ?? ['docs/cli.md'],
        commits: overrides.commits ?? 1,
      }),
    heavy: (_label, fn) => fn(),
    stageMockups: () => {
      calls.push('mockups');
      return Promise.resolve();
    },
    keepValidation: () => {
      calls.push('keep validation');
      return Promise.resolve();
    },
    readReview: () => {
      calls.push('read review');
      return Promise.resolve(reviews.shift() ?? null);
    },
    collectFidelity: (_sandbox, rows) => Promise.resolve([...rows]),
    macVmCheck: () => {
      calls.push('vm check');
      return Promise.resolve(vmChecks.shift() ?? { ok: true });
    },
    waitingFor: (reason) => void waits.push(reason),
    walk: (_sandbox, platform, signal) => {
      calls.push(`walk ${platform}`);
      signals.push(signal);
      const out = overrides.walks?.[platform] ?? { platform, captures: [] };
      return out instanceof Error ? Promise.reject(out) : Promise.resolve(out);
    },
    recordProof: (_sandbox, platform, specs, signal) => {
      calls.push(`proof ${platform}: ${specs.join(' ')}`);
      signals.push(signal);
      if (platform === 'mac' && bootFails-- > 0)
        return Promise.reject(new VmUnavailable('penmoss-test did not answer in 3 minutes'));
      return Promise.resolve(
        (overrides.proofPassed ?? true)
          ? [
              {
                platform,
                title: 'shows it',
                status: 'passed',
                phase: 'after',
                source: 'harness',
                video: '/v.webm',
                screenshot: '/s.png',
              },
            ]
          : [],
      );
    },
    prepareProof: (items) =>
      Promise.resolve({
        ok: true,
        proof: items.map((i) => ({
          label: `${i.platform}: ${i.title}`,
          phase: i.phase,
          source: i.source,
          image: 'web-1.png',
          video: 'web-1.mp4',
        })),
      }),
    fetchMain: () => Promise.resolve(),
    behindMain: (branch) => {
      calls.push(`behind? ${branch}`);
      return Promise.resolve(behind.shift() ?? false);
    },
    rebase: (work) => {
      calls.push(`rebase ${work.worktreePath}`);
      return Promise.resolve(
        rebases.shift() ??
          (overrides.conflict && opened <= 2
            ? {
                kind: 'conflict',
                files: ['docs/cli.md'],
                output: 'CONFLICT (content): docs/cli.md',
              }
            : { kind: 'rebased', resolved: [], renumbered: {} }),
      );
    },
    numberDecisions: () => Promise.resolve({}),
    push: (branch) => {
      calls.push(`push ${branch}`);
      return Promise.resolve();
    },
    checks: () => {
      calls.push('checks');
      return Promise.resolve(ciRounds.shift() ?? [green]);
    },
    failedLog: (check) =>
      Promise.resolve(overrides.logs?.[check.name] ?? 'Error: lint failed at a.ts:1'),
    rerunFailed: (run) => {
      calls.push(`rerun ${run}`);
      return Promise.resolve();
    },
    ...(overrides.ledger !== undefined
      ? { ciHistory: (issue: number, pr: string) => ciHistory(overrides.ledger!, issue, pr) }
      : {}),
    ...(overrides.mainJobs
      ? {
          mainRunJobs: (workflow: string) => {
            calls.push(`main jobs ${workflow}`);
            return Promise.resolve(overrides.mainJobs!);
          },
        }
      : {}),
    notify: (title) => {
      calls.push(`notify ${title}`);
      return Promise.resolve();
    },
    sleep: (seconds) => {
      slept.push(seconds);
      return Promise.resolve();
    },
    now: () => new Date((clock += 30 * 60_000)),
    openPr: ({ body }) => {
      calls.push('pr');
      comments.push(body);
      return Promise.resolve('https://github.com/htxryan/penmoss/pull/900');
    },
    log: (event, detail) => {
      events.push(event);
      details.push([event, detail]);
    },
    step: () => Promise.resolve(),
  };
  return { deps, calls, comments, prompts, events, details, waits, signals, slept };
}

export const webDoneForPush: AgentResult = {
  ...done,
  platforms: {
    web: { inScope: true, proofSpecs: ['comments.spec.ts'] },
    mac: { inScope: true, proofSpecs: ['app.spec.ts'] },
    android: { inScope: true, proofSpecs: ['app.penmoss.EditorScreenTest'] },
  },
};
