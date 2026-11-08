/**
 * One implementation run, start to finish (F4, #263): claim the card, give the agent a sandbox
 * on its own branch, gate its work in a fresh sandbox, then push, open the PR and move the card
 * to In review. Every outside effect goes through `RunDeps`, so the sequence is tested without
 * GitHub, git or an agent.
 *
 * The harness owns every side effect (R18): the agent only commits. A run that needs Ryan, or
 * that fails, says why on the issue and sets Blocked; the card keeps its status (R5).
 */
import type { Board, BoardItem } from './board.ts';
import type { FactoryConfig, Platform, SlotConfig } from './config.ts';
import type { IssueSpec } from './labels.ts';
import { runIdOf, summarizeChecks, type CheckRun } from './checks.ts';
import { classify, proofPlatforms, type Scope } from './platforms.ts';
import { fidelityFeedback, renderFidelity, settle, type FidelityRow } from './fidelity.ts';
import { scanWeakenedTests, weakenedFeedback } from './gate.ts';
import { usageLimitReset } from './limits.ts';
import { validate } from './validate.ts';
import { renderPrBody, type AttachedProof } from './proof/body.ts';
import { missingProof, type ProofItem } from './proof/manifest.ts';
import { formatMarker } from './pick.ts';
import type { AgentResult } from './result.ts';

export type RunEvent =
  | 'claimed'
  | 'agent-started'
  | 'agent-finished'
  | 'needs-info'
  | 'failed'
  | 'gate-passed'
  | 'gate-failed'
  | 'pushed'
  | 'decisions-numbered'
  | 'proof-recorded'
  | 'pr-opened'
  | 'ci-red'
  | 'ci-repaired'
  | 'ci-stalled'
  | 'in-review'
  | 'blocked'
  | 'usage-limited'
  | 'validated';

export interface RunSandbox {
  readonly worktreePath: string;
  exec(
    command: string,
  ): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }>;
  close(): Promise<void>;
}

export interface RunDeps {
  readonly config: FactoryConfig;
  readonly slot: SlotConfig;
  readonly runId: string;
  /** The board as read when the run started. */
  readonly board: Board;
  comment(issue: number, body: string): Promise<void>;
  setStatus(item: BoardItem, status: string): Promise<void>;
  setBlocked(item: BoardItem): Promise<void>;
  /** A sandbox on `branch` (made from origin/main when new). */
  openSandbox(branch: string): Promise<RunSandbox>;
  /** Runs the agent in the sandbox with the prompt; resolves when it exits, with its output's tail. */
  runAgent(sandbox: RunSandbox, prompt: string): Promise<{ readonly output: string } | void>;
  /** `.factory/result.json` from the worktree, parsed (or why it couldn't be). */
  readResult(
    sandbox: RunSandbox,
  ): Promise<{ ok: true; result: AgentResult } | { ok: false; error: string }>;
  /** Paths changed on the branch against origin/main, and how many commits it has. */
  diff(branch: string): Promise<{ readonly paths: readonly string[]; readonly commits: number }>;
  /** Runs a platform's proof specs in the sandbox with recording on. */
  recordProof(
    sandbox: RunSandbox,
    platform: Platform,
    specs: readonly string[],
  ): Promise<ProofItem[]>;
  /** Converts and checks the recordings, into the folder the PR body is written in. */
  prepareProof(
    items: readonly ProofItem[],
  ): Promise<{ ok: true; proof: AttachedProof[] } | { ok: false; error: string }>;
  /** Fetches origin/main into the factory's clone. */
  fetchMain(): Promise<void>;
  /** Gives A-NEW-n decisions real numbers in the sandbox's worktree; returns what it assigned. */
  numberDecisions(sandbox: RunSandbox): Promise<Record<string, string>>;
  /** Pushes the branch (with lease: rebases rewrite it). */
  push(branch: string): Promise<void>;
  /** The PR's checks, from `gh pr checks`. */
  checks(pr: string): Promise<CheckRun[]>;
  /** The last lines of a failed check's log. */
  failedLog(check: CheckRun): Promise<string>;
  /** F19's validation: mockups in, the reviewer's verdicts out (see validate.ts). */
  stageMockups(sandbox: RunSandbox): Promise<void>;
  readReview(sandbox: RunSandbox): Promise<string | null>;
  collectFidelity(sandbox: RunSandbox, rows: readonly FidelityRow[]): Promise<FidelityRow[]>;
  /** Runs `fn` holding one of the Mac's heavy-job slots (W12, A1216). */
  heavy<T>(label: string, fn: () => Promise<T>): Promise<T>;
  notify(title: string, message: string): Promise<void>;
  sleep(seconds: number): Promise<void>;
  now(): Date;
  openPr(input: {
    branch: string;
    title: string;
    body: string;
    proof: readonly AttachedProof[];
    /** More files in the body's folder to attach: the fidelity images. */
    files?: readonly string[];
  }): Promise<string>;
  log(event: RunEvent, detail?: Record<string, unknown>): void;
}

export interface RunInput {
  readonly item: BoardItem;
  readonly spec: IssueSpec;
  readonly prompt: string;
  /** The agreed plan and design artifacts, for the PR body (F16). */
  readonly artifacts?: readonly { readonly label: string; readonly href: string }[];
  /** The agreed plan as text: when set, web changes are validated against it (F19). */
  readonly plan?: string;
}

export type RunOutcome =
  | { readonly kind: 'in-review'; readonly pr: string; readonly scope: Scope }
  | { readonly kind: 'blocked'; readonly reason: string };

/** `factory/<n>-<a-few-words-of-the-title>`. */
/** Rejects when `work` takes longer than `minutes` (F13): a hung step stops the run, not the Mac. */
export function withTimeout<T>(work: Promise<T>, minutes: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${what} took longer than ${minutes} min`)),
      minutes * 60_000,
    );
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/** How many usage-limit waits one agent round gets before the run stops. */
export const MAX_LIMIT_WAITS = 3;

/**
 * Runs the agent, and when it stops on a usage limit, waits for the reset and runs the same
 * prompt again in the same worktree (R13). A limit never counts as a round.
 */
export async function runAgentPatiently(
  deps: Pick<RunDeps, 'runAgent' | 'now' | 'sleep' | 'log'>,
  sandbox: RunSandbox,
  prompt: string,
): Promise<void> {
  for (let waits = 0; ; waits++) {
    const ran = await deps.runAgent(sandbox, prompt);
    const reset = ran ? usageLimitReset(ran.output, deps.now()) : null;
    if (!reset) return;
    if (waits >= MAX_LIMIT_WAITS)
      throw new Error(`the agent hit its usage limit ${waits + 1} times in a row`);
    deps.log('usage-limited', { until: reset.toISOString() });
    await deps.sleep(Math.ceil((reset.getTime() - deps.now().getTime()) / 1000) + 60);
  }
}

export function branchName(config: FactoryConfig, item: BoardItem): string {
  const slug = item.title
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-|-$/g, '')
    .split('-')
    .slice(0, 6)
    .join('-');
  return `${config.branchPrefix}${item.number}-${slug || 'issue'}`;
}

/** What the gate runs for a scope (Platform scope in the plan). */
export function gateCommand(scope: Scope): string {
  return scope.kind === 'docs-only' ? 'task lint' : 'task check';
}

type GateVerdict =
  | {
      readonly ok: true;
      readonly proof: readonly AttachedProof[];
      readonly fidelity?: readonly FidelityRow[];
    }
  | { readonly ok: false; readonly feedback: string };

export async function runImplement(deps: RunDeps, input: RunInput): Promise<RunOutcome> {
  const { config, item, spec } = { config: deps.config, ...input };
  const marker = (event: string) =>
    formatMarker({
      run: deps.runId,
      agent: spec.agent,
      model: spec.modelAlias,
      phase: 'implement',
      event,
    });
  const block = async (reason: string, body: string): Promise<RunOutcome> => {
    deps.log('blocked', { reason });
    await deps.comment(item.number, `${body}\n\n${marker('blocked')}`);
    await deps.setBlocked(item);
    return { kind: 'blocked', reason };
  };

  // Claim: the comment first, so a crash after it is recoverable from GitHub (the source of truth).
  await deps.comment(
    item.number,
    `Started: ${spec.agent} (${spec.modelAlias}) on slot ${deps.slot.id}, implementing straight away${spec.planSkip ? ' (`plan:skip`)' : ''}. Scope: ${spec.platforms?.join(', ') ?? 'decided by the path classifier'}.\n\n${marker('claim')}`,
  );
  await deps.setStatus(item, config.status.working);
  deps.log('claimed', { issue: item.number });

  const branch = branchName(config, item);
  let prompt = input.prompt;
  for (let round = 0; ; round++) {
    const work = await deps.openSandbox(branch);
    let result: AgentResult;
    try {
      deps.log('agent-started', { branch, round });
      await runAgentPatiently(deps, work, prompt);
      const read = await deps.readResult(work);
      deps.log('agent-finished', read.ok ? { status: read.result.status } : { error: read.error });
      if (!read.ok)
        return await block(
          read.error,
          `The agent finished without a usable result: ${read.error}.`,
        );
      result = read.result;
    } finally {
      await work.close();
    }

    if (result.status === 'needs-info') {
      deps.log('needs-info', { questions: result.questions.length });
      const questions = result.questions.map((q, i) => `${i + 1}. ${q}`).join('\n');
      return block(
        'needs-info',
        `The agent needs your answers before it can go on:\n\n${questions}\n\nAnswer here, then clear **${config.blockedField}**.`,
      );
    }
    if (result.status === 'failed') {
      deps.log('failed', { summary: result.summary });
      return block('failed', `The agent couldn't finish: ${result.summary}`);
    }

    const { paths, commits } = await deps.diff(branch);
    if (commits === 0) return block('no-commits', 'The agent reported done but committed nothing.');
    const scope = classify(paths);
    const verdict = await gateAndProve(
      deps,
      branch,
      scope,
      spec,
      result,
      input.plan ? { plan: input.plan, final: round >= config.rounds.gateFix } : undefined,
    );
    if (verdict.ok) {
      return publish(deps, {
        item,
        branch,
        scope,
        result,
        proof: verdict.proof,
        ...(verdict.fidelity ? { fidelity: verdict.fidelity } : {}),
        marker,
        prompt: input.prompt,
        ...(input.artifacts ? { artifacts: input.artifacts } : {}),
      });
    }
    deps.log('gate-failed', { round });
    if (round >= config.rounds.gateFix) {
      return block(
        'gate-failed',
        `The gate stopped this run after ${round + 1} round(s): ${verdict.feedback}`,
      );
    }
    // Another round: the agent sees exactly what the gate saw.
    prompt = `${input.prompt}\n\n## The gate's feedback (round ${round + 1})\n\nYour last attempt was committed on \`${branch}\`, but the gate refused it: ${verdict.feedback}\n\nFix that, commit, and write \`.factory/result.json\` again.`;
  }
}

/** The gate, in a fresh sandbox on the branch (FD25), then the proof the harness records itself. */
export async function gateAndProve(
  deps: RunDeps,
  branch: string,
  scope: Scope,
  spec: IssueSpec,
  result: AgentResult,
  validation?: { readonly plan: string; readonly final: boolean },
): Promise<GateVerdict> {
  const needed = proofPlatforms(scope, spec.platforms);
  // R9: an in-scope platform needs a named proof spec before anything runs.
  const unnamed = needed.filter((p) => !result.platforms[p]?.proofSpecs.length);
  if (unnamed.length > 0) {
    return {
      ok: false,
      feedback: `\`result.json\` names no proof spec for ${unnamed.join(', ')}, which the change affects. Add a committed test that shows the change and list it under \`platforms.<name>.proofSpecs\`.`,
    };
  }
  await deps.fetchMain();
  const gate = await deps.openSandbox(branch);
  try {
    const clean = await gate.exec('git status --porcelain --untracked-files=no');
    if (clean.stdout.trim() !== '')
      return { ok: false, feedback: 'the branch has uncommitted changes to tracked files.' };
    // Up to date with main before anything is checked (F6); a conflict is the agent's to resolve.
    const rebase = await gate.exec('git rebase origin/main');
    if (rebase.exitCode !== 0) {
      await gate.exec('git rebase --abort');
      return {
        ok: false,
        feedback: `\`git rebase origin/main\` stopped on conflicts:\n\n\`\`\`\n${tail(rebase.stdout + rebase.stderr)}\n\`\`\`\n\nRebase \`${branch}\` onto \`origin/main\` yourself, resolve them, and commit.`,
      };
    }
    const numbered = await deps.numberDecisions(gate);
    if (Object.keys(numbered).length > 0) deps.log('decisions-numbered', numbered);
    const weak = scanWeakenedTests((await gate.exec('git diff origin/main...HEAD')).stdout);
    if (weak.length > 0) return { ok: false, feedback: weakenedFeedback(weak) };
    const command = gateCommand(scope);
    const checked = await deps.heavy(`factory gate ${branch}`, () => gate.exec(command));
    if (checked.exitCode !== 0) {
      return {
        ok: false,
        feedback: `\`${command}\` failed:\n\n\`\`\`\n${tail(checked.stdout + checked.stderr)}\n\`\`\``,
      };
    }
    deps.log('gate-passed', { command });
    const items: ProofItem[] = [];
    for (const platform of needed) {
      items.push(
        ...(await deps.heavy(`factory proof ${platform} ${branch}`, () =>
          withTimeout(
            deps.recordProof(gate, platform, result.platforms[platform]?.proofSpecs ?? []),
            deps.config.timeouts.proofMinutes,
            `recording ${platform} proof`,
          ),
        )),
      );
    }
    const missing = missingProof(items, needed);
    if (missing.length > 0) {
      return {
        ok: false,
        feedback: `the proof specs for ${missing.join(', ')} didn't pass when the harness ran them with recording on.`,
      };
    }
    const prepared = await deps.prepareProof(items);
    if (!prepared.ok) return { ok: false, feedback: prepared.error };
    deps.log('proof-recorded', { files: prepared.proof.length });
    // F19: a planned change that users see on the web is walked and reviewed against the plan.
    if (validation && scope.platforms.includes('web')) {
      const v = await validate(deps, gate, branch, validation.plan, result.risks);
      if (!v.ok) return { ok: false, feedback: `Validation couldn't finish: ${v.error}` };
      const mismatches = v.rows.filter((r) => r.verdict === 'mismatch');
      if (mismatches.length > 0 && !validation.final)
        return { ok: false, feedback: fidelityFeedback(mismatches) };
      return { ok: true, proof: prepared.proof, fidelity: settle(v.rows) };
    }
    return { ok: true, proof: prepared.proof };
  } finally {
    await gate.close();
  }
}

async function publish(
  deps: RunDeps,
  run: {
    item: BoardItem;
    branch: string;
    scope: Scope;
    result: AgentResult;
    proof: readonly AttachedProof[];
    marker: (event: string) => string;
    prompt: string;
    artifacts?: RunInput['artifacts'];
    fidelity?: readonly FidelityRow[];
  },
): Promise<RunOutcome> {
  const { config } = deps;
  await deps.push(run.branch);
  deps.log('pushed', { branch: run.branch });
  const body = renderPrBody({
    issue: run.item.number,
    key: run.item.key,
    summary: run.result.summary,
    scope: run.scope,
    gate: gateCommand(run.scope),
    proof: run.proof,
    decisions: run.result.decisions,
    risks: run.result.risks,
    marker: run.marker('pr'),
    ...(run.artifacts ? { artifacts: run.artifacts } : {}),
    ...(run.fidelity ? { fidelity: renderFidelity(run.fidelity) } : {}),
  });
  const pr = await deps.openPr({
    branch: run.branch,
    title: run.result.summary,
    body,
    proof: run.proof,
    files: (run.fidelity ?? []).flatMap((r) =>
      [r.mockup, r.screenshot].filter((f): f is string => Boolean(f)),
    ),
  });
  deps.log('pr-opened', { pr });

  // In review only once CI is green (R4); red checks go to a repair session (F6).
  const ci = await watchCi(deps, { ...run, pr });
  if (ci.kind === 'blocked') {
    deps.log('blocked', { reason: ci.reason });
    await deps.comment(run.item.number, `${ci.body}\n\n${run.marker('blocked')}`);
    await deps.setBlocked(run.item);
    return { kind: 'blocked', reason: ci.reason };
  }
  await deps.comment(
    run.item.number,
    `Ready for review, with CI green: ${pr}\n\n${run.marker('in-review')}`,
  );
  await deps.setStatus(run.item, config.status.review);
  await deps.notify(`Penmoss ${run.item.key} is ready for review`, run.result.summary);
  deps.log('in-review', { pr });
  return { kind: 'in-review', pr, scope: run.scope };
}

type CiOutcome =
  | { readonly kind: 'green' }
  | { readonly kind: 'blocked'; readonly reason: string; readonly body: string };

export async function watchCi(
  deps: RunDeps,
  run: { item: BoardItem; branch: string; scope: Scope; pr: string; prompt: string },
): Promise<CiOutcome> {
  const { config } = deps;
  let since = deps.now();
  let repairs = 0;
  let saidStalled = false;
  for (;;) {
    await deps.sleep(config.pollSeconds);
    const summary = summarizeChecks(
      await deps.checks(run.pr),
      deps.now(),
      config.timeouts.ciMinutes,
      since,
    );
    if (summary.kind === 'green') return { kind: 'green' };
    if (summary.kind === 'pending') continue;
    if (summary.kind === 'stalled') {
      // No runner has taken the jobs: a pause, not a failure. Say so once and keep waiting.
      if (!saidStalled) {
        deps.log('ci-stalled', { queued: summary.queued.map((c) => c.name) });
        await deps.comment(
          run.item.number,
          `CI is waiting for a free Mac runner (${summary.queued.map((c) => c.name).join(', ')}). The run carries on when one picks it up.`,
        );
        saidStalled = true;
      }
      continue;
    }
    const logs = await Promise.all(
      summary.failed.map(
        async (c) => `### ${c.name}\n\n\`\`\`\n${await deps.failedLog(c)}\n\`\`\``,
      ),
    );
    deps.log('ci-red', { failed: summary.failed.map((c) => c.name), repairs });
    if (repairs >= config.rounds.ciRepair) {
      return {
        kind: 'blocked',
        reason: 'ci-red',
        body: `CI is still red after ${repairs} repair round(s): ${run.pr}\n\n${summary.failed.map((c) => `- [${c.name}](${c.link})${runIdOf(c) ? ` (run ${runIdOf(c)})` : ''}`).join('\n')}\n\n${logs.join('\n\n')}`,
      };
    }
    repairs++;
    const repaired = await repair(deps, run, logs.join('\n\n'), repairs);
    if (!repaired.ok)
      return {
        kind: 'blocked',
        reason: 'ci-red',
        body: `A CI repair round couldn't finish: ${repaired.why}`,
      };
    deps.log('ci-repaired', { round: repairs });
    since = deps.now();
    saidStalled = false;
  }
}

/** One repair session: the failed logs to the agent, then the gate again, then a push. */
async function repair(
  deps: RunDeps,
  run: { branch: string; scope: Scope; prompt: string },
  logs: string,
  round: number,
): Promise<{ ok: true } | { ok: false; why: string }> {
  const work = await deps.openSandbox(run.branch);
  try {
    await runAgentPatiently(
      deps,
      work,
      `${run.prompt}\n\n## CI failed (repair round ${round})\n\nThe PR from \`${run.branch}\` is open and its CI failed. The failed jobs' last log lines:\n\n${logs}\n\nFix the cause (never by weakening or skipping tests), commit, and write \`.factory/result.json\` again.`,
    );
    const read = await deps.readResult(work);
    if (!read.ok) return { ok: false, why: read.error };
    if (read.result.status !== 'done') return { ok: false, why: read.result.summary };
  } finally {
    await work.close();
  }
  await deps.fetchMain();
  const gate = await deps.openSandbox(run.branch);
  try {
    const rebase = await gate.exec('git rebase origin/main');
    if (rebase.exitCode !== 0) {
      await gate.exec('git rebase --abort');
      return { ok: false, why: 'the repaired branch no longer rebases cleanly onto main' };
    }
    await deps.numberDecisions(gate);
    const weak = scanWeakenedTests((await gate.exec('git diff origin/main...HEAD')).stdout);
    if (weak.length > 0) return { ok: false, why: weakenedFeedback(weak) };
    const command = gateCommand(run.scope);
    const checked = await deps.heavy(`factory gate ${run.branch}`, () => gate.exec(command));
    if (checked.exitCode !== 0)
      return {
        ok: false,
        why: `\`${command}\` failed after the repair:\n\n\`\`\`\n${tail(checked.stdout + checked.stderr)}\n\`\`\``,
      };
  } finally {
    await gate.close();
  }
  await deps.push(run.branch);
  return { ok: true };
}

function tail(text: string): string {
  return text.trim().split('\n').slice(-30).join('\n');
}
