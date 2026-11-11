import { describe, expect, it } from 'vitest';
import type { Board } from '../src/board.ts';
import type { Gh } from '../src/github.ts';
import { openOrReusePr } from '../src/host.ts';
import { parseIssueSpec } from '../src/labels.ts';
import type { CheckRun } from '../src/checks.ts';
import { ciHistory } from '../src/ci-failure.ts';
import type { WalkOutcome } from '../src/walk.ts';
import type { RebaseOutcome } from '../src/rebase.ts';
import type { AgentResult } from '../src/result.ts';
import { VmUnavailable, type VmCheck } from '../src/proof/mac.ts';
import {
  branchName,
  gateCommand,
  prTitle,
  runImplement,
  TITLE_MAX,
  type RunDeps,
  type RunSandbox,
} from '../src/run.ts';
import { BlockedByRyan, guardEffects, RUN_GUARDED, RUN_STEPS } from '../src/guard.ts';
import { item, testConfig } from './helpers.ts';

const config = testConfig();
const card = item(42, { title: 'Fix the typo in docs/cli.md', labels: ['plan:skip'] });
const spec = (() => {
  const r = parseIssueSpec(card.labels, config);
  if (!r.ok) throw new Error(r.error);
  return r.spec;
})();
const board: Board = {
  items: [card],
};

const green: CheckRun = {
  name: 'Check',
  state: 'SUCCESS',
  bucket: 'pass',
  link: 'l',
  startedAt: '2026-11-07T12:00:00Z',
};
const red: CheckRun = {
  name: 'Check',
  state: 'FAILURE',
  bucket: 'fail',
  link: 'https://github.com/htxryan/penmoss/actions/runs/77/job/1',
};
const queued: CheckRun = {
  name: 'Android app',
  state: 'QUEUED',
  bucket: 'pending',
  link: 'l',
  startedAt: '0001-01-01T00:00:00Z',
};

const done: AgentResult = {
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

interface Fake {
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

function fake(overrides: {
  result?: AgentResult | { error: string };
  paths?: string[];
  commits?: number;
  dirty?: boolean;
  gateExit?: number;
  proofPassed?: boolean;
  agentRounds?: AgentResult[];
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
  /** Whether the branch's diff changes `.github/workflows/ci.yml`, by sandbox (1 is the first). */
  workflowIn?: (sandbox: number) => boolean;
  /** What the mockup renderer prints (A1323). */
  rendered?: string;
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
    readResult: () => {
      const next = rounds.shift() ?? result;
      return Promise.resolve(
        'error' in next ? { ok: false, error: next.error } : { ok: true, result: next },
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

describe('runImplement', () => {
  it('takes a docs-only plan:skip issue from Ready to In review', async () => {
    const f = fake({});
    const outcome = await runImplement(f.deps, { item: card, spec, prompt: 'p' });
    expect(outcome).toEqual({
      kind: 'in-review',
      pr: 'https://github.com/htxryan/penmoss/pull/900',
      scope: { kind: 'docs-only', platforms: [] },
    });
    expect(f.calls).toEqual([
      'comment #42',
      'status In progress',
      'open factory/42-fix-the-typo-in-docs-cli',
      'agent',
      'close 1',
      'open factory/42-fix-the-typo-in-docs-cli',
      'exec 2: git status --porcelain --untracked-files=no',
      'rebase /wt/2',
      'exec 2: pnpm install --frozen-lockfile --prefer-offline',
      'exec 2: git diff origin/main...HEAD',
      'exec 2: task lint',
      // What the gate numbered on the branch, for the PR body.
      'exec 2: git log --reverse --format=%s origin/main..HEAD',
      'close 2',
      // main hasn't moved since the gate's rebase, so the first push goes as it is.
      'behind? factory/42-fix-the-typo-in-docs-cli',
      'push factory/42-fix-the-typo-in-docs-cli',
      'pr',
      'checks',
      // main hasn't moved while CI ran, so there is nothing to rebase before review.
      'behind? factory/42-fix-the-typo-in-docs-cli',
      'comment #42',
      'status In review',
      'notify Penmoss #42 is ready for review',
    ]);
    // The claim carries the marker; the PR says Part of, not Closes (R20).
    expect(f.comments[0]).toContain(
      '<!-- penmoss-factory run=r1 agent=claude model=opus phase=implement event=claim -->',
    );
    expect(f.comments[1]).toMatch(/^Part of #42\./);
    expect(f.comments[1]).not.toMatch(/Closes|Fixes|Resolves/);
  });

  it("titles the PR with the branch's first commit subject, without the card's id", async () => {
    const f = fake({});
    const titles: string[] = [];
    const linearCard = { ...card, key: 'PEN-42' };
    const deps: RunDeps = {
      ...f.deps,
      diff: () =>
        Promise.resolve({
          paths: ['docs/cli.md'],
          commits: 2,
          subject: 'Docs: fix the typo in the CLI page (PEN-42)',
        }),
      openPr: (pr) => {
        titles.push(pr.title);
        return f.deps.openPr(pr);
      },
    };
    await runImplement(deps, {
      item: linearCard,
      spec,
      prompt: 'p',
    });
    expect(titles).toEqual(['Docs: fix the typo in the CLI page']);
    // The body still links the card, without closing it.
    expect(f.comments[1]).toMatch(/^Part of PEN-42\./);
  });

  it('stops before the gate when Blocked is set while the agent works (R23)', async () => {
    // PEN-75: Ryan set Blocked as the agent finished, and the gate ran on regardless.
    const f = fake({});
    let blocked = false;
    const deps: RunDeps = {
      ...f.deps,
      runAgent: async (sandbox, prompt) => {
        const ran = await f.deps.runAgent(sandbox, prompt);
        blocked = true;
        return ran;
      },
    };
    const guarded = guardEffects(deps, RUN_GUARDED, 42, () => Promise.resolve(blocked), RUN_STEPS);
    const stopped = runImplement(guarded, { item: card, spec, prompt: 'p' });
    await expect(stopped).rejects.toBeInstanceOf(BlockedByRyan);
    await expect(stopped).rejects.toMatchObject({ step: 'the gate' });
    expect(f.calls).toEqual([
      'comment #42',
      'status In progress',
      'open factory/42-fix-the-typo-in-docs-cli',
      'agent',
      'close 1',
    ]);
  });

  it.each([
    ['a gate-fix round', 'gate-fix round 1', true],
    ['the push', 'the push', false],
  ])('stops before %s when Blocked is set during the gate', async (_what, step, gateFails) => {
    // Blocked comes on while the gate's command runs; that command finishes, nothing after it.
    let blocked = false;
    const f = fake({});
    const deps: RunDeps = {
      ...f.deps,
      heavy: async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
        const r = await fn();
        if (!label.startsWith('factory gate')) return r;
        blocked = true;
        return gateFails ? { ...r, exitCode: 1 } : r;
      },
    };
    const guarded = guardEffects(deps, RUN_GUARDED, 42, () => Promise.resolve(blocked), RUN_STEPS);
    await expect(runImplement(guarded, { item: card, spec, prompt: 'p' })).rejects.toMatchObject({
      step,
    });
    expect(f.calls).not.toContain('push factory/42-fix-the-typo-in-docs-cli');
  });

  it("goes on from the gate when a recovered run's agent had already finished (R12)", async () => {
    // PEN-75: the restarted run ran the agent again at round 0 over finished, committed work.
    const f = fake({});
    const outcome = await runImplement(f.deps, {
      item: card,
      spec,
      prompt: 'p',
      recovered: true,
      resume: { run: '42-old', result: done },
    });
    expect(outcome.kind).toBe('in-review');
    expect(f.calls).not.toContain('agent');
    expect(f.calls.slice(0, 4)).toEqual([
      'comment #42',
      'status In progress',
      'open factory/42-fix-the-typo-in-docs-cli',
      'exec 1: git status --porcelain --untracked-files=no',
    ]);
    expect(f.comments[0]).toMatch(/^Restarted: this run stopped after its agent had finished/);
    expect(f.events.slice(0, 2)).toEqual(['claimed', 'agent-finished']);
  });

  it('goes back to waiting on CI when the PR is as the factory pushed it (A1298)', async () => {
    // PEN-71: CI went red, Ryan re-ran the job green and cleared Blocked; the restart gated,
    // proved and validated the same commit again, about 30 minutes for nothing.
    const f = fake({});
    const pr = 'https://github.com/htxryan/penmoss/pull/7';
    const outcome = await runImplement(
      { ...f.deps, pushedPr: () => Promise.resolve(pr) },
      { item: card, spec, prompt: 'p', recovered: true, resume: { run: '42-old', result: done } },
    );
    expect(outcome).toMatchObject({ kind: 'in-review', pr });
    for (const step of [
      'agent',
      'open factory/42-fix-the-typo-in-docs-cli',
      'push factory/42-fix-the-typo-in-docs-cli',
      'pr',
    ])
      expect(f.calls).not.toContain(step);
    expect(f.comments[0]).toMatch(/^Restarted: .*pull\/7 is as the factory last pushed it/);
    expect(f.events).toEqual(['claimed', 'agent-finished', 'resumed-at-ci', 'in-review']);
  });

  it("counts the PR's earlier repair rounds, so clearing Blocked gives the agent none more (A1313)", async () => {
    // Each time Ryan cleared Blocked on a ci-red card, its restarted watchCi began again at 0.
    const pr = 'https://github.com/htxryan/penmoss/pull/7';
    const repaired = (round: number) =>
      JSON.stringify({ at: 'x', run: '42-old', event: 'ci-repaired', round, pr });
    const f = fake({ ci: [[red]], ledger: [repaired(1), repaired(2)].join('\n') });
    const outcome = await runImplement(
      { ...f.deps, pushedPr: () => Promise.resolve(pr) },
      { item: card, spec, prompt: 'p', recovered: true, resume: { run: '42-old', result: done } },
    );
    expect(outcome).toEqual({ kind: 'blocked', reason: 'ci-red' });
    expect(f.prompts).toEqual([]);
    expect(f.comments.at(-1)).toContain('CI is still red after 2 repair round(s)');
  });

  it('goes on counting from the ledger, one repair left', async () => {
    const pr = 'https://github.com/htxryan/penmoss/pull/7';
    const repaired = JSON.stringify({ at: 'x', run: '42-old', event: 'ci-repaired', round: 1, pr });
    const f = fake({ ci: [[red], [red]], ledger: repaired });
    const outcome = await runImplement(
      { ...f.deps, pushedPr: () => Promise.resolve(pr) },
      { item: card, spec, prompt: 'p', recovered: true, resume: { run: '42-old', result: done } },
    );
    expect(outcome).toEqual({ kind: 'blocked', reason: 'ci-red' });
    expect(f.prompts).toHaveLength(1);
    expect(f.prompts[0]).toContain('## CI failed (repair round 2)');
  });

  it('gates again when the PR is not as the factory pushed it', async () => {
    const f = fake({});
    await runImplement(
      { ...f.deps, pushedPr: () => Promise.resolve(undefined) },
      { item: card, spec, prompt: 'p', recovered: true, resume: { run: '42-old', result: done } },
    );
    expect(f.calls).toContain('push factory/42-fix-the-typo-in-docs-cli');
    expect(f.comments[0]).toMatch(/^Restarted: this run stopped after its agent had finished/);
  });

  it('keeps a finished result when a step after the agent fails, so a restart resumes (A1266)', async () => {
    // PEN-72: OpenCode committed and wrote its result, then Sandcastle's session capture failed.
    const f = fake({});
    const deps: RunDeps = {
      ...f.deps,
      runAgent: () => Promise.reject(new Error('Session capture failed')),
    };
    await expect(runImplement(deps, { item: card, spec, prompt: 'p' })).rejects.toThrow(
      'Session capture failed',
    );
    expect(f.events).toEqual(['claimed', 'agent-started', 'agent-finished']);
  });
  it('records no finished round when the agent fails without a done result', async () => {
    const f = fake({ result: { error: 'no .factory/result.json' } });
    const deps: RunDeps = { ...f.deps, runAgent: () => Promise.reject(new Error('crashed')) };
    await expect(runImplement(deps, { item: card, spec, prompt: 'p' })).rejects.toThrow('crashed');
    expect(f.events).not.toContain('agent-finished');
  });

  it("opens no PR when the branch's commits change nothing against main (A1268)", async () => {
    // PEN-80: the gate refused a skip, the agent took it back out, and an empty PR opened.
    const f = fake({ paths: [], commits: 2 });
    const outcome = await runImplement(f.deps, { item: card, spec, prompt: 'p' });
    expect(outcome).toMatchObject({ kind: 'blocked', reason: 'no-changes' });
    expect(f.calls).not.toContain('pr');
    expect(f.comments.at(-1)).toMatch(/change nothing against main, so there is no PR to open/);
  });

  it('runs the agent again when the branch has none of the finished round’s commits', async () => {
    const f = fake({ commits: 0 });
    await runImplement(f.deps, {
      item: card,
      spec,
      prompt: 'p',
      recovered: true,
      resume: { run: '42-old', result: done },
    });
    expect(f.calls).toContain('agent');
    expect(f.comments[0]).toMatch(/^Restarted: this run stopped before it finished/);
  });

  it('says on the issue why a run restarts after the daemon stopped mid-run (R12)', async () => {
    const f = fake({});
    await runImplement(f.deps, { item: card, spec, prompt: 'p', recovered: true });
    expect(f.comments[0]).toMatch(/^Restarted: this run stopped before it finished/);
    expect(f.comments[0]).toContain('event=claim');
  });

  const webDone: AgentResult = {
    ...done,
    platforms: {
      web: { inScope: true, proofSpecs: ['comments.spec.ts'] },
      mac: { inScope: true, proofSpecs: ['app.spec.ts'] },
      android: { inScope: true, proofSpecs: ['app.penmoss.EditorScreenTest'] },
    },
  };

  it('runs task check for product changes, then records the web proof specs', async () => {
    const f = fake({ paths: ['apps/web/src/a.ts'], result: webDone });
    const outcome = await runImplement(f.deps, { item: card, spec, prompt: 'p' });
    expect(outcome.kind).toBe('in-review');
    expect(f.calls).toContain('exec 2: task check');
    expect(f.calls).toContain('proof web: comments.spec.ts');
    expect(f.comments[1]).toContain('[▶ Watch the recording (MP4)](./web-1.mp4)');
    expect(f.calls).toContain('proof mac: app.spec.ts');
    expect(f.calls).toContain('proof android: app.penmoss.EditorScreenTest');
    expect(f.comments[1]).not.toContain('No recorded proof yet');
  });

  it('sends a run that names no web proof spec back to the agent with the reason (R9)', async () => {
    const f = fake({ paths: ['apps/web/src/a.ts'], agentRounds: [done, webDone] });
    const outcome = await runImplement(f.deps, { item: card, spec, prompt: 'p' });
    expect(outcome.kind).toBe('in-review');
    expect(f.calls.filter((c) => c === 'agent')).toHaveLength(2);
    expect(f.prompts[1]).toContain("The gate's feedback (round 1)");
    expect(f.prompts[1]).toContain('names no proof spec for web');
  });

  it('fails the gate when the proof specs do not pass under recording', async () => {
    const f = fake({ paths: ['apps/web/src/a.ts'], result: webDone, proofPassed: false });
    const outcome = await runImplement(f.deps, { item: card, spec, prompt: 'p' });
    expect(outcome).toEqual({ kind: 'blocked', reason: 'gate-failed' });
    expect(f.comments.at(-1)).toContain("proof specs for web, mac, android didn't pass");
  });

  it("gives the agent each failed proof's own output (A1252)", async () => {
    const f = fake({ paths: ['apps/web/src/a.ts'], result: webDone, proofPassed: false });
    const logs: Record<string, string> = {
      android: 'BUILD FAILED\nerror: emulator-5582 did not come up\nexit 1',
    };
    const deps = { ...f.deps, proofLog: (p: string) => logs[p] };
    await runImplement(deps, { item: card, spec, prompt: 'p' });
    expect(f.prompts[1]).toContain("The android proof's output:");
    expect(f.prompts[1]).toContain('emulator-5582 did not come up');
    expect(f.prompts[1]).not.toContain("The web proof's output:");
    // And where to see the proof's last screenshot, which the Mac proof's VM is the only way to (A1291).
    expect(f.prompts[1]).toContain('.factory/last-proof/');
  });

  const review = (verdict: string, note = '') =>
    JSON.stringify({
      rows: [
        {
          criterion: 'AC1 the badge uses the accent colour',
          verdict,
          note,
          mockup: 'ac1-mockup.png',
          screenshot: 'ac1.png',
        },
      ],
    });

  it('validates a planned web change, sends a wrong colour back, and shows the fidelity table (F19)', async () => {
    const f = fake({
      paths: ['apps/web/src/a.ts'],
      result: webDone,
      reviews: [
        review('mismatch', 'The badge is red; the mockup accent is green'),
        review('match'),
      ],
    });
    const outcome = await runImplement(f.deps, { item: card, spec, prompt: 'p', plan: 'AC1 …' });
    expect(outcome.kind).toBe('in-review');
    // The ledger says validation sent it back, naming the criterion, not that the gate failed.
    expect(f.events).toContain('validation-mismatch');
    expect(f.events).not.toContain('gate-failed');
    expect(f.details).toContainEqual(['validation-mismatch', { round: 0, criteria: ['AC1'] }]);
    expect(f.prompts[3]).toContain('**AC1 the badge uses the accent colour**: The badge is red');
    // Build, walkthrough, review; then the fix, walkthrough, review.
    expect(f.prompts).toHaveLength(6);
    expect(f.prompts[1]).toMatch(/^You are validating/);
    expect(f.prompts[2]).toMatch(/^You are an independent reviewer/);
    // Each validation's files are kept in the run folder before the review is read (A1256).
    const kept = f.calls.filter((c) => c === 'keep validation' || c === 'read review');
    expect(kept).toEqual(['keep validation', 'read review', 'keep validation', 'read review']);
    expect(f.comments[1]).toContain('## Fidelity');
    expect(f.comments[1]).toContain(
      '| ✅ Match | ![mockup](./ac1-mockup.png) | ![screenshot](./ac1.png) |',
    );
  });

  it("puts what isn't fixed after the last round in the PR as a deviation (F19)", async () => {
    const red = review('mismatch', 'Still red');
    const f = fake({ paths: ['apps/web/src/a.ts'], result: webDone, reviews: [red, red, red] });
    const outcome = await runImplement(f.deps, { item: card, spec, prompt: 'p', plan: 'AC1 …' });
    expect(outcome.kind).toBe('in-review');
    expect(f.comments[1]).toContain('⚠️ Deviation');
    expect(f.comments[1]).toContain('Not fixed in the rounds allowed: Still red');
  });

  it("writes the PR body with the gate's decision numbers and the factory's proof, not the agent's stale words", async () => {
    // PEN-73's PR #148 said "decision A-NEW-1 amends A1220" after the gate made it A1303, and
    // PEN-63's #152 kept risks about specs the factory's proof had since run, and passed.
    const f = fake({
      paths: ['apps/web/src/a.ts'],
      result: {
        ...webDone,
        summary: 'Download buttons are one component; decision A-NEW-1 amends A1220.',
        decisions: ['A-NEW-1: one DownloadButton draws every download button', 'A-NEW-10 stays'],
        risks: [
          'The Mac spec (test/e2e/download.spec.ts) and the Android instrumented test could not be run in the sandbox (no VM, no emulator).',
          'Prettier re-padded the decisions table around A-NEW-1; the gate renumbers and reformats it.',
          'A-NEW-2 may read oddly on a narrow phone.',
        ],
      },
      reviews: [
        JSON.stringify({
          rows: [
            {
              criterion: 'AC1 the hero follows A-NEW-1',
              verdict: 'deviation',
              note: 'A-NEW-1 keeps the old label on Android',
            },
          ],
        }),
      ],
    });
    const base = f.deps;
    f.deps = {
      ...base,
      openSandbox: async (branch) => {
        const box = await base.openSandbox(branch);
        return {
          ...box,
          exec: (command) =>
            command.startsWith('git log')
              ? Promise.resolve({
                  exitCode: 0,
                  stdout:
                    'Site: one DownloadButton\nNumber the new decisions: A-NEW-1 is A1301, A-NEW-2 is A1302\nRenumber the decisions main already has: A1301 is now A1303\n',
                  stderr: '',
                })
              : box.exec(command),
        };
      },
    };
    const outcome = await runImplement(f.deps, { item: card, spec, prompt: 'p', plan: 'AC1 …' });
    expect(outcome.kind).toBe('in-review');
    const body = f.comments[1]!;
    expect(body).toContain('Download buttons are one component; decision A1303 amends A1220.');
    expect(body).toContain('- A1303: one DownloadButton draws every download button');
    // Whole words only: the gate gave A-NEW-10 no number, so it stays as the agent wrote it.
    expect(body).toContain('- A-NEW-10 stays');
    expect(body).toContain('- A1302 may read oddly on a narrow phone.');
    expect(body).toContain('AC1 the hero follows A1303<br>A1303 keeps the old label on Android');
    expect(body).not.toMatch(/A-NEW-1\b/);
    expect(body).toContain(
      "could not be run in the sandbox (no VM, no emulator). (The factory's proof ran the Mac and Android specs: passed.)",
    );
    expect(body).not.toContain('Prettier re-padded');
  });

  it('renders the agreed mockups before the capture session, and tells it which PNGs are there (A1323)', async () => {
    const rendered = [
      JSON.stringify({ file: 'ac1.html', png: 'ac1-mockup.png', width: 390, height: 844 }),
      JSON.stringify({ file: 'ac2.html', error: 'page.screenshot: Timeout 15000ms exceeded.' }),
    ].join('\n');
    const f = fake({
      paths: ['apps/web/src/a.ts'],
      result: webDone,
      reviews: [review('match')],
      rendered,
    });
    await runImplement(f.deps, { item: card, spec, prompt: 'p', plan: 'AC1 …' });
    const staged = f.calls.indexOf('mockups');
    const render = f.calls.findIndex((c) => /^exec \d+: cd 'apps\/web' && node - /.test(c));
    expect(staged).toBeGreaterThan(-1);
    expect(render).toBeGreaterThan(staged);
    // Between staging and the capture session, the build's own agent round long done.
    expect(f.calls.indexOf('agent', render)).toBeGreaterThan(render);
    expect(f.calls.slice(staged, render)).not.toContain('agent');
    const capture = f.prompts[1]!;
    expect(capture).toMatch(/^You are validating/);
    expect(capture).toContain("so don't render them again");
    expect(capture).toContain('- `ac1-mockup.png`, 390×844, from `ac1.html`.');
    expect(capture).toContain(
      "- `ac2.html` couldn't be rendered (page.screenshot: Timeout 15000ms exceeded.). Render it yourself to `ac2-mockup.png`",
    );
    expect(capture).not.toContain('Render each one to');
    // One criterion per test, with a short timeout, so a hang costs seconds.
    expect(capture).toContain('one criterion per test');
    expect(capture).toContain('`--timeout=20000`');
  });

  it("gives the reviewer the agreed plan's words, which win over its mockup (PEN-63)", async () => {
    const plan = 'AC4 When a note is moved on Android, the snackbar shall show no leading glyph.';
    const f = fake({ paths: ['apps/web/src/a.ts'], result: webDone, reviews: [review('match')] });
    await runImplement(f.deps, { item: card, spec, prompt: 'p', plan });
    const reviewer = f.prompts[2]!;
    expect(reviewer).toMatch(/^You are an independent reviewer/);
    expect(reviewer).toContain(`## The agreed plan\n\n${plan}`);
    expect(reviewer).toContain(
      "Where the plan's words and its mockup disagree, the plan's words win.",
    );
    expect(reviewer).toContain(
      'A screenshot that follows the words but not the mockup is a `deviation` whose note quotes the plan',
    );
    expect(reviewer).toContain('never a `mismatch`');
    expect(reviewer).toContain('One that follows the mockup against the words is a `mismatch`.');
  });

  it("gives the reviewer the builder's reasons for what it couldn't do (F19)", async () => {
    const f = fake({
      paths: ['apps/web/src/a.ts'],
      result: { ...webDone, risks: ['AC1: Safari has no :has(), so the badge stays flat'] },
      reviews: [review('deviation', 'Flat badge: Safari has no :has()')],
    });
    const outcome = await runImplement(f.deps, { item: card, spec, prompt: 'p', plan: 'AC1 …' });
    expect(outcome.kind).toBe('in-review');
    expect(f.prompts[2]).toMatch(/^You are an independent reviewer/);
    expect(f.prompts[2]).toContain('- AC1: Safari has no :has(), so the badge stays flat');
    expect(f.comments[1]).toContain('- **AC1 the badge uses the accent colour**: Flat badge');
  });

  it("shows the validation and review sessions the issue's images (A1277)", async () => {
    const f = fake({ paths: ['apps/web/src/a.ts'], result: webDone, reviews: [review('match')] });
    const images = "## The issue's images\n\n1. `.factory/attachments/0a1b.png`";
    await runImplement(f.deps, { item: card, spec, prompt: 'p', plan: 'AC1 …', images });
    expect(f.prompts[1]).toMatch(/^You are validating/);
    expect(f.prompts[1]).toContain('`.factory/attachments/0a1b.png`');
    expect(f.prompts[2]).toMatch(/^You are an independent reviewer/);
    expect(f.prompts[2]).toContain('`.factory/attachments/0a1b.png`');
  });

  it('tells the validation and review sessions when the issue has no images', async () => {
    const f = fake({ paths: ['apps/web/src/a.ts'], result: webDone, reviews: [review('match')] });
    await runImplement(f.deps, { item: card, spec, prompt: 'p', plan: 'AC1 …' });
    expect(f.prompts[1]).toContain("## The issue's images\n\nThe issue has none.");
    expect(f.prompts[2]).toContain("## The issue's images\n\nThe issue has none.");
  });

  const androidDone: AgentResult = {
    ...done,
    platforms: { android: { inScope: true, proofSpecs: ['app.penmoss.EditorScreenTest'] } },
  };
  const macDone: AgentResult = {
    ...done,
    platforms: { mac: { inScope: true, proofSpecs: ['test/e2e/app.spec.ts'] } },
  };

  it('walks a Mac and Android change on each app, then tells the reviewer what each walk did (PEN-94)', async () => {
    const f = fake({
      paths: ['apps/web/src/a.ts', 'apps/desktop/src/b.ts', 'apps/android/app/src/c.kt'],
      result: webDone,
      reviews: [review('match')],
      walks: {
        mac: { platform: 'mac', captures: ['ac3-mac.png'] },
        android: {
          platform: 'android',
          captures: [],
          problem: 'The walkthrough failed. It printed nothing.',
        },
      },
    });
    const outcome = await runImplement(f.deps, { item: card, spec, prompt: 'p', plan: 'AC1 …' });
    expect(outcome.kind).toBe('in-review');
    // After the capturing session and before the reviewer's: Android first, then the VM.
    const walked = f.calls.filter((c) => c.startsWith('walk') || c === 'agent' || c === 'vm check');
    expect(walked.slice(-5)).toEqual(['agent', 'walk android', 'vm check', 'walk mac', 'agent']);
    // The walkthroughs are gone from the worktree once reviewed: a later round's gate would lint them.
    const reviewed = f.calls.lastIndexOf('agent');
    expect(f.calls.slice(reviewed)).toContainEqual(
      expect.stringMatching(
        /^exec \d+: rm -f apps\/android\/app\/src\/androidTest\/java\/app\/penmoss\/walk\/FactoryWalkInstrumentedTest\.kt apps\/desktop\/test\/e2e\/factory-walk\.spec\.ts$/,
      ),
    );
    expect(f.prompts.at(-2)).toContain('**web, mac, android**');
    const reviewer = f.prompts.at(-1)!;
    expect(reviewer).toMatch(/^You are an independent reviewer/);
    expect(reviewer).toContain(
      '- **Mac: the Electron app in the test VM**: captured `ac3-mac.png`.',
    );
    expect(reviewer).toContain(
      "- **Android: the app on the factory's emulator**: captured nothing. The walkthrough failed. It printed nothing.",
    );
  });

  it('validates a change only the Android app shows (PEN-94)', async () => {
    const f = fake({
      paths: ['apps/android/app/src/c.kt'],
      result: androidDone,
      reviews: [review('match')],
    });
    await runImplement(f.deps, { item: card, spec, prompt: 'p', plan: 'AC1 …' });
    expect(f.calls).toContain('walk android');
    expect(f.calls).not.toContain('walk mac');
    expect(f.prompts.some((p) => p.includes('**android**'))).toBe(true);
  });

  it('makes the Mac walkthrough wait for the test VM, as the Mac proof does (PEN-94)', async () => {
    const busy = { ok: false as const, reason: 'penmoss-test is busy with another run' };
    const f = fake({
      paths: ['apps/desktop/src/b.ts'],
      result: macDone,
      reviews: [review('match')],
      // Free for the proof, then busy twice for the walkthrough.
      vmChecks: [{ ok: true }, busy, busy],
    });
    const outcome = await runImplement(f.deps, { item: card, spec, prompt: 'p', plan: 'AC1 …' });
    expect(outcome.kind).toBe('in-review');
    expect(f.waits).toContain(
      'the Mac walkthrough waits for the test VM: penmoss-test is busy with another run',
    );
    expect(f.calls.filter((c) => c === 'walk mac')).toHaveLength(1);
    expect(f.waits.at(-1)).toBeNull();
  });

  it('tells the reviewer why a walkthrough could not run, rather than failing validation', async () => {
    const f = fake({
      paths: ['apps/android/app/src/c.kt'],
      result: androidDone,
      reviews: [review('match')],
      walks: { android: new Error('the emulator exited') },
    });
    const outcome = await runImplement(f.deps, { item: card, spec, prompt: 'p', plan: 'AC1 …' });
    expect(outcome.kind).toBe('in-review');
    expect(f.prompts.at(-1)).toContain("captured nothing. It couldn't run: the emulator exited.");
  });

  it('skips validation without an agreed plan (plan:skip)', async () => {
    const f = fake({ paths: ['apps/web/src/a.ts'], result: webDone });
    await runImplement(f.deps, { item: card, spec, prompt: 'p' });
    expect(f.calls).not.toContain('mockups');
  });

  it('posts the questions and sets Blocked on needs-info, without pushing', async () => {
    const f = fake({
      result: { ...done, status: 'needs-info', questions: ['Which file? Proposed: docs/cli.md'] },
    });
    const outcome = await runImplement(f.deps, { item: card, spec, prompt: 'p' });
    expect(outcome).toEqual({ kind: 'blocked', reason: 'needs-info' });
    expect(f.calls.slice(-2)).toEqual(['comment #42', 'blocked']);
    expect(f.calls.some((c) => c.startsWith('push'))).toBe(false);
    expect(f.comments.at(-1)).toContain('1. Which file? Proposed: docs/cli.md');
  });

  it('sends a result without a Release note back once, then puts the note in the PR (PEN-105)', async () => {
    const bare: AgentResult = { ...done };
    delete (bare as { releaseNote?: string }).releaseNote;
    const f = fake({
      agentRounds: [bare, { ...done, releaseNote: 'fixed: the typo in the CLI docs is gone.' }],
    });
    const outcome = await runImplement(f.deps, { item: card, spec, prompt: 'p' });
    expect(outcome.kind).toBe('in-review');
    expect(f.calls.filter((c) => c === 'agent')).toHaveLength(2);
    expect(f.events).toContain('release-note-refused');
    expect(f.prompts[1]).toContain('## Your Release note');
    expect(f.prompts[1]).toContain('`.factory/result.json` has no `releaseNote`.');
    // The PR shows the note as the check reads it, its kind written out.
    expect(f.comments[1]).toContain(
      '## Release note\n\nFixed: the typo in the CLI docs is gone.\n',
    );
  });

  it('blocks without pushing when the Release note is still wrong after one more try', async () => {
    const bad = { ...done, releaseNote: 'Changed: something' };
    const f = fake({ agentRounds: [bad, bad] });
    const outcome = await runImplement(f.deps, { item: card, spec, prompt: 'p' });
    expect(outcome).toEqual({ kind: 'blocked', reason: 'release-note' });
    expect(f.calls.filter((c) => c === 'agent')).toHaveLength(2);
    expect(f.prompts[1]).toContain('start with New, Improved or Fixed');
    expect(f.comments.at(-1)).toContain("still doesn't pass the check");
    expect(f.calls.some((c) => c.startsWith('push'))).toBe(false);
    expect(f.calls.at(-1)).toBe('blocked');
  });

  it('blocks when the agent stops instead of fixing its Release note', async () => {
    const bare: AgentResult = { ...done };
    delete (bare as { releaseNote?: string }).releaseNote;
    const f = fake({ agentRounds: [bare, { ...done, status: 'failed', summary: 'gave up' }] });
    const outcome = await runImplement(f.deps, { item: card, spec, prompt: 'p' });
    expect(outcome).toEqual({ kind: 'blocked', reason: 'release-note' });
    expect(f.comments.at(-1)).toContain('the agent stopped instead: gave up');
  });

  it('gives the agent rounds.gateFix more tries, then blocks without pushing', async () => {
    const f = fake({ paths: ['.github/x.yml'], gateExit: 1 });
    const outcome = await runImplement(f.deps, { item: card, spec, prompt: 'p' });
    expect(outcome).toEqual({ kind: 'blocked', reason: 'gate-failed' });
    expect(f.calls.filter((c) => c === 'agent')).toHaveLength(config.rounds.gateFix + 1);
    expect(f.comments.at(-1)).toContain('after 3 round(s)');
    expect(f.calls.some((c) => c.startsWith('push'))).toBe(false);
    expect(f.calls.at(-1)).toBe('blocked');
  });

  it('installs the rebased dependencies before the check, and a failed install goes to the agent (A1251)', async () => {
    const f = fake({ paths: ['.github/x.yml'], installExit: 1 });
    const outcome = await runImplement(f.deps, { item: card, spec, prompt: 'p' });
    expect(outcome).toEqual({ kind: 'blocked', reason: 'gate-failed' });
    expect(f.comments.at(-1)).toContain('pnpm install --frozen-lockfile --prefer-offline');
    expect(f.calls.some((c) => c.endsWith(': task check') || c.endsWith(': task lint'))).toBe(
      false,
    );
  });

  it('blocks when the agent leaves uncommitted changes', async () => {
    const f = fake({ dirty: true });
    expect(await runImplement(f.deps, { item: card, spec, prompt: 'p' })).toEqual({
      kind: 'blocked',
      reason: 'gate-failed',
    });
  });

  it('blocks when the agent commits nothing or writes no result', async () => {
    expect(
      await runImplement(fake({ commits: 0 }).deps, { item: card, spec, prompt: 'p' }),
    ).toEqual({ kind: 'blocked', reason: 'no-commits' });
    const f = fake({ result: { error: 'the agent wrote no .factory/result.json' } });
    expect(await runImplement(f.deps, { item: card, spec, prompt: 'p' })).toEqual({
      kind: 'blocked',
      reason: 'the agent wrote no .factory/result.json',
    });
    expect(f.calls).toContain('close 1');
  });
});

describe('the Mac proof waits for the test VM (F7, F10)', () => {
  const macDone: AgentResult = {
    ...done,
    platforms: { mac: { inScope: true, proofSpecs: ['test/e2e/app.spec.ts'] } },
  };
  const mac = { paths: ['apps/desktop/src/main.ts'], result: macDone };
  const count = (calls: string[], prefix: string) =>
    calls.filter((c) => c.startsWith(prefix)).length;

  it("waits a poll at a time while the VM can't take it, then records, with no round used", async () => {
    const f = fake({
      ...mac,
      vmChecks: [
        { ok: false, reason: 'penmoss-test is busy with another run' },
        { ok: false, reason: 'penmoss-test is busy with another run' },
        { ok: false, reason: 'tart is not installed: see docs/ci.md' },
      ],
    });
    const outcome = await runImplement(f.deps, { item: card, spec, prompt: 'p' });
    expect(outcome.kind).toBe('in-review');
    expect(count(f.calls, 'vm check')).toBe(4);
    expect(count(f.calls, 'proof mac')).toBe(1);
    expect(count(f.calls, 'agent')).toBe(1);
    expect(f.calls).not.toContain('blocked');
    expect(f.waits).toEqual([
      'the Mac proof waits for the test VM: penmoss-test is busy with another run',
      'the Mac proof waits for the test VM: penmoss-test is busy with another run',
      'the Mac proof waits for the test VM: tart is not installed: see docs/ci.md',
      null,
    ]);
    // A poll between checks; the ledger says so once per reason.
    expect(f.slept.slice(0, 3)).toEqual([60, 60, 60]);
    expect(f.events.filter((e) => e === 'proof-waiting')).toHaveLength(2);
    // The check comes right before the proof: a VM found free is used at once.
    expect(f.calls.indexOf('proof mac: test/e2e/app.spec.ts') - 1).toBe(
      f.calls.lastIndexOf('vm check'),
    );
  });

  it("treats a VM that doesn't boot (the script's exit 75) as a wait, not a failure", async () => {
    const f = fake({ ...mac, vmBootFails: 2 });
    const outcome = await runImplement(f.deps, { item: card, spec, prompt: 'p' });
    expect(outcome.kind).toBe('in-review');
    expect(count(f.calls, 'proof mac')).toBe(3);
    expect(count(f.calls, 'agent')).toBe(1);
    expect(f.waits[0]).toBe(
      'the Mac proof waits for the test VM: penmoss-test did not answer in 3 minutes',
    );
    expect(f.waits.at(-1)).toBeNull();
  });

  it('stops Blocked with the reason only after macProof.waitHours', async () => {
    const reason = "penmoss-test isn't made yet: run task desktop:test:vm once (docs/ci.md §8)";
    // The fake clock moves 30 minutes on every reading.
    const f = fake({
      ...mac,
      vmChecks: Array.from({ length: 100 }, () => ({ ok: false as const, reason })),
    });
    const outcome = await runImplement(f.deps, { item: card, spec, prompt: 'p' });
    expect(outcome).toEqual({ kind: 'blocked', reason: 'mac-vm' });
    expect(count(f.calls, 'proof mac')).toBe(0);
    // Not the agent's to fix: no gate round, straight to Blocked.
    expect(count(f.calls, 'agent')).toBe(1);
    expect(f.events).not.toContain('gate-failed');
    expect(count(f.calls, 'vm check')).toBeGreaterThan(10);
    expect(count(f.calls, 'vm check')).toBeLessThan(30);
    expect(f.calls.at(-1)).toBe('blocked');
    expect(f.comments.at(-1)).toContain(
      `The Mac proof waited 12 h for the test VM (penmoss-test), which still can't take it: ${reason}.`,
    );
    expect(f.waits.at(-1)).toBeNull();
  });

  it('gives every proof a signal that aborts at its timeout', async () => {
    const f = fake({
      paths: ['apps/web/src/a.ts'],
      result: {
        ...done,
        platforms: {
          web: { inScope: true, proofSpecs: ['a.spec.ts'] },
          mac: { inScope: true, proofSpecs: ['app.spec.ts'] },
          android: { inScope: true, proofSpecs: ['app.penmoss.EditorScreenTest'] },
        },
      },
    });
    await runImplement(f.deps, { item: card, spec, prompt: 'p' });
    expect(f.signals).toHaveLength(3);
    for (const signal of f.signals) {
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal?.aborted).toBe(false);
    }
  });
});

describe('CI after the PR opens (F6)', () => {
  it('hands a rebase conflict back to the agent, then goes on', async () => {
    const f = fake({ conflict: true });
    const outcome = await runImplement(f.deps, { item: card, spec, prompt: 'p' });
    expect(outcome.kind).toBe('in-review');
    expect(f.prompts[1]).toContain('stopped on conflicts in `docs/cli.md`');
    expect(f.prompts[1]).toContain('CONFLICT (content): docs/cli.md');
  });

  it('waits out a usage limit without using up a round (F13, R13)', async () => {
    const f = fake({ limited: 2 });
    const outcome = await runImplement(f.deps, { item: card, spec, prompt: 'p' });
    expect(outcome.kind).toBe('in-review');
    expect(f.prompts).toEqual(['p', 'p', 'p']);
    expect(f.events.filter((e) => e === 'usage-limited')).toHaveLength(2);
  });

  it('stops after the limit persists through every wait; executeRun then sets Blocked', async () => {
    const f = fake({ limited: 10 });
    await expect(runImplement(f.deps, { item: card, spec, prompt: 'p' })).rejects.toThrow(
      'usage limit 4 times in a row',
    );
  });

  it('sends a skipped test back to the agent before running the gate (F13)', async () => {
    const f = fake({ weakened: true });
    const outcome = await runImplement(f.deps, { item: card, spec, prompt: 'p' });
    expect(outcome.kind).toBe('in-review');
    expect(f.prompts[1]).toContain('The branch weakens tests');
    expect(f.prompts[1]).toContain('`apps/web/test/e2e/x.spec.ts` skips a test');
  });

  it('sends a branch that changes the workflows back to the agent before the push (A1314)', async () => {
    const f = fake({ workflowIn: (n) => n <= 2 });
    const outcome = await runImplement(f.deps, { item: card, spec, prompt: 'p' });
    expect(outcome.kind).toBe('in-review');
    expect(f.prompts[1]).toContain(
      "changes GitHub Actions' workflows (`.github/workflows/ci.yml`)",
    );
    // The refused round never reached `task lint` or the push; the fixed one did.
    expect(f.calls.indexOf('exec 2: task lint')).toBe(-1);
    expect(f.calls.filter((c) => c.startsWith('push'))).toHaveLength(1);
  });

  it("stops a CI repair round that changed the workflows before it is pushed, and tells the agent it can't (A1314)", async () => {
    // PEN-73: the repair round added a retry loop to ci.yml, and GitHub refused the factory's push.
    const f = fake({ ci: [[red]], workflowIn: (n) => n >= 4 });
    const outcome = await runImplement(f.deps, { item: card, spec, prompt: 'p' });
    expect(outcome).toEqual({ kind: 'blocked', reason: 'ci-red' });
    expect(f.prompts.at(-1)).toContain("can't push changes under `.github/workflows/`");
    expect(f.prompts.at(-1)).toContain("isn't this branch's to fix");
    expect(f.calls.filter((c) => c.startsWith('push'))).toHaveLength(1);
    expect(f.comments.at(-1)).toContain("changes GitHub Actions' workflows");
  });

  it('repairs a red check in the same PR, then moves to In review', async () => {
    const f = fake({ ci: [[red], [green]] });
    const outcome = await runImplement(f.deps, { item: card, spec, prompt: 'p' });
    expect(outcome.kind).toBe('in-review');
    expect(f.prompts.at(-1)).toContain('## CI failed (repair round 1)');
    expect(f.prompts.at(-1)).toContain('Error: lint failed at a.ts:1');
    expect(f.calls.filter((c) => c.startsWith('push'))).toHaveLength(2);
    expect(f.calls.at(-2)).toBe('status In review');
  });

  it('sets Blocked with the failing job and its log after rounds.ciRepair repairs', async () => {
    const f = fake({ ci: [[red], [red], [red]] });
    const outcome = await runImplement(f.deps, { item: card, spec, prompt: 'p' });
    expect(outcome).toEqual({ kind: 'blocked', reason: 'ci-red' });
    const last = f.comments.at(-1)!;
    expect(last).toContain('still red after 2 repair round(s)');
    expect(last).toContain(
      '[Check](https://github.com/htxryan/penmoss/actions/runs/77/job/1) (run 77)',
    );
    expect(last).toContain('Error: lint failed at a.ts:1');
    expect(f.calls).not.toContain('status In review');
    expect(f.calls.at(-1)).toBe('blocked');
  });

  it("sets Blocked with the failing job and its log when a repair round can't fix it", async () => {
    const f = fake({
      ci: [[red]],
      agentRounds: [done, { ...done, status: 'failed', summary: 'The failure is CI-only' }],
    });
    const outcome = await runImplement(f.deps, { item: card, spec, prompt: 'p' });
    expect(outcome).toEqual({ kind: 'blocked', reason: 'ci-red' });
    const last = f.comments.at(-1)!;
    expect(last).toContain("A CI repair round couldn't finish: The failure is CI-only");
    expect(last).toContain(
      '[Check](https://github.com/htxryan/penmoss/actions/runs/77/job/1) (run 77)',
    );
    expect(last).toContain('Error: lint failed at a.ts:1');
    expect(f.calls.at(-1)).toBe('blocked');
  });

  // PR #148's Site job on 11 Nov 2026, while the hosted runners couldn't resolve their apt mirror.
  const site: CheckRun = {
    name: 'Site',
    state: 'FAILURE',
    bucket: 'fail',
    link: 'https://github.com/htxryan/penmoss/actions/runs/88/job/5',
  };
  const aptLog = [
    'Run pnpm exec playwright install --with-deps chromium',
    'Installing dependencies...',
    "Err:1 http://azure.archive.ubuntu.com/ubuntu noble InRelease\n  Temporary failure resolving 'azure.archive.ubuntu.com'",
    'E: Failed to fetch http://azure.archive.ubuntu.com/ubuntu/dists/noble/InRelease',
    '##[error]Process completed with exit code 100.',
  ].join('\n');

  it("re-runs an infrastructure failure's jobs instead of a repair round, and says so once (A1312)", async () => {
    const f = fake({ ci: [[site], [site], [green]], logs: { Site: aptLog } });
    const outcome = await runImplement(f.deps, { item: card, spec, prompt: 'p' });
    expect(outcome.kind).toBe('in-review');
    expect(f.prompts).toEqual(['p']);
    expect(f.calls.filter((c) => c.startsWith('rerun'))).toEqual(['rerun 88', 'rerun 88']);
    expect(f.calls.filter((c) => c.startsWith('push'))).toHaveLength(1);
    expect(f.events.filter((e) => e === 'ci-rerun')).toHaveLength(2);
    const said = f.comments.filter((c) => c.startsWith('CI failed on an infrastructure problem'));
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('(Temporary failure resolving): Site');
  });

  it('sets Blocked, with no agent round, when the infrastructure still fails after two re-runs', async () => {
    const f = fake({ ci: [[site], [site], [site]], logs: { Site: aptLog } });
    const outcome = await runImplement(f.deps, { item: card, spec, prompt: 'p' });
    expect(outcome).toEqual({ kind: 'blocked', reason: 'ci-infra' });
    expect(f.prompts).toEqual(['p']);
    expect(f.calls.filter((c) => c.startsWith('rerun'))).toHaveLength(2);
    expect(f.comments.at(-1)).toContain("CI failed on the runners' infrastructure");
    expect(f.comments.at(-1)).toContain(
      '[Site](https://github.com/htxryan/penmoss/actions/runs/88',
    );
    expect(f.calls.at(-1)).toBe('blocked');
  });

  it("counts a run's earlier re-runs from the ledger, so a restart doesn't re-run it again", async () => {
    const pr = 'https://github.com/htxryan/penmoss/pull/900';
    const rerun = (at: string) =>
      JSON.stringify({ at, run: '42-old', event: 'ci-rerun', actionsRun: '88', pr });
    const f = fake({
      ci: [[site]],
      logs: { Site: aptLog },
      ledger: [rerun('2026-11-11T10:00:00Z'), rerun('2026-11-11T10:20:00Z')].join('\n'),
    });
    const outcome = await runImplement(f.deps, { item: card, spec, prompt: 'p' });
    expect(outcome).toEqual({ kind: 'blocked', reason: 'ci-infra' });
    expect(f.calls.filter((c) => c.startsWith('rerun'))).toEqual([]);
  });

  it('gives a repair round to a red run with one real failure beside an infrastructure one', async () => {
    const f = fake({ ci: [[site, red], [green]], logs: { Site: aptLog } });
    const outcome = await runImplement(f.deps, { item: card, spec, prompt: 'p' });
    expect(outcome.kind).toBe('in-review');
    expect(f.calls.filter((c) => c.startsWith('rerun'))).toEqual([]);
    expect(f.prompts.at(-1)).toContain('## CI failed (repair round 1)');
  });

  it('waits out a job no runner has taken, saying so once, without failing', async () => {
    const f = fake({ ci: [[queued], [queued], [queued], [green]] });
    const outcome = await runImplement(f.deps, { item: card, spec, prompt: 'p' });
    expect(outcome.kind).toBe('in-review');
    expect(
      f.comments.filter((c) => c.startsWith('CI is waiting for a free Mac runner')),
    ).toHaveLength(1);
  });
});

describe('main moves while the PR waits for CI (F6)', () => {
  // `behind` starts with `false`: the check before the first push.
  const BR = 'factory/42-fix-the-typo-in-docs-cli';
  const conflict: RebaseOutcome = {
    kind: 'conflict',
    files: ['apps/web/src/a.ts', 'docs/cli.md'],
    output: 'CONFLICT (content): Merge conflict in apps/web/src/a.ts',
  };
  const clean: RebaseOutcome = { kind: 'rebased', resolved: [], renumbered: {} };

  it('rebases once more before In review, gates again, pushes with the lease and waits for CI', async () => {
    const f = fake({
      behind: [false, true],
      rebases: [
        clean,
        { kind: 'rebased', resolved: ['docs/decisions.md'], renumbered: { A1225: 'A1226' } },
      ],
    });
    const outcome = await runImplement(f.deps, { item: card, spec, prompt: 'p' });
    expect(outcome.kind).toBe('in-review');
    expect(f.calls.slice(f.calls.indexOf('pr'))).toEqual([
      'pr',
      'checks',
      `behind? ${BR}`,
      `open ${BR}`,
      'rebase /wt/3',
      'exec 3: pnpm install --frozen-lockfile --prefer-offline',
      'exec 3: git diff origin/main...HEAD',
      'exec 3: task lint',
      'close 3',
      `push ${BR}`,
      'checks',
      'comment #42',
      'status In review',
      'notify Penmoss #42 is ready for review',
    ]);
    // The decisions conflict was the harness's to resolve: no agent round for it.
    expect(f.calls.filter((c) => c === 'agent')).toHaveLength(1);
    expect(f.events).toContain('rebased');
  });

  it('rebases a PR that GitHub says conflicts with main, since it gets no CI (A1311)', async () => {
    // PEN-63: rebased at 16:25, pushed at 16:45, and PEN-73's decision row landed between, so
    // #152 conflicted and GitHub ran no CI; the run would have waited on checks that never came.
    const f = fake({ ci: [[], []] });
    let asked = 0;
    const outcome = await runImplement(
      { ...f.deps, conflicts: () => Promise.resolve(++asked === 1) },
      { item: card, spec, prompt: 'p' },
    );
    expect(outcome.kind).toBe('in-review');
    expect(f.events).toContain('pr-conflicts');
    expect(f.calls.filter((c) => c.startsWith('push'))).toHaveLength(2);
  });

  it('sets Blocked when the PR still conflicts after the rebases allowed', async () => {
    const f = fake({ ci: Array.from({ length: 12 }, () => []) });
    const outcome = await runImplement(
      { ...f.deps, conflicts: () => Promise.resolve(true) },
      { item: card, spec, prompt: 'p' },
    );
    expect(outcome).toEqual({ kind: 'blocked', reason: 'rebase-conflict' });
    expect(f.comments.at(-1)).toMatch(/still conflicts with main after 2 rebase/);
    expect(f.calls.filter((c) => c.startsWith('push'))).toHaveLength(3);
  });

  it('keeps waiting for CI that has not started when the PR merges cleanly', async () => {
    const f = fake({ ci: [[], [], []] });
    const outcome = await runImplement(
      { ...f.deps, conflicts: () => Promise.resolve(false) },
      { item: card, spec, prompt: 'p' },
    );
    expect(outcome.kind).toBe('in-review');
    expect(f.events).not.toContain('pr-conflicts');
  });

  it("hands a conflict it can't resolve to one agent round, then goes on to review", async () => {
    const f = fake({ behind: [false, true], rebases: [clean, conflict, clean] });
    const outcome = await runImplement(f.deps, { item: card, spec, prompt: 'p' });
    expect(outcome.kind).toBe('in-review');
    expect(f.prompts).toHaveLength(2);
    expect(f.prompts[1]).toContain('## `origin/main` moved: rebase onto it');
    expect(f.prompts[1]).toContain('the local `main` branch is stale');
    expect(f.prompts[1]).toContain('stopped on conflicts in `apps/web/src/a.ts`, `docs/cli.md`');
    expect(f.calls.filter((c) => c.startsWith('push'))).toHaveLength(2);
    expect(f.calls.at(-2)).toBe('status In review');
  });

  it('sets Blocked naming the conflicting files when the fix round leaves them', async () => {
    const f = fake({ behind: [false, true], rebases: [clean, conflict, conflict] });
    const outcome = await runImplement(f.deps, { item: card, spec, prompt: 'p' });
    expect(outcome).toEqual({ kind: 'blocked', reason: 'rebase-conflict' });
    const last = f.comments.at(-1)!;
    expect(last).toContain(
      'no longer rebases onto main: `apps/web/src/a.ts`, `docs/cli.md` conflict',
    );
    expect(last).toContain('event=blocked');
    expect(f.calls.filter((c) => c.startsWith('push'))).toHaveLength(1);
    expect(f.calls).not.toContain('status In review');
    expect(f.calls.at(-1)).toBe('blocked');
  });

  it('sets Blocked when the agent stops in its fix round, without pushing', async () => {
    const f = fake({
      behind: [false, true],
      rebases: [clean, conflict],
      agentRounds: [done, { ...done, status: 'failed', summary: 'both sides rename the route' }],
    });
    const outcome = await runImplement(f.deps, { item: card, spec, prompt: 'p' });
    expect(outcome).toEqual({ kind: 'blocked', reason: 'rebase-conflict' });
    expect(f.comments.at(-1)).toContain(
      "the agent's fix round stopped: both sides rename the route",
    );
    expect(f.calls.filter((c) => c.startsWith('push'))).toHaveLength(1);
  });

  it('gives a gate the rebase broke to the agent with the failure', async () => {
    const f = fake({ behind: [false, true] });
    let gates = 0;
    const base = f.deps;
    f.deps = {
      ...base,
      openSandbox: async (branch) => {
        const box = await base.openSandbox(branch);
        return {
          ...box,
          exec: (command) =>
            command === 'task lint' && ++gates === 2
              ? Promise.resolve({ exitCode: 1, stdout: 'main renamed lint:md', stderr: '' })
              : box.exec(command),
        };
      },
    };
    const outcome = await runImplement(f.deps, { item: card, spec, prompt: 'p' });
    expect(outcome.kind).toBe('in-review');
    expect(f.prompts[1]).toContain('## The gate after rebasing onto `origin/main`');
    expect(f.prompts[1]).toContain('main renamed lint:md');
  });
});

describe('helpers', () => {
  it('names the branch from the issue', () => {
    expect(
      branchName(config, item(7, { title: '  Ünïcode & "quotes": the Settings → Status page!' })),
    ).toBe('factory/7-n-code-quotes-the-settings-status');
    expect(branchName(config, item(8, { title: '!!!' }))).toBe('factory/8-issue');
  });
  it('gates docs with lint and everything else with task check', () => {
    expect(gateCommand({ kind: 'docs-only', platforms: [] })).toBe('task lint');
    expect(gateCommand({ kind: 'ci-only', platforms: [] })).toBe('task check');
  });
});

describe('prTitle', () => {
  // PEN-75's PR title was the agent's whole 150-character summary.
  const summary =
    'Linked "Ryan Henderson" in the brochure footer to https://ryanhenderson.dev, styled the footer link to inherit its colour with the accent on hover, and covered it with a site Playwright test';

  it('is the commit subject, with the card named nowhere in it', () => {
    for (const subject of [
      'Site: link Ryan Henderson in the footer to ryanhenderson.dev (PEN-75)',
      'PEN-75: Site: link Ryan Henderson in the footer to ryanhenderson.dev',
      'Site: link Ryan Henderson in the footer to ryanhenderson.dev [pen-75]',
    ])
      expect(prTitle({ subject, summary, key: 'PEN-75' })).toBe(
        'Site: link Ryan Henderson in the footer to ryanhenderson.dev',
      );
  });

  it("falls back to the summary's first sentence, cut at a word to 72 characters", () => {
    const title = prTitle({ summary, key: 'PEN-75' });
    expect(title.length).toBeLessThanOrEqual(TITLE_MAX);
    expect(title).toBe('Linked "Ryan Henderson" in the brochure footer to…');
    expect(prTitle({ summary: 'Fix the typo. Also tidied PEN-9.', key: 'PEN-9' })).toBe(
      'Fix the typo',
    );
    // The numbering commit is the host's, never the change's title.
    expect(
      prTitle({ subject: 'Number the new decisions: A1236 is A1240', summary, key: 'PEN-75' }),
    ).toBe(title);
  });

  it('cuts a long subject too, and leaves an unrelated id alone', () => {
    const long = `Desktop: ${'make the sidebar remember its width '.repeat(3)}`;
    const title = prTitle({ subject: long, summary, key: 'PEN-1' });
    expect(title.length).toBeLessThanOrEqual(TITLE_MAX);
    expect(title.endsWith('…')).toBe(true);
    expect(prTitle({ subject: 'Fix #12 and SPEC-3', summary, key: '#12' })).toBe(
      'Fix #12 and SPEC-3',
    );
  });
});

describe('openOrReusePr (R12)', () => {
  const fakeGh = (open: { number: number; url: string }[]) => {
    const calls: string[][] = [];
    const gh: Gh = {
      run: (args) => {
        calls.push([...args]);
        return Promise.resolve('https://github.com/htxryan/penmoss/pull/901\n');
      },
      json: <T>(args: readonly string[]) => {
        calls.push([...args]);
        return Promise.resolve(open as T);
      },
      graphql: () => Promise.reject(new Error('unused')),
    };
    return { gh, calls };
  };
  const pr = {
    repo: config.repo,
    branch: 'factory/42-x',
    title: 'T',
    bodyFile: '/tmp/body.md',
    reviewer: config.owner,
  };

  it('opens a PR for a new branch, asking Ryan to review', async () => {
    const f = fakeGh([]);
    expect(await openOrReusePr(f.gh, pr)).toBe('https://github.com/htxryan/penmoss/pull/901');
    expect(f.calls.at(-1)?.slice(0, 2)).toEqual(['pr', 'create']);
    expect(f.calls.at(-1)).toContain('--reviewer');
  });

  it("updates the branch's open PR when a restarted run publishes again, instead of failing", async () => {
    const f = fakeGh([{ number: 900, url: 'https://github.com/htxryan/penmoss/pull/900' }]);
    expect(await openOrReusePr(f.gh, pr)).toBe('https://github.com/htxryan/penmoss/pull/900');
    expect(f.calls.at(-1)?.slice(0, 4)).toEqual([
      'api',
      '-X',
      'PATCH',
      'repos/htxryan/penmoss/pulls/900',
    ]);
    expect(f.calls.some((c) => c[1] === 'create')).toBe(false);
  });
});

describe('main moves while proof and validation run, before the first push', () => {
  // PEN-63: the gate rebased at 16:25, proof and validation took 20 minutes, another PR's
  // decision row merged at 16:43, and the 16:45 push made a PR that conflicted with main.
  const BR = 'factory/42-fix-the-typo-in-docs-cli';
  /** The sandboxes' `git rev-parse` and `git diff --name-only` (what the rebase changed) and `git log`. */
  function withGit(f: Fake, git: { changed: string[]; log?: string }): RunDeps {
    const base = f.deps;
    return {
      ...base,
      openSandbox: async (branch) => {
        const box = await base.openSandbox(branch);
        const ok = (stdout: string) => Promise.resolve({ exitCode: 0, stdout, stderr: '' });
        return {
          ...box,
          exec: (command) => {
            if (command === 'git rev-parse HEAD') {
              f.calls.push(`exec: ${command}`);
              return ok('0123456789abcdef0123456789abcdef01234567\n');
            }
            if (command.startsWith('git diff --name-only')) {
              f.calls.push(`exec: ${command}`);
              return ok(git.changed.join('\n'));
            }
            if (command.startsWith('git log') && git.log) return ok(git.log);
            return box.exec(command);
          },
        };
      },
    };
  }
  const decisionsOnly: RebaseOutcome = {
    kind: 'rebased',
    resolved: ['docs/decisions.md'],
    renumbered: { A1301: 'A1303' },
  };

  it('rebases again, and pushes without gating again when main brought only decision rows', async () => {
    const f = fake({
      behind: [true],
      rebases: [{ kind: 'rebased', resolved: [], renumbered: {} }, decisionsOnly],
      result: { ...done, decisions: ['A-NEW-1: one download button'] },
    });
    const deps = withGit(f, {
      changed: ['docs/decisions.md'],
      log: 'Docs: fix the typo\nNumber the new decisions: A-NEW-1 is A1301\nRenumber the decisions main already has: A1301 is now A1303\n',
    });
    const outcome = await runImplement(deps, { item: card, spec, prompt: 'p' });
    expect(outcome.kind).toBe('in-review');
    expect(f.calls.slice(f.calls.indexOf('close 2'), f.calls.indexOf('pr') + 1)).toEqual([
      'close 2',
      `behind? ${BR}`,
      `open ${BR}`,
      'exec: git rev-parse HEAD',
      'rebase /wt/3',
      'exec: git diff --name-only 0123456789abcdef0123456789abcdef01234567 HEAD',
      'close 3',
      `push ${BR}`,
      'pr',
    ]);
    // One gate, one agent round: the decisions were the harness's to merge.
    expect(f.calls.filter((c) => c.endsWith('task lint'))).toHaveLength(1);
    expect(f.calls.filter((c) => c === 'agent')).toHaveLength(1);
    expect(f.calls.filter((c) => c.startsWith('push'))).toHaveLength(1);
    // The PR body has the number the branch has after this rebase.
    expect(f.comments[1]).toContain('- A1303: one download button');
  });

  it('gates again, but records no proof again, when main brought code', async () => {
    const f = fake({ behind: [true], paths: ['apps/web/src/a.ts'], result: webDoneForPush });
    const deps = withGit(f, { changed: ['docs/decisions.md', 'apps/web/src/b.ts'] });
    const outcome = await runImplement(deps, { item: card, spec, prompt: 'p' });
    expect(outcome.kind).toBe('in-review');
    expect(f.calls.filter((c) => c.endsWith('task check'))).toHaveLength(2);
    expect(f.calls.filter((c) => c.startsWith('proof web'))).toHaveLength(1);
    const before = f.calls.slice(0, f.calls.indexOf('pr'));
    expect(before.at(-2)).toBe('close 3');
    expect(before.at(-1)).toBe(`push ${BR}`);
    expect(f.calls.filter((c) => c.startsWith('push'))).toHaveLength(1);
  });

  it("hands a conflict it can't resolve to the agent, gates again and pushes once", async () => {
    const f = fake({
      behind: [true],
      rebases: [
        { kind: 'rebased', resolved: [], renumbered: {} },
        {
          kind: 'conflict',
          files: ['apps/web/src/a.ts'],
          output: 'CONFLICT (content): Merge conflict in apps/web/src/a.ts',
        },
      ],
    });
    const deps = withGit(f, { changed: [] });
    const outcome = await runImplement(deps, { item: card, spec, prompt: 'p' });
    expect(outcome.kind).toBe('in-review');
    expect(f.prompts[1]).toContain('## `origin/main` moved: rebase onto it');
    expect(f.prompts[1]).toContain(`\`${BR}\` no longer rebases onto \`origin/main\``);
    // The gate after the agent's fix always runs its check.
    expect(f.calls.filter((c) => c.endsWith('task lint'))).toHaveLength(2);
    expect(f.calls.filter((c) => c.startsWith('push'))).toHaveLength(1);
    expect(f.calls.indexOf(`push ${BR}`)).toBeLessThan(f.calls.indexOf('pr'));
  });

  it("sets Blocked with the files named, and pushes nothing, when the agent can't resolve it", async () => {
    const conflict: RebaseOutcome = {
      kind: 'conflict',
      files: ['apps/web/src/a.ts'],
      output: 'CONFLICT (content): Merge conflict in apps/web/src/a.ts',
    };
    const f = fake({
      behind: [true],
      rebases: [{ kind: 'rebased', resolved: [], renumbered: {} }, conflict, conflict],
    });
    const outcome = await runImplement(withGit(f, { changed: [] }), {
      item: card,
      spec,
      prompt: 'p',
    });
    expect(outcome).toEqual({ kind: 'blocked', reason: 'rebase-conflict' });
    expect(f.comments.at(-1)).toContain(
      'no longer rebases onto main: `apps/web/src/a.ts` conflict',
    );
    expect(f.calls.filter((c) => c.startsWith('push'))).toHaveLength(0);
    expect(f.calls).not.toContain('pr');
    expect(f.calls.at(-1)).toBe('blocked');
  });
});

const webDoneForPush: AgentResult = {
  ...done,
  platforms: {
    web: { inScope: true, proofSpecs: ['comments.spec.ts'] },
    mac: { inScope: true, proofSpecs: ['app.spec.ts'] },
    android: { inScope: true, proofSpecs: ['app.penmoss.EditorScreenTest'] },
  },
};
