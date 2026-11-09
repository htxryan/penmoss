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
import { VmUnavailable, type VmCheck } from './proof/mac.ts';
import { formatMarker } from './pick.ts';
import type { RebaseOutcome } from './rebase.ts';
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
  | 'rebased'
  | 'rebase-conflict'
  | 'proof-recorded'
  | 'pr-opened'
  | 'ci-red'
  | 'ci-repaired'
  | 'ci-stalled'
  | 'in-review'
  | 'blocked'
  | 'proof-waiting'
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
  /** A sandbox on `branch`; a new branch starts on main as the host last fetched it. */
  openSandbox(branch: string): Promise<RunSandbox>;
  /** Runs the agent in the sandbox with the prompt; resolves when it exits, with its output's tail. */
  runAgent(sandbox: RunSandbox, prompt: string): Promise<{ readonly output: string } | void>;
  /** Keeps a file in the run's folder (`runs/<run>/<name>`), such as the gate's whole output. */
  keep?(name: string, text: string): void;
  /** The last proof run's output for a platform (`runs/<run>/proof-<platform>.log`), if kept. */
  proofLog?(platform: Platform): string | undefined;
  /** `.factory/result.json` from the worktree, parsed (or why it couldn't be). */
  readResult(
    sandbox: RunSandbox,
  ): Promise<{ ok: true; result: AgentResult } | { ok: false; error: string }>;
  /**
   * Paths changed on the branch against origin/main, how many commits it has, and the subject of
   * its first one (the PR's title).
   */
  diff(branch: string): Promise<{
    readonly paths: readonly string[];
    readonly commits: number;
    readonly subject?: string;
  }>;
  /**
   * Runs a platform's proof specs in the sandbox with recording on. `signal` aborts at the proof
   * timeout: what the proof started is stopped (the VM script, the slot's emulator). A Mac proof
   * throws `VmUnavailable` when the test VM couldn't take it.
   */
  recordProof(
    sandbox: RunSandbox,
    platform: Platform,
    specs: readonly string[],
    signal?: AbortSignal,
  ): Promise<ProofItem[]>;
  /** Whether the test VM can take a Mac proof now (F10): the host check before one. */
  macVmCheck(sandbox: RunSandbox): Promise<VmCheck>;
  /** What the run is waiting for, which `factory:status` shows; null once it goes on. */
  waitingFor(reason: string | null): void;
  /** Converts and checks the recordings, into the folder the PR body is written in. */
  prepareProof(
    items: readonly ProofItem[],
  ): Promise<{ ok: true; proof: AttachedProof[] } | { ok: false; error: string }>;
  /** Fetches origin/main into the factory's clone. */
  fetchMain(): Promise<void>;
  /** Whether origin/main (as last fetched) has commits the branch doesn't. */
  behindMain(branch: string): Promise<boolean>;
  /** Rebases the sandbox's branch onto origin/main, resolving decisions-only conflicts (rebase.ts). */
  rebase(sandbox: RunSandbox): Promise<RebaseOutcome>;
  /**
   * Gives the A-NEW-n decisions `branch` added since the run's base real numbers in the
   * sandbox's worktree (one more commit); returns what it assigned.
   */
  numberDecisions(sandbox: RunSandbox, branch: string): Promise<Record<string, string>>;
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
  /**
   * A step boundary: the run is about to start `name` (the gate, a fix round). It does nothing
   * itself; guarded (start.ts), it stops the run there when Ryan has set Blocked (R23).
   */
  step(name: string): Promise<void>;
}

export interface RunInput {
  readonly item: BoardItem;
  readonly spec: IssueSpec;
  readonly prompt: string;
  /** The agreed plan and design artifacts, for the PR body (F16). */
  readonly artifacts?: readonly { readonly label: string; readonly href: string }[];
  /** The agreed plan as text: when set, web changes are validated against it (F19). */
  readonly plan?: string;
  /** A run the daemon restarts because it stopped mid-run (R12): the claim says so. */
  readonly recovered?: boolean;
  /**
   * A recovered run whose last agent round had finished its work (R12): that round's run and its
   * result. The run goes on from the gate with it, when the branch has the round's commits, rather
   * than running the agent again.
   */
  readonly resume?: { readonly run: string; readonly result: AgentResult };
}

export type RunOutcome =
  | { readonly kind: 'in-review'; readonly pr: string; readonly scope: Scope }
  | { readonly kind: 'blocked'; readonly reason: string };

/** How long a timed-out step gets to stop what it started before the run goes on without it. */
export const SETTLE_MS = 120_000;

/**
 * Rejects when `work` takes longer than `minutes` (F13): a hung step stops the run, not the Mac.
 * Given as a function, `work` gets a signal that aborts at the timeout, so it can stop what it
 * started (`nodeExec` kills the command's process group); the rejection then waits for it to
 * finish stopping, up to `settleMs`, so the VM's lock or a slot's emulator is free before the
 * run moves on.
 */
export function withTimeout<T>(
  work: Promise<T> | ((signal: AbortSignal) => Promise<T>),
  minutes: number,
  what: string,
  settleMs = SETTLE_MS,
): Promise<T> {
  const controller = new AbortController();
  const running = typeof work === 'function' ? work(controller.signal) : work;
  // Once the step has timed out, whatever it returns while it stops doesn't count.
  const never = new Promise<never>(() => undefined);
  let late = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      late = true;
      const error = new Error(`${what} took longer than ${minutes} min`);
      if (typeof work !== 'function') return reject(error);
      controller.abort(error);
      const settle = setTimeout(() => reject(error), settleMs);
      void running
        .catch(() => undefined)
        .finally(() => {
          clearTimeout(settle);
          reject(error);
        });
    }, minutes * 60_000);
  });
  const onTime = running.then(
    (value) => (late ? never : value),
    (error: unknown) => {
      if (late) return never;
      throw error;
    },
  );
  return Promise.race([onTime, timedOut]).finally(() => clearTimeout(timer));
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

/** GitHub shows about this much of a title in its lists; git's own advice for a subject. */
export const TITLE_MAX = 72;

/**
 * The PR's title: the branch's first commit subject (the agent writes it as a change's title),
 * else the first sentence of the agent's summary, cut to `TITLE_MAX` at a word. It never names
 * the card: Linear's GitHub integration moves a card named in a PR's title (it closed PEN-75 when
 * #62 merged), and the factory owns the card's status (A1221). The body's "Part of" links it.
 */
export function prTitle(input: {
  readonly subject?: string | undefined;
  readonly summary: string;
  readonly key: string;
}): string {
  const team = /^([A-Za-z][A-Za-z0-9]*)-\d+$/.exec(input.key)?.[1];
  const clean = (text: string) => {
    let t = text.split('\n')[0] ?? '';
    if (team) t = t.replaceAll(new RegExp(`[([]?\\b${team}-\\d+\\b[)\\]]?:?`, 'gi'), ' ');
    return t
      .replaceAll(/\(\s*\)|\[\s*\]/g, ' ')
      .replaceAll(/\s+/g, ' ')
      .replaceAll(/^[\s:;,–-]+|[\s:;,–-]+$/g, '');
  };
  const subject =
    input.subject && !input.subject.startsWith('Number the new decisions')
      ? clean(input.subject)
      : '';
  const sentence = clean(input.summary.split(/(?<=[.!?])\s/)[0] ?? '').replace(/\.$/, '');
  const title = subject || sentence || 'The factory’s change';
  if (title.length <= TITLE_MAX) return title;
  const words = title.slice(0, TITLE_MAX).split(' ');
  if (words.length > 1) words.pop();
  return `${words.join(' ').replace(/[\s:;,–-]+$/, '')}…`;
}

/** What the gate runs for a scope (Platform scope in the plan). */
/**
 * The rebased branch's dependencies, before its check (A1251). The rebase can bring main's
 * changed lockfile into a worktree the agent installed earlier; `task lint` then starts with a
 * filtered `pnpm exec`, whose own install pruned every other package's modules, and ESLint
 * failed on 100,000 unresolved types (PEN-70's gate, twice).
 */
export const GATE_INSTALL = 'pnpm install --frozen-lockfile --prefer-offline';

function installFeedback(installed: { readonly stdout: string; readonly stderr: string }): string {
  return `\`${GATE_INSTALL}\` failed after the rebase onto \`origin/main\`:\n\n\`\`\`\n${excerpt(installed.stdout + installed.stderr)}\n\`\`\``;
}

/**
 * In a sandbox, main is `origin/main` (the host's fetch); the clone's local `main` is stale, and an
 * agent that diffed against it saw every factory change since the run began (PEN-70's run).
 */
export const STALE_MAIN =
  'Main is `origin/main` here; the local `main` branch is stale, so diff and rebase against `origin/main` (`git diff origin/main...HEAD`).';

export function gateCommand(scope: Scope): string {
  return scope.kind === 'docs-only' ? 'task lint' : 'task check';
}

type GateVerdict =
  | {
      readonly ok: true;
      readonly proof: readonly AttachedProof[];
      readonly fidelity?: readonly FidelityRow[];
    }
  /** `block`: nothing the agent can fix (the test VM stayed unusable): stop, Blocked, now. */
  | { readonly ok: false; readonly feedback: string; readonly block?: string };

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

  const branch = branchName(config, item);
  // A recovered run whose agent had finished goes on from the gate, if its commits are there.
  const resumed =
    input.recovered && input.resume?.result.status === 'done'
      ? await deps.diff(branch).then(
          (d) => (d.commits > 0 ? input.resume : undefined),
          () => undefined,
        )
      : undefined;

  // Claim: the comment first, so a crash after it is recoverable from GitHub (the source of truth).
  const how = resumed
    ? `Restarted: this run stopped after its agent had finished (its work is committed on the branch), so it goes on from the gate rather than running the agent again (R12). ${spec.agent} (${spec.modelAlias}) on slot ${deps.slot.id}.`
    : input.recovered
      ? `Restarted: this run stopped before it finished (the factory's daemon stopped, or Blocked paused it and has been cleared), so it runs again on the same branch (R12). ${spec.agent} (${spec.modelAlias}) on slot ${deps.slot.id}.`
      : `Started: ${spec.agent} (${spec.modelAlias}) on slot ${deps.slot.id}, implementing straight away${spec.planSkip ? ' (`plan:skip`)' : ''}.`;
  await deps.comment(
    item.number,
    `${how} Scope: ${spec.platforms?.join(', ') ?? 'decided by the path classifier'}.\n\n${marker('claim')}`,
  );
  await deps.setStatus(item, config.status.working);
  deps.log('claimed', { issue: item.number });

  let prompt = input.prompt;
  for (let round = 0; ; round++) {
    let result: AgentResult;
    if (round === 0 && resumed) {
      // The same event a finished round writes, naming where its result is, for a later restart.
      deps.log('agent-finished', { status: 'done', from: resumed.run });
      result = resumed.result;
    } else {
      const ran = await agentRound(deps, branch, prompt, round);
      if (!ran.ok)
        return block(ran.error, `The agent finished without a usable result: ${ran.error}.`);
      result = ran.result;
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

    const { paths, commits, subject } = await deps.diff(branch);
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
        ...(subject ? { subject } : {}),
        proof: verdict.proof,
        ...(verdict.fidelity ? { fidelity: verdict.fidelity } : {}),
        marker,
        prompt: input.prompt,
        ...(input.artifacts ? { artifacts: input.artifacts } : {}),
      });
    }
    if (verdict.block) return block(verdict.block, verdict.feedback);
    deps.log('gate-failed', { round });
    if (round >= config.rounds.gateFix) {
      return block(
        'gate-failed',
        `The gate stopped this run after ${round + 1} round(s): ${verdict.feedback}`,
      );
    }
    // Another round: the agent sees exactly what the gate saw.
    await deps.step(`gate-fix round ${round + 1}`);
    prompt = `${input.prompt}\n\n## The gate's feedback (round ${round + 1})\n\nYour last attempt was committed on \`${branch}\`, but the gate refused it: ${verdict.feedback}\n\nFix that, commit, and write \`.factory/result.json\` again. ${STALE_MAIN}`;
  }
}

/** One agent round in a sandbox on the branch, and the result it wrote. */
async function agentRound(
  deps: RunDeps,
  branch: string,
  prompt: string,
  round: number,
): Promise<{ ok: true; result: AgentResult } | { ok: false; error: string }> {
  const work = await deps.openSandbox(branch);
  try {
    deps.log('agent-started', { branch, round });
    await runAgentPatiently(deps, work, prompt);
    const read = await deps.readResult(work);
    deps.log('agent-finished', read.ok ? { status: read.result.status } : { error: read.error });
    return read;
  } finally {
    await work.close();
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
  await deps.step('the gate');
  await deps.fetchMain();
  const gate = await deps.openSandbox(branch);
  try {
    const clean = await gate.exec('git status --porcelain --untracked-files=no');
    if (clean.stdout.trim() !== '')
      return { ok: false, feedback: 'the branch has uncommitted changes to tracked files.' };
    // Up to date with main before anything is checked (F6). The harness resolves new decision
    // rows on both sides; any other conflict is the agent's to resolve.
    const rebased = await deps.rebase(gate);
    if (rebased.kind === 'conflict')
      return { ok: false, feedback: conflictFeedback(branch, rebased) };
    noteRebase(deps, rebased);
    const numbered = await deps.numberDecisions(gate, branch);
    if (Object.keys(numbered).length > 0) deps.log('decisions-numbered', numbered);
    const installed = await gate.exec(GATE_INSTALL);
    if (installed.exitCode !== 0) return { ok: false, feedback: installFeedback(installed) };
    const weak = scanWeakenedTests((await gate.exec('git diff origin/main...HEAD')).stdout);
    if (weak.length > 0) return { ok: false, feedback: weakenedFeedback(weak) };
    const command = gateCommand(scope);
    const checked = await deps.heavy(`factory gate ${branch}`, () => gate.exec(command));
    if (checked.exitCode !== 0) {
      deps.keep?.('gate.log', checked.stdout + checked.stderr);
      return {
        ok: false,
        feedback: `\`${command}\` failed:\n\n\`\`\`\n${excerpt(checked.stdout + checked.stderr)}\n\`\`\``,
      };
    }
    deps.log('gate-passed', { command });
    const items: ProofItem[] = [];
    for (const platform of needed) {
      const specs = result.platforms[platform]?.proofSpecs ?? [];
      if (platform === 'mac') {
        const mac = await recordMacProof(deps, gate, branch, specs);
        if (!mac.ok) return { ok: false, feedback: mac.feedback, block: 'mac-vm' };
        items.push(...mac.items);
        continue;
      }
      items.push(
        ...(await deps.heavy(`factory proof ${platform} ${branch}`, () =>
          withTimeout(
            (signal) => deps.recordProof(gate, platform, specs, signal),
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
        feedback: `the proof specs for ${missing.join(', ')} didn't pass when the harness ran them with recording on.${proofOutput(deps, missing)}`,
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

/**
 * The Mac proof, once the test VM can take it (F7, F10). While it can't (tart missing, the VM
 * not made, another run on it, a VM started some other way, a boot that fails), the run waits
 * a poll and asks again: no failure, no round used, and `factory:status` says why. The check and
 * the proof hold the heavy-job slot; the waits don't. Only after `macProof.waitHours` does it
 * give up, and the run stops Blocked with the reason.
 */
export async function recordMacProof(
  deps: RunDeps,
  gate: RunSandbox,
  branch: string,
  specs: readonly string[],
): Promise<{ ok: true; items: ProofItem[] } | { ok: false; feedback: string }> {
  const since = deps.now();
  let said: string | undefined;
  try {
    for (;;) {
      const tried = await deps.heavy(`factory proof mac ${branch}`, async () => {
        const check = await deps.macVmCheck(gate);
        if (!check.ok) return { wait: check.reason };
        try {
          return {
            items: await withTimeout(
              (signal) => deps.recordProof(gate, 'mac', specs, signal),
              deps.config.timeouts.proofMinutes,
              'recording mac proof',
            ),
          };
        } catch (error) {
          if (error instanceof VmUnavailable) return { wait: error.message };
          throw error;
        }
      });
      if ('items' in tried) return { ok: true, items: tried.items };
      const hours = (deps.now().getTime() - since.getTime()) / 3_600_000;
      if (hours >= deps.config.macProof.waitHours)
        return {
          ok: false,
          feedback: `The Mac proof waited ${deps.config.macProof.waitHours} h for the test VM (${deps.config.macProof.vm}), which still can't take it: ${tried.wait}. Fix the VM (docs/ci.md §8), then clear **${deps.config.blockedField}**.`,
        };
      if (tried.wait !== said) {
        deps.log('proof-waiting', { platform: 'mac', reason: tried.wait });
        said = tried.wait;
      }
      deps.waitingFor(`the Mac proof waits for the test VM: ${tried.wait}`);
      await deps.sleep(deps.config.pollSeconds);
    }
  } finally {
    deps.waitingFor(null);
  }
}

async function publish(
  deps: RunDeps,
  run: {
    item: BoardItem;
    branch: string;
    scope: Scope;
    result: AgentResult;
    /** The branch's first commit subject, for the title. */
    subject?: string;
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
    title: prTitle({ subject: run.subject, summary: run.result.summary, key: run.item.key }),
    body,
    proof: run.proof,
    files: (run.fidelity ?? []).flatMap((r) =>
      [r.mockup, r.screenshot].filter((f): f is string => Boolean(f)),
    ),
  });
  deps.log('pr-opened', { pr });

  const stop = async (reason: string, text: string): Promise<RunOutcome> => {
    deps.log('blocked', { reason });
    await deps.comment(run.item.number, `${text}\n\n${run.marker('blocked')}`);
    await deps.setBlocked(run.item);
    return { kind: 'blocked', reason };
  };
  // In review only once CI is green (R4); red checks go to a repair session (F6).
  const ci = await watchCi(deps, { ...run, pr });
  if (ci.kind === 'blocked') return stop(ci.reason, ci.body);
  // main may have moved while CI ran: rebase once more, so the PR reaches review on top of it.
  await deps.fetchMain();
  if (await deps.behindMain(run.branch)) {
    const fresh = await refreshBranch(deps, run);
    if (!fresh.ok) return stop(fresh.reason, fresh.body);
    const again = await watchCi(deps, { ...run, pr });
    if (again.kind === 'blocked') return stop(again.reason, again.body);
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
  await deps.step(`CI repair round ${round}`);
  const work = await deps.openSandbox(run.branch);
  try {
    await runAgentPatiently(
      deps,
      work,
      `${run.prompt}\n\n## CI failed (repair round ${round})\n\nThe PR from \`${run.branch}\` is open and its CI failed. The failed jobs' last log lines:\n\n${logs}\n\nFix the cause (never by weakening or skipping tests), commit, and write \`.factory/result.json\` again. ${STALE_MAIN}`,
    );
    const read = await deps.readResult(work);
    if (!read.ok) return { ok: false, why: read.error };
    if (read.result.status !== 'done') return { ok: false, why: read.result.summary };
  } finally {
    await work.close();
  }
  const gated = await regate(deps, run.branch, run.scope);
  if (!gated.ok)
    return {
      ok: false,
      why: gated.conflict
        ? `the repaired branch no longer rebases cleanly onto main (${gated.conflict.map((f) => `\`${f}\``).join(', ')} conflict)`
        : gated.why,
    };
  await deps.push(run.branch);
  return { ok: true };
}

type Rebased = Extract<RebaseOutcome, { kind: 'rebased' }>;

function conflictFeedback(branch: string, conflict: Extract<RebaseOutcome, { kind: 'conflict' }>) {
  const files = conflict.files.map((f) => `\`${f}\``).join(', ');
  return `\`git rebase origin/main\` stopped on conflicts${files ? ` in ${files}` : ''}:\n\n\`\`\`\n${tail(conflict.output)}\n\`\`\`\n\nRebase \`${branch}\` onto \`origin/main\` yourself, resolve them, and commit.`;
}

function noteRebase(deps: RunDeps, rebased: Rebased): void {
  if (rebased.resolved.length > 0 || Object.keys(rebased.renumbered).length > 0)
    deps.log('rebased', { resolved: rebased.resolved, renumbered: rebased.renumbered });
}

type Regated =
  | { readonly ok: true; readonly rebase: Rebased }
  | { readonly ok: false; readonly why: string; readonly conflict?: readonly string[] };

/** The branch rebased onto a fresh main in a gate sandbox, and the gate run on it again. */
async function regate(deps: RunDeps, branch: string, scope: Scope): Promise<Regated> {
  await deps.step('the gate');
  await deps.fetchMain();
  const gate = await deps.openSandbox(branch);
  try {
    const rebased = await deps.rebase(gate);
    if (rebased.kind === 'conflict')
      return { ok: false, why: conflictFeedback(branch, rebased), conflict: rebased.files };
    noteRebase(deps, rebased);
    const numbered = await deps.numberDecisions(gate, branch);
    if (Object.keys(numbered).length > 0) deps.log('decisions-numbered', numbered);
    const installed = await gate.exec(GATE_INSTALL);
    if (installed.exitCode !== 0) return { ok: false, why: installFeedback(installed) };
    const weak = scanWeakenedTests((await gate.exec('git diff origin/main...HEAD')).stdout);
    if (weak.length > 0) return { ok: false, why: weakenedFeedback(weak) };
    const command = gateCommand(scope);
    const checked = await deps.heavy(`factory gate ${branch}`, () => gate.exec(command));
    if (checked.exitCode !== 0) {
      deps.keep?.('gate.log', checked.stdout + checked.stderr);
      return {
        ok: false,
        why: `\`${command}\` failed:\n\n\`\`\`\n${excerpt(checked.stdout + checked.stderr)}\n\`\`\``,
      };
    }
    return { ok: true, rebase: rebased };
  } finally {
    await gate.close();
  }
}

function stuck(
  branch: string,
  failed: Extract<Regated, { ok: false }>,
  why: string,
): Extract<RefreshOutcome, { ok: false }> {
  const files = failed.conflict?.map((f) => `\`${f}\``).join(', ');
  return failed.conflict
    ? {
        ok: false,
        reason: 'rebase-conflict',
        body: `\`${branch}\` no longer rebases onto main${files ? `: ${files} conflict` : ''}, and a fix round with the agent didn't resolve it${why}. Rebase it yourself or say how in a comment, then clear Blocked.\n\n${failed.why}`,
      }
    : {
        ok: false,
        reason: 'gate-failed',
        body: `After rebasing onto main, the gate still fails${why}: ${failed.why}`,
      };
}

export type RefreshOutcome =
  | { readonly ok: true; readonly rebase: Rebased }
  | { readonly ok: false; readonly reason: string; readonly body: string };

/**
 * Brings a pushed branch up to date with main (F6): rebase in a fresh sandbox, the gate again,
 * then the host's leased push. A conflict the harness can't resolve, or a gate the rebase broke,
 * gets one fix round with the agent; after that it is Ryan's, with the files named.
 */
export async function refreshBranch(
  deps: RunDeps,
  run: { readonly branch: string; readonly scope: Scope; readonly prompt: string },
): Promise<RefreshOutcome> {
  let gated = await regate(deps, run.branch, run.scope);
  if (!gated.ok) {
    const first = gated;
    deps.log(first.conflict ? 'rebase-conflict' : 'gate-failed', {
      ...(first.conflict ? { files: first.conflict } : {}),
      phase: 'rebase',
    });
    const ask = first.conflict
      ? `## \`origin/main\` moved: rebase onto it\n\nThe PR from \`${run.branch}\` no longer rebases onto \`origin/main\`. ${first.why}\n\nKeep what \`origin/main\` changed and what this branch changes. ${STALE_MAIN} Run the checks, commit, and write \`.factory/result.json\` again.`
      : `## The gate after rebasing onto \`origin/main\`\n\n\`${run.branch}\` is now on top of \`origin/main\`, and the gate fails there: ${first.why}\n\nFix the cause (never by weakening or skipping tests), commit, and write \`.factory/result.json\` again. ${STALE_MAIN}`;
    const work = await deps.openSandbox(run.branch);
    let read: Awaited<ReturnType<RunDeps['readResult']>>;
    try {
      await runAgentPatiently(deps, work, `${run.prompt}\n\n${ask}`);
      read = await deps.readResult(work);
    } finally {
      await work.close();
    }
    const stopped = !read.ok
      ? read.error
      : read.result.status !== 'done'
        ? read.result.summary
        : undefined;
    if (stopped !== undefined)
      return stuck(run.branch, first, ` (the agent's fix round stopped: ${stopped})`);
    gated = await regate(deps, run.branch, run.scope);
    if (!gated.ok) return stuck(run.branch, gated, '');
  }
  await deps.push(run.branch);
  deps.log('pushed', { branch: run.branch, phase: 'rebase' });
  return { ok: true, rebase: gated.rebase };
}

function tail(text: string): string {
  return text.trim().split('\n').slice(-30).join('\n');
}

const ERROR_LINE = /\berror\b|✖|✘|×|\bFAIL\b|\bfailed\b/i;

/**
 * A failed check's lines that name an error (up to 40), then its last lines. The tail alone
 * stopped before ESLint's errors in PEN-70's gate, so neither the agent nor the log said what
 * failed; the whole output is kept in the run folder too (`gate.log`, A1250).
 */
/** What each missing platform's proof printed, for the agent: the harness's run, not its own. */
function proofOutput(deps: RunDeps, platforms: readonly Platform[]): string {
  return platforms
    .map((p) => [p, deps.proofLog?.(p)] as const)
    .filter((e): e is readonly [Platform, string] => Boolean(e[1]?.trim()))
    .map(([p, log]) => `\n\nThe ${p} proof's output:\n\n\`\`\`\n${excerpt(log)}\n\`\`\``)
    .join('');
}

export function excerpt(text: string): string {
  const last = tail(text);
  const shown = new Set(last.split('\n'));
  const errors = text
    .trim()
    .split('\n')
    .filter((line) => ERROR_LINE.test(line) && !shown.has(line))
    .slice(0, 40);
  return errors.length ? `${errors.join('\n')}\n…\n${last}` : last;
}
