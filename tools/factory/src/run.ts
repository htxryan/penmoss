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
import {
  flakeCandidate,
  infraFailure,
  MAX_FLAKE_RERUNS,
  MAX_INFRA_RERUNS,
  passedOnMain,
  touchedBy,
  type CiHistory,
  type InfraFailure,
} from './ci-failure.ts';
import type { RunJob } from './merge.ts';
import { classify, proofPlatforms, type Scope } from './platforms.ts';
import {
  criterionLabel,
  fidelityFeedback,
  renderFidelity,
  settle,
  type FidelityRow,
} from './fidelity.ts';
import {
  scanWeakenedTests,
  weakenedFeedback,
  workflowChanges,
  workflowFeedback,
  type Finding,
} from './gate.ts';
import { USAGE_LIMIT_WAIT, usageLimitReset } from './limits.ts';
import { validate } from './validate.ts';
import { renderPrBody, type AttachedProof } from './proof/body.ts';
import { failedProof, missingProof, type ProofItem } from './proof/manifest.ts';
import { VmUnavailable, type VmCheck } from './proof/mac.ts';
import { formatMarker } from './pick.ts';
import { DECISIONS, sandboxNumbering, type RebaseOutcome } from './rebase.ts';
import { numberText } from './decisions.ts';
import { settleRisks } from './risks.ts';
import {
  carriedOver,
  diffPrint,
  PROVEN,
  validationKey,
  type Proven,
  type Wanted,
} from './carry.ts';
import type { AgentResult } from './result.ts';
import { formatNote, parseReleaseNote } from '../../../.github/scripts/release-note.mjs';
import type { WalkOutcome, WalkPlatform } from './walk.ts';

export type RunEvent =
  | 'claimed'
  | 'agent-started'
  | 'agent-finished'
  | 'needs-info'
  | 'failed'
  | 'gate-passed'
  | 'gate-failed'
  | 'validation-mismatch'
  | 'pushed'
  | 'decisions-numbered'
  | 'rebased'
  | 'rebase-conflict'
  | 'proof-recorded'
  | 'proof-reused'
  | 'pr-opened'
  | 'ci-red'
  | 'pr-conflicts'
  | 'ci-repaired'
  | 'ci-rerun'
  | 'ci-flake-rerun'
  | 'ci-stalled'
  | 'in-review'
  | 'blocked'
  | 'proof-waiting'
  | 'usage-limited'
  | 'validated'
  | 'validation-reused'
  | 'resumed-at-ci'
  | 'release-note-refused';

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
  /**
   * The open PR from `branch` when it is exactly what the factory last pushed: GitHub's head is
   * the factory's last push, and the run's branch has nothing since. A recovered run then waits
   * on its CI again instead of gating it again (A1298). Undefined otherwise.
   */
  pushedPr?(branch: string): Promise<string | undefined>;
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
  /**
   * Runs validation's walkthrough of the Mac or Android app (PEN-94, walk.ts) and puts its
   * screenshots in `.factory/validation/`. A Mac one throws `VmUnavailable` when the test VM
   * can't take it, as a Mac proof does.
   */
  walk(sandbox: RunSandbox, platform: WalkPlatform, signal?: AbortSignal): Promise<WalkOutcome>;
  /** What the run is waiting for, which `factory:status` shows; null once it goes on. */
  waitingFor(reason: string | null): void;
  /**
   * The card's latest earlier run whose proof (and validation, when one ran) passed with this
   * print of the branch's own diff (carry.ts), when its `proven.json` and every file it names are
   * still in its run folder. The gate then reuses them rather than proving again.
   */
  provenBefore?(diff: string): Proven | undefined;
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
  /**
   * Whether GitHub says the PR conflicts with main (`mergeable` is `CONFLICTING`). Such a PR gets
   * no CI run at all, so the factory refreshes the branch instead of waiting for checks (A1311).
   */
  conflicts?(pr: string): Promise<boolean>;
  /** The last lines of a failed check's log. */
  failedLog(check: CheckRun): Promise<string>;
  /** Re-runs an Actions run's failed jobs (`gh run rerun <id> --failed`): an infrastructure failure. */
  rerunFailed(run: string): Promise<void>;
  /** What the run ledger says the factory already did about a PR's CI (ci-failure.ts). */
  ciHistory?(issue: number, pr: string): CiHistory;
  /**
   * The jobs of main's latest completed push runs of `workflow` (`MAIN_RUNS_READ` of them),
   * newest first: whether a failing job passes on main (A1328). Without it, a failing test is
   * always the branch's.
   */
  mainRunJobs?(workflow: string): Promise<readonly (readonly RunJob[])[]>;
  /** F19's validation: mockups in, the reviewer's verdicts out (see validate.ts). */
  stageMockups(sandbox: RunSandbox): Promise<void>;
  keepValidation(sandbox: RunSandbox): Promise<void>;
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
    /**
     * The earlier run whose proof folder holds `proof` and `files`, when they were carried over:
     * they are linked from where that run uploads them (`runs/<run>/`), not this run's folder.
     */
    proofFrom?: string;
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
  /**
   * Where the issue's images are in the sandbox (attachments.ts), as the prompt says it, or empty.
   * The validation and review sessions get it too: they see the plan, not the issue (A1277).
   */
  readonly images?: string;
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
  deps: Pick<RunDeps, 'runAgent' | 'now' | 'sleep' | 'log'> & Partial<Pick<RunDeps, 'waitingFor'>>,
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
    deps.waitingFor?.(`${USAGE_LIMIT_WAIT} at ${reset.toISOString()}`);
    await deps.sleep(Math.ceil((reset.getTime() - deps.now().getTime()) / 1000) + 60);
    deps.waitingFor?.(null);
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

/** The longest title the agent may give in `result.json` (A1345). */
export const AGENT_TITLE_MAX = 60;

/**
 * Where a long title can end: before a clause that explains or adds to the change (", so …",
 * "; …", ": …" after the area prefix, a dash), and failing that before a comma.
 */
const CLAUSE_BREAKS = [
  /, so (?:that )?/g,
  /, which /g,
  /, because /g,
  /, but /g,
  /, and /g,
  /; /g,
  /: /g,
  / [—–] /g,
  / - /g,
  / so that /g,
  / because /g,
];
const COMMA_BREAK = /, /g;

/** Words a title shouldn't end on once it is cut. */
const DANGLING =
  /(?:\s+(?:a|an|the|and|or|but|so|to|of|in|on|at|by|for|from|with|without|into|onto|as|that|which|when|while|its|their|his|her|this|these|those|is|are|was|were|be|it))+$/i;

/**
 * `title` cut to `TITLE_MAX` without an ellipsis (A1345): at the last clause break that fits
 * after the area prefix (`Mac: `), else a comma, else at a word, with no dangling article,
 * preposition or conjunction at the end. PEN-121's PR was `Mac: agents' MCP servers run from
 * Penmoss CLI.app, so opening Penmoss…`; it is now `Mac: agents' MCP servers run from Penmoss
 * CLI.app`.
 */
export function shortenTitle(title: string): string {
  if (title.length <= TITLE_MAX) return title;
  const prefix = /^[A-Z][\w ./+-]{0,24}: /.exec(title)?.[0].length ?? 0;
  // A cut leaves at least the prefix and a few words.
  const least = prefix + 16;
  const lastBreak = (patterns: readonly RegExp[]) => {
    let at = -1;
    for (const pattern of patterns)
      for (const m of title.matchAll(pattern))
        if (m.index >= least && m.index <= TITLE_MAX && m.index > at) at = m.index;
    return at;
  };
  const tidy = (text: string) => text.replace(/[\s:;,.–—-]+$/, '').replace(DANGLING, '');
  for (const patterns of [CLAUSE_BREAKS, [COMMA_BREAK]]) {
    const at = lastBreak(patterns);
    if (at > 0) return tidy(title.slice(0, at));
  }
  const words = title.slice(0, TITLE_MAX + 1).split(' ');
  if (words.length > 1) words.pop();
  const cut = tidy(words.join(' '));
  return cut.length >= least ? cut : tidy(title.slice(0, TITLE_MAX));
}

/**
 * The PR's title: the agent's own `title` from `result.json` when it is a usable one (at most
 * `AGENT_TITLE_MAX` characters, naming no card), else the branch's first commit subject (the
 * agent writes it as a change's title), else the first sentence of the agent's summary, either
 * cut to `TITLE_MAX` at a clause or a word (`shortenTitle`). It never names the card: Linear's
 * GitHub integration moves a card named in a PR's title (it closed PEN-75 when #62 merged), and
 * the factory owns the card's status (A1221). The body's "Part of" links it.
 */
export function prTitle(input: {
  readonly title?: string | undefined;
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
  const own = input.title?.trim().replace(/\.$/, '') ?? '';
  const usable =
    own !== '' &&
    !own.includes('\n') &&
    own.length <= AGENT_TITLE_MAX &&
    !(team && new RegExp(`\\b${team}-\\d+\\b`, 'i').test(own));
  if (usable) return own;
  const subject =
    input.subject && !input.subject.startsWith('Number the new decisions')
      ? clean(input.subject)
      : '';
  const sentence = clean(input.summary.split(/(?<=[.!?])\s/)[0] ?? '').replace(/\.$/, '');
  return shortenTitle(subject || sentence || 'The factory’s change');
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

const INSTALL_REASON = 'pnpm install failed after the rebase';

const conflictReason = (files: readonly string[]) =>
  `rebase conflict${files.length ? `: ${files.join(', ')}` : ''}`;

const weakenedReason = (findings: readonly Finding[]) =>
  `weakened tests: ${[...new Set(findings.map((f) => f.file))].join(', ')}`;

/**
 * The failed proof tests (`platform: title`, `failedProof`) in one line, by platform:
 * `mac: 1 failed (packaged-cli.spec.ts › reopens)`.
 */
export function proofReason(failing: readonly string[]): string {
  const by = new Map<string, string[]>();
  for (const f of failing) {
    const at = f.indexOf(': ');
    const platform = at < 0 ? 'proof' : f.slice(0, at);
    by.set(platform, [...(by.get(platform) ?? []), at < 0 ? f : f.slice(at + 2)]);
  }
  return [...by]
    .map(
      ([platform, titles]) =>
        `${platform} proof: ${titles.length} failed (${titles[0]}${titles.length > 1 ? ', …' : ''})`,
    )
    .join('; ');
}

/** A gate refusal's reason as one short line: whitespace collapsed, cut at `max` characters. */
export function oneLine(text: string, max = 200): string {
  const line = text.replaceAll(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * In a sandbox, main is `origin/main` (the host's fetch); the clone's local `main` is stale, and an
 * agent that diffed against it saw every factory change since the run began (PEN-70's run).
 */
export const STALE_MAIN =
  'Main is `origin/main` here; the local `main` branch is stale, so diff and rebase against `origin/main` (`git diff origin/main...HEAD`).';

/**
 * What a CI repair round can't change (A1314). Given only an apt log, PEN-73's repair round
 * added a retry loop to `ci.yml`, a change unrelated to its PR that GitHub then refused to take
 * from the factory's app.
 */
export const CI_REPAIR_LIMITS =
  "The factory can't push changes under `.github/workflows/` (its GitHub App has no workflows permission, and the gate refuses them), so never edit those files. A failure in the runner's network or in a hosted service (a name that doesn't resolve, a registry's 5xx, a runner that shut down, an apt mirror that can't be reached) isn't this branch's to fix: change nothing, and write `.factory/result.json` with status `failed` and the log lines that show it in `summary`.";

export function gateCommand(scope: Scope): string {
  return scope.kind === 'docs-only' ? 'task lint' : 'task check';
}

type GateVerdict =
  | {
      readonly ok: true;
      readonly proof: readonly AttachedProof[];
      readonly fidelity?: readonly FidelityRow[];
      /** The number each A-NEW-k on the branch has now (`branchNumbering`). */
      readonly numbering: Readonly<Record<string, string>>;
      /** The platforms whose proof the harness ran and saw pass. */
      readonly proved: readonly Platform[];
      /** The earlier run the proof (and validation) came from, when the gate reused them. */
      readonly carried?: Carried;
    }
  /**
   * `block`: nothing the agent can fix (the test VM stayed unusable): stop, Blocked, now.
   * `mismatches`: the gate and proof passed, and validation found these criteria not met.
   */
  | {
      readonly ok: false;
      readonly feedback: string;
      /** The refusal in one short line, for the ledger and daemon.log (`gate-failed`). */
      readonly reason: string;
      readonly block?: string;
      readonly mismatches?: readonly string[];
    };

/** Proof carried over from an earlier run: which, and whether its validation came with it. */
export interface Carried {
  readonly run: string;
  readonly validated: boolean;
}

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

  // Blocked after its PR was pushed (CI red, then a job re-run by hand): nothing changed since,
  // so the gate, proof and validation would only repeat themselves. Back to waiting on CI.
  const pr =
    resumed && deps.pushedPr ? await deps.pushedPr(branch).catch(() => undefined) : undefined;
  if (resumed && pr) {
    await deps.comment(
      item.number,
      `Restarted: ${pr} is as the factory last pushed it, so the run goes back to waiting on its CI, without running the gate, proof and validation again (A1298). ${spec.agent} (${spec.modelAlias}) on slot ${deps.slot.id}.\n\n${marker('claim')}`,
    );
    await deps.setStatus(item, config.status.working);
    deps.log('claimed', { issue: item.number });
    // As a resumed round logs it, so a later restart still finds the result.
    deps.log('agent-finished', { status: 'done', from: resumed.run });
    deps.log('resumed-at-ci', { pr });
    const { paths } = await deps.diff(branch);
    return awaitReview(
      deps,
      {
        item,
        branch,
        scope: classify(paths),
        result: resumed.result,
        marker,
        prompt: input.prompt,
      },
      pr,
    );
  }

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

    // Every PR carries a Release note (PEN-105, A1294). A missing or bad one goes back to the
    // agent once, with the check's own words, and blocks the run if it is still wrong.
    let note = releaseNoteOf(result);
    if (!note.ok) {
      deps.log('release-note-refused', { round, errors: note.errors.length });
      await deps.step('release-note round');
      const again = await agentRound(
        deps,
        branch,
        releaseNotePrompt(input.prompt, note.errors),
        round,
      );
      if (!again.ok)
        return block(again.error, `The agent finished without a usable result: ${again.error}.`);
      if (again.result.status !== 'done')
        return block(
          'release-note',
          `Asked only for its Release note, the agent stopped instead: ${again.result.summary}`,
        );
      result = again.result;
      note = releaseNoteOf(result);
      if (!note.ok)
        return block(
          'release-note',
          `The agent's Release note still doesn't pass the check, after one more try:\n\n${note.errors.map((e) => `- ${e}`).join('\n')}\n\nWrite it in \`.factory/result.json\` (\`releaseNote\`), or tell the agent what it is, then clear **${config.blockedField}**.`,
        );
    }

    const { paths, commits, subject } = await deps.diff(branch);
    if (commits === 0) return block('no-commits', 'The agent reported done but committed nothing.');
    // Commits that cancel out (PEN-80: a skip, then the gate's round took it back out) leave
    // nothing to review; a PR would be empty, titled after the undone commit (A1268).
    if (paths.length === 0)
      return block(
        'no-changes',
        `The agent reported done, but the branch's ${commits} commit(s) change nothing against main, so there is no PR to open: ${result.summary}`,
      );
    const scope = classify(paths);
    const verdict = await gateAndProve(
      deps,
      branch,
      scope,
      spec,
      result,
      input.plan
        ? { plan: input.plan, final: round >= config.rounds.gateFix, images: input.images ?? '' }
        : undefined,
      { carry: true },
    );
    if (verdict.ok) {
      return publish(deps, {
        item,
        branch,
        scope,
        result,
        releaseNote: note.text,
        ...(subject ? { subject } : {}),
        proof: verdict.proof,
        ...(verdict.fidelity ? { fidelity: verdict.fidelity } : {}),
        numbering: verdict.numbering,
        proved: verdict.proved,
        ...(verdict.carried ? { carried: verdict.carried } : {}),
        marker,
        prompt: input.prompt,
        ...(input.artifacts ? { artifacts: input.artifacts } : {}),
      });
    }
    if (verdict.block) return block(verdict.block, verdict.feedback);
    // A validation mismatch isn't a failed check: the ledger and the Factory UI say which it was.
    if (verdict.mismatches)
      deps.log('validation-mismatch', { round, criteria: verdict.mismatches });
    else deps.log('gate-failed', { round, reason: oneLine(verdict.reason) });
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

/**
 * The agent's Release note, checked as the PR's own Release note check will check it, and as
 * the PR shows it: the notes one per line, or `none`.
 */
export function releaseNoteOf(
  result: AgentResult,
):
  { readonly ok: true; readonly text: string } | { readonly ok: false; readonly errors: string[] } {
  if (!result.releaseNote)
    return {
      ok: false,
      errors: ['`.factory/result.json` has no `releaseNote`.'],
    };
  const parsed = parseReleaseNote(`## Release note\n\n${result.releaseNote}`);
  if (!parsed.ok) return { ok: false, errors: parsed.errors };
  return { ok: true, text: parsed.none ? 'none' : parsed.notes.map(formatNote).join('\n') };
}

/** The prompt for a round that only fixes the Release note. */
export function releaseNotePrompt(prompt: string, errors: readonly string[]): string {
  return `${prompt}\n\n## Your Release note\n\nYour work is committed and needs no change, but the PR's Release note isn't right:\n\n${errors.map((e) => `- ${e}`).join('\n')}\n\nWrite \`.factory/result.json\` again, the same as before, with \`releaseNote\` set as "When you're done" says above. Don't change or commit anything else.`;
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
    try {
      await runAgentPatiently(deps, work, prompt);
    } catch (error) {
      // The agent may have finished before a later step failed (PEN-72: Sandcastle's session
      // capture). Keep its result, so a recovered run goes on from the gate (A1266).
      const read = await deps.readResult(work).catch(() => undefined);
      if (read?.ok && read.result.status === 'done')
        deps.log('agent-finished', {
          status: 'done',
          after: error instanceof Error ? error.message : String(error),
        });
      throw error;
    }
    const read = await deps.readResult(work);
    deps.log('agent-finished', read.ok ? { status: read.result.status } : { error: read.error });
    return read;
  } finally {
    await work.close();
  }
}

/**
 * The gate, in a fresh sandbox on the branch (FD25), then the proof the harness records itself.
 * `carry`: keep what passed (`proven.json`, carry.ts), and reuse an earlier run's proof and
 * validation when the branch's own diff outside docs/decisions.md is the one they passed on.
 */
export async function gateAndProve(
  deps: RunDeps,
  branch: string,
  scope: Scope,
  spec: IssueSpec,
  result: AgentResult,
  validation?: { readonly plan: string; readonly final: boolean; readonly images?: string },
  options: { readonly carry?: boolean } = {},
): Promise<GateVerdict> {
  const needed = proofPlatforms(scope, spec.platforms);
  // R9: an in-scope platform needs a named proof spec before anything runs.
  const unnamed = needed.filter((p) => !result.platforms[p]?.proofSpecs.length);
  if (unnamed.length > 0) {
    return {
      ok: false,
      reason: `no proof spec named for ${unnamed.join(', ')}`,
      feedback: `\`result.json\` names no proof spec for ${unnamed.join(', ')}, which the change affects. Add a committed test that shows the change and list it under \`platforms.<name>.proofSpecs\`.`,
    };
  }
  await deps.step('the gate');
  await deps.fetchMain();
  const gate = await deps.openSandbox(branch);
  try {
    const clean = await gate.exec('git status --porcelain --untracked-files=no');
    if (clean.stdout.trim() !== '')
      return {
        ok: false,
        reason: 'uncommitted changes',
        feedback: 'the branch has uncommitted changes to tracked files.',
      };
    // Up to date with main before anything is checked (F6). The harness resolves new decision
    // rows on both sides; any other conflict is the agent's to resolve.
    const rebased = await deps.rebase(gate);
    if (rebased.kind === 'conflict')
      return {
        ok: false,
        reason: conflictReason(rebased.files),
        feedback: conflictFeedback(branch, rebased),
      };
    noteRebase(deps, rebased);
    const numbered = await deps.numberDecisions(gate, branch);
    if (Object.keys(numbered).length > 0) deps.log('decisions-numbered', numbered);
    const installed = await gate.exec(GATE_INSTALL);
    if (installed.exitCode !== 0)
      return { ok: false, reason: INSTALL_REASON, feedback: installFeedback(installed) };
    const patch = (await gate.exec('git diff origin/main...HEAD')).stdout;
    const weak = scanWeakenedTests(patch);
    if (weak.length > 0)
      return { ok: false, reason: weakenedReason(weak), feedback: weakenedFeedback(weak) };
    // GitHub refuses the factory's push of a workflow change: refuse it here, before the push.
    const workflows = workflowChanges(patch);
    if (workflows.length > 0)
      return {
        ok: false,
        reason: `workflow change: ${workflows.join(', ')}`,
        feedback: workflowFeedback(workflows),
      };
    const command = gateCommand(scope);
    const checked = await deps.heavy(`factory gate ${branch}`, () => gate.exec(command));
    if (checked.exitCode !== 0) {
      deps.keep?.('gate.log', checked.stdout + checked.stderr);
      return {
        ok: false,
        reason: `${command} failed`,
        feedback: `\`${command}\` failed:\n\n\`\`\`\n${excerpt(checked.stdout + checked.stderr)}\n\`\`\``,
      };
    }
    deps.log('gate-passed', { command });
    // F19: a planned change that users see is walked on each app it affects and reviewed
    // against the plan (PEN-94).
    const validating = validation && scope.platforms.length > 0 ? validation : undefined;
    const wanted =
      options.carry && (needed.length > 0 || validating)
        ? await wantedNow(gate, needed, result, scope, validating)
        : undefined;
    // Proved and validated before on exactly these changes (a recovered run, rebased onto a main
    // that moved a decision row): the earlier run's proof and verdict stand.
    const earlier = wanted && carriedOver(deps.provenBefore?.(wanted.diff), wanted);
    if (wanted && earlier) {
      deps.log('proof-reused', {
        from: earlier.run,
        files: earlier.proof.length,
        diff: wanted.diff,
      });
      const rows = wanted.validation ? earlier.validation?.rows : undefined;
      if (rows)
        deps.log('validation-reused', {
          from: earlier.run,
          ...verdictCounts(rows),
        });
      return {
        ok: true,
        proof: earlier.proof,
        ...(rows ? { fidelity: settle(rows) } : {}),
        numbering: await sandboxNumbering(gate),
        proved: needed,
        carried: { run: earlier.run, validated: Boolean(rows) },
      };
    }
    const proven = (proof: readonly AttachedProof[], rows?: readonly FidelityRow[]) => {
      if (!wanted) return;
      const record: Proven = {
        run: deps.runId,
        diff: wanted.diff,
        specs: wanted.specs,
        proof,
        ...(rows && wanted.validation ? { validation: { key: wanted.validation.key, rows } } : {}),
      };
      deps.keep?.(PROVEN, `${JSON.stringify(record, null, 2)}\n`);
    };
    const items: ProofItem[] = [];
    for (const platform of needed) {
      const specs = result.platforms[platform]?.proofSpecs ?? [];
      if (platform === 'mac') {
        const mac = await recordMacProof(deps, gate, branch, specs);
        if (!mac.ok)
          return {
            ok: false,
            reason: `mac proof: ${mac.feedback}`,
            feedback: mac.feedback,
            block: 'mac-vm',
          };
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
        reason: missing.map((p) => `${p} proof: no passing recording`).join('; '),
        feedback: `the proof specs for ${missing.join(', ')} didn't pass when the harness ran them with recording on. ${LAST_PROOF_NOTE}${proofOutput(deps, missing)}`,
      };
    }
    const failing = failedProof(items, needed);
    if (failing.length > 0) {
      const platforms = needed.filter((p) => failing.some((f) => f.startsWith(`${p}: `)));
      return {
        ok: false,
        reason: proofReason(failing),
        feedback: `these tests in your proof specs failed when the harness ran them with recording on:\n\n${failing.map((f) => `- ${f}`).join('\n')}\n\nEvery test in a proof spec has to pass: fix the code or the test. ${LAST_PROOF_NOTE}${proofOutput(deps, platforms)}`,
      };
    }
    const prepared = await deps.prepareProof(items);
    if (!prepared.ok)
      return {
        ok: false,
        reason: `preparing the proof failed: ${prepared.error}`,
        feedback: prepared.error,
      };
    deps.log('proof-recorded', {
      files: prepared.proof.length,
      ...(wanted ? { diff: wanted.diff } : {}),
    });
    if (validating) {
      const v = await validate(deps, gate, branch, {
        plan: validating.plan,
        builder: result.risks,
        images: validating.images ?? '',
        platforms: scope.platforms,
      });
      if (!v.ok)
        return {
          ok: false,
          reason: `validation couldn't finish: ${v.error}`,
          feedback: `Validation couldn't finish: ${v.error}`,
        };
      const mismatches = v.rows.filter((r) => r.verdict === 'mismatch');
      if (mismatches.length > 0 && !validating.final)
        return {
          ok: false,
          reason: `validation: ${mismatches.map((r) => criterionLabel(r.criterion)).join(', ')} not met`,
          feedback: fidelityFeedback(mismatches),
          mismatches: mismatches.map((r) => criterionLabel(r.criterion)),
        };
      proven(prepared.proof, v.rows);
      return {
        ok: true,
        proof: prepared.proof,
        fidelity: settle(v.rows),
        numbering: await sandboxNumbering(gate),
        proved: needed,
      };
    }
    proven(prepared.proof);
    return {
      ok: true,
      proof: prepared.proof,
      numbering: await sandboxNumbering(gate),
      proved: needed,
    };
  } finally {
    await gate.close();
  }
}

/** What the gate would prove and validate now, for carriedOver; undefined without a diff print. */
async function wantedNow(
  gate: RunSandbox,
  needed: readonly Platform[],
  result: AgentResult,
  scope: Scope,
  validating: { readonly plan: string; readonly final: boolean } | undefined,
): Promise<Wanted | undefined> {
  const diff = await diffPrint(gate);
  if (!diff) return undefined;
  return {
    diff,
    specs: Object.fromEntries(needed.map((p) => [p, result.platforms[p]?.proofSpecs ?? []])),
    ...(validating
      ? {
          validation: {
            key: validationKey({
              plan: validating.plan,
              builder: result.risks,
              platforms: scope.platforms,
            }),
            final: validating.final,
          },
        }
      : {}),
  };
}

function verdictCounts(rows: readonly FidelityRow[]): Record<string, number> {
  return {
    match: rows.filter((r) => r.verdict === 'match').length,
    mismatch: rows.filter((r) => r.verdict === 'mismatch').length,
    deviation: rows.filter((r) => r.verdict === 'deviation').length,
  };
}

/**
 * `work` in the test VM, once the VM can take it (F7, F10): a Mac proof, or validation's Mac
 * walkthrough. While it can't (tart missing, the VM not made, another run on it, a VM started
 * some other way, a boot that fails), the run waits a poll and asks again: no failure, no round
 * used, and `factory:status` says why. The check and the work hold the heavy-job slot; the waits
 * don't. Only after `macProof.waitHours` does it give up, with the reason.
 */
export async function whenVmFree<T>(
  deps: Pick<RunDeps, 'config' | 'heavy' | 'macVmCheck' | 'now' | 'log' | 'sleep' | 'waitingFor'>,
  gate: RunSandbox,
  /** What waits, as `factory:status` says it: "the Mac proof". */
  what: string,
  heavyLabel: string,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; why: string }> {
  const since = deps.now();
  let said: string | undefined;
  try {
    for (;;) {
      const tried = await deps.heavy(heavyLabel, async () => {
        const check = await deps.macVmCheck(gate);
        if (!check.ok) return { wait: check.reason };
        try {
          return {
            value: await withTimeout(work, deps.config.timeouts.proofMinutes, `running ${what}`),
          };
        } catch (error) {
          if (error instanceof VmUnavailable) return { wait: error.message };
          throw error;
        }
      });
      if ('value' in tried) return { ok: true, value: tried.value };
      const hours = (deps.now().getTime() - since.getTime()) / 3_600_000;
      if (hours >= deps.config.macProof.waitHours)
        return {
          ok: false,
          why: `${what} waited ${deps.config.macProof.waitHours} h for the test VM (${deps.config.macProof.vm}), which still can't take it: ${tried.wait}.`,
        };
      if (tried.wait !== said) {
        deps.log('proof-waiting', { platform: 'mac', reason: tried.wait });
        said = tried.wait;
      }
      deps.waitingFor(`${what} waits for the test VM: ${tried.wait}`);
      await deps.sleep(deps.config.pollSeconds);
    }
  } finally {
    deps.waitingFor(null);
  }
}

/** The Mac proof, once the test VM can take it (whenVmFree). */
export async function recordMacProof(
  deps: RunDeps,
  gate: RunSandbox,
  branch: string,
  specs: readonly string[],
): Promise<{ ok: true; items: ProofItem[] } | { ok: false; feedback: string }> {
  const ran = await whenVmFree(
    deps,
    gate,
    'the Mac proof',
    `factory proof mac ${branch}`,
    (signal) => deps.recordProof(gate, 'mac', specs, signal),
  );
  if (ran.ok) return { ok: true, items: ran.value };
  const why = ran.why.replace(/^the Mac proof/, 'The Mac proof');
  return {
    ok: false,
    feedback: `${why} Fix the VM (docs/ci.md §8), then clear **${deps.config.blockedField}**.`,
  };
}

async function publish(
  deps: RunDeps,
  run: {
    item: BoardItem;
    branch: string;
    scope: Scope;
    result: AgentResult;
    /** The checked Release note, as the PR shows it. */
    releaseNote: string;
    /** The branch's first commit subject, for the title. */
    subject?: string;
    proof: readonly AttachedProof[];
    marker: (event: string) => string;
    prompt: string;
    artifacts?: RunInput['artifacts'];
    fidelity?: readonly FidelityRow[];
    /** The number each A-NEW-k on the branch has now: the body says those, not the placeholders. */
    numbering?: Readonly<Record<string, string>>;
    /** The platforms whose proof the harness ran and saw pass. */
    proved?: readonly Platform[];
    /** The earlier run the proof was carried over from, which the body says. */
    carried?: Carried;
  },
): Promise<RunOutcome> {
  // main may have moved while proof and validation ran (PEN-63's: 20 minutes, and another PR's
  // decision row merged meanwhile, so the PR it pushed conflicted and got no CI). Rebase once
  // more first; the gate runs again only when that brought in more than docs/decisions.md.
  let numbering = run.numbering ?? {};
  await deps.fetchMain();
  if (await deps.behindMain(run.branch)) {
    const fresh = await bringUpToDate(deps, run, { beforePush: true });
    if (!fresh.ok) return stopRun(deps, run, fresh.reason, fresh.body);
    numbering = fresh.numbering ?? numbering;
  }
  await deps.push(run.branch);
  deps.log('pushed', { branch: run.branch });
  const shown = forTheBody(run.result, run.fidelity, numbering, run.proved ?? []);
  const body = renderPrBody({
    issue: run.item.number,
    key: run.item.key,
    summary: shown.result.summary,
    releaseNote: run.releaseNote,
    scope: run.scope,
    gate: gateCommand(run.scope),
    proof: run.proof,
    decisions: shown.result.decisions,
    risks: shown.result.risks,
    marker: run.marker('pr'),
    ...(run.artifacts ? { artifacts: run.artifacts } : {}),
    ...(shown.fidelity ? { fidelity: renderFidelity(shown.fidelity) } : {}),
    ...(run.carried ? { carried: run.carried } : {}),
  });
  const pr = await deps.openPr({
    branch: run.branch,
    title: prTitle({
      title: shown.result.title,
      subject: run.subject,
      summary: shown.result.summary,
      key: run.item.key,
    }),
    body,
    proof: run.proof,
    files: (run.fidelity ?? []).flatMap((r) =>
      [r.mockup, r.screenshot].filter((f): f is string => Boolean(f)),
    ),
    ...(run.carried ? { proofFrom: run.carried.run } : {}),
  });
  deps.log('pr-opened', { pr });
  return awaitReview(deps, { ...run, result: shown.result }, pr);
}

/**
 * The agent's and the reviewer's text as the PR shows it: each A-NEW-k the gate numbered says
 * its number (in the summary, decisions, risks and the fidelity table's criteria and notes), and
 * the risks are settled against what the factory has since done (risks.ts).
 */
export function forTheBody(
  result: AgentResult,
  fidelity: readonly FidelityRow[] | undefined,
  numbering: Readonly<Record<string, string>>,
  proved: readonly Platform[],
): { result: AgentResult; fidelity?: FidelityRow[] } {
  const n = (text: string) => numberText(text, numbering);
  return {
    result: {
      ...result,
      summary: n(result.summary),
      decisions: result.decisions.map(n),
      risks: settleRisks(result.risks.map(n), proved),
    },
    ...(fidelity
      ? { fidelity: fidelity.map((r) => ({ ...r, criterion: n(r.criterion), note: n(r.note) })) }
      : {}),
  };
}

/** Stops the run: says why on the issue, with the marker, and sets Blocked. */
async function stopRun(
  deps: RunDeps,
  run: { readonly item: BoardItem; readonly marker: (event: string) => string },
  reason: string,
  text: string,
): Promise<RunOutcome> {
  deps.log('blocked', { reason });
  await deps.comment(run.item.number, `${text}\n\n${run.marker('blocked')}`);
  await deps.setBlocked(run.item);
  return { kind: 'blocked', reason };
}

/** A pushed PR to In review: CI green (repaired if red), on top of main. */
async function awaitReview(
  deps: RunDeps,
  run: {
    item: BoardItem;
    branch: string;
    scope: Scope;
    result: AgentResult;
    marker: (event: string) => string;
    prompt: string;
  },
  pr: string,
): Promise<RunOutcome> {
  const { config } = deps;
  const stop = (reason: string, text: string) => stopRun(deps, run, reason, text);
  // In review only once CI is green (R4); red checks go to a repair session (F6). A PR that
  // conflicts with main gets no CI: rebase it (gate, push) and watch again, a few times at most.
  let ci = await watchCi(deps, { ...run, pr });
  for (let refreshed = 0; ci.kind === 'conflict'; refreshed++) {
    if (refreshed >= MAX_CONFLICT_REFRESHES)
      return stop(
        'rebase-conflict',
        `${pr} still conflicts with main after ${refreshed} rebase(s), so GitHub runs no CI on it. Rebase it yourself, then clear Blocked.`,
      );
    deps.log('pr-conflicts', { pr });
    const fresh = await refreshBranch(deps, run);
    if (!fresh.ok) return stop(fresh.reason, fresh.body);
    ci = await watchCi(deps, { ...run, pr });
  }
  if (ci.kind === 'blocked') return stop(ci.reason, ci.body);
  // main may have moved while CI ran: rebase once more, so the PR reaches review on top of it.
  await deps.fetchMain();
  if (await deps.behindMain(run.branch)) {
    const fresh = await refreshBranch(deps, run);
    if (!fresh.ok) return stop(fresh.reason, fresh.body);
    const again = await watchCi(deps, { ...run, pr });
    if (again.kind === 'blocked') return stop(again.reason, again.body);
    if (again.kind === 'conflict')
      return stop(
        'rebase-conflict',
        `${pr} conflicts with main again right after a rebase, so GitHub runs no CI on it. Rebase it yourself, then clear Blocked.`,
      );
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
  | { readonly kind: 'conflict' }
  | { readonly kind: 'blocked'; readonly reason: string; readonly body: string };

/** How often a run rebases a PR that GitHub says conflicts with main before Ryan hears (A1311). */
export const MAX_CONFLICT_REFRESHES = 2;

export async function watchCi(
  deps: RunDeps,
  run: { item: BoardItem; branch: string; scope: Scope; pr: string; prompt: string },
): Promise<CiOutcome> {
  const { config } = deps;
  let since = deps.now();
  // Counted for the PR, not for this call: a restart (Ryan clearing Blocked) doesn't give the
  // agent `rounds.ciRepair` more rounds (A1313).
  const history = deps.ciHistory?.(run.item.number, run.pr);
  let repairs = history?.repairs ?? 0;
  const reruns = new Map(history?.reruns);
  let flakeReruns = history?.flakeReruns ?? 0;
  let saidStalled = false;
  let empty = 0;
  for (;;) {
    await deps.sleep(config.pollSeconds);
    const checks = await deps.checks(run.pr);
    const summary = summarizeChecks(checks, deps.now(), config.timeouts.ciMinutes, since);
    if (summary.kind === 'green') return { kind: 'green' };
    // No checks at all after a couple of polls: GitHub runs no CI on a PR that conflicts with main.
    empty = checks.length === 0 ? empty + 1 : 0;
    if (empty >= 2 && deps.conflicts && (await deps.conflicts(run.pr).catch(() => false)))
      return { kind: 'conflict' };
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
    const logs = await failedLogs(deps, summary.failed);
    deps.log('ci-red', { failed: summary.failed.map((c) => c.name), repairs });
    // Ryan's comment names the failing jobs and their last log lines, whichever way it stops.
    const failure = ciFailureText(run.pr, summary.failed, logs);
    // The runners' infrastructure, not the branch: re-run the failed jobs, no agent (A1312).
    const infra = infraFailure(summary.failed, logs);
    if (infra) {
      const rerun = await rerunInfra(deps, run, infra, reruns, failure);
      if (rerun.kind === 'blocked') return rerun;
      since = deps.now();
      saidStalled = false;
      continue;
    }
    // Tests the branch doesn't touch, in jobs that pass on main: one re-run first (A1328).
    if (flakeReruns < MAX_FLAKE_RERUNS && (await rerunFlake(deps, run, summary.failed, logs))) {
      flakeReruns++;
      since = deps.now();
      saidStalled = false;
      continue;
    }
    if (repairs >= config.rounds.ciRepair) {
      return {
        kind: 'blocked',
        reason: 'ci-red',
        body: `CI is still red after ${repairs} repair round(s): ${failure}`,
      };
    }
    repairs++;
    const repaired = await repair(deps, run, logs.join('\n\n'), repairs);
    if (!repaired.ok)
      return {
        kind: 'blocked',
        reason: 'ci-red',
        body: `A CI repair round couldn't finish: ${repaired.why}\n\nCI is red: ${failure}`,
      };
    deps.log('ci-repaired', { round: repairs, pr: run.pr });
    since = deps.now();
    saidStalled = false;
  }
}

/** The PR, its failed jobs (linked, with their Actions run) and their last log lines. */
export function ciFailureText(
  pr: string,
  failed: readonly CheckRun[],
  logs: readonly string[],
): string {
  return `${pr}\n\n${failed.map((c) => `- [${c.name}](${c.link})${runIdOf(c) ? ` (run ${runIdOf(c)})` : ''}`).join('\n')}\n\n${logs.join('\n\n')}`;
}

/**
 * Re-runs the failed jobs of an infrastructure failure (A1312), each Actions run at most
 * `MAX_INFRA_RERUNS` times (counted from the ledger too, so a restart doesn't reset it), and says
 * so on the issue the first time. After that the failure is Ryan's: no agent can fix the runners.
 * `reruns` is updated in place.
 */
export async function rerunInfra(
  deps: Pick<RunDeps, 'rerunFailed' | 'comment' | 'log'>,
  run: { readonly item: BoardItem; readonly pr: string },
  infra: InfraFailure,
  reruns: Map<string, number>,
  failure: string,
): Promise<{ readonly kind: 'rerun' } | Extract<CiOutcome, { kind: 'blocked' }>> {
  if ([...infra.runs.keys()].some((id) => (reruns.get(id) ?? 0) >= MAX_INFRA_RERUNS))
    return {
      kind: 'blocked',
      reason: 'ci-infra',
      body: `CI failed on the runners' infrastructure, not on this branch (${infra.signature}), and again after ${MAX_INFRA_RERUNS} re-runs, so no agent was asked to change anything: ${failure}\n\nRe-run the failed jobs once GitHub has recovered. When they pass, clear Blocked: the run goes back to waiting on CI (A1298).`,
    };
  let first = false;
  for (const [id, jobs] of infra.runs) {
    const attempt = (reruns.get(id) ?? 0) + 1;
    await deps.rerunFailed(id);
    reruns.set(id, attempt);
    deps.log('ci-rerun', { actionsRun: id, jobs, signature: infra.signature, attempt, pr: run.pr });
    if (attempt === 1) first = true;
  }
  if (first)
    await deps.comment(
      run.item.number,
      `CI failed on an infrastructure problem, not on this branch (${infra.signature}): ${[...infra.runs.values()].flat().join(', ')}. The factory is re-running the failed jobs, up to ${MAX_INFRA_RERUNS} times, rather than giving the agent a repair round. ${run.pr}`,
    );
  return { kind: 'rerun' };
}

/**
 * Re-runs the failed jobs, once per PR, when they look like a flaky test rather than the branch
 * (A1328, amending A1312): every failed job's log names the tests that failed, the branch's diff
 * against main touches none of them (nor a file with their stem), and each job passed the last
 * time main's CI ran it. Logs `ci-flake-rerun` (the ledger counts it per PR, so clearing Blocked
 * buys no more) and says so on the issue. False, with nothing done, when any of that doesn't hold
 * or can't be read: the failure is the branch's and gets a repair round, as before.
 */
export async function rerunFlake(
  deps: Pick<RunDeps, 'rerunFailed' | 'comment' | 'log'> &
    Partial<Pick<RunDeps, 'diff' | 'mainRunJobs'>>,
  run: { readonly item: BoardItem; readonly pr: string; readonly branch: string },
  failed: readonly CheckRun[],
  logs: readonly string[],
): Promise<boolean> {
  const { diff, mainRunJobs } = deps;
  if (!diff || !mainRunJobs) return false;
  const flake = flakeCandidate(failed, logs);
  if (!flake) return false;
  try {
    const { paths } = await diff(run.branch);
    if (flake.tests.some((t) => touchedBy(t, paths))) return false;
    const onMain = new Map<string, readonly (readonly RunJob[])[]>();
    for (const check of failed) {
      if (!check.workflow) return false;
      const runs = onMain.get(check.workflow) ?? (await mainRunJobs(check.workflow));
      onMain.set(check.workflow, runs);
      if (!passedOnMain(check.name, runs)) return false;
    }
  } catch {
    return false;
  }
  try {
    for (const id of flake.runs.keys()) await deps.rerunFailed(id);
  } catch {
    // GitHub refused the re-run (a run still going, say): the repair round goes ahead.
    return false;
  }
  const jobs = [...flake.runs.values()].flat();
  deps.log('ci-flake-rerun', {
    pr: run.pr,
    jobs,
    tests: flake.tests,
    actionsRuns: [...flake.runs.keys()],
  });
  await deps.comment(
    run.item.number,
    `CI failed in tests this branch doesn't change, in jobs that pass on main (${flake.tests.join(', ')}): ${jobs.join(', ')}. The factory is re-running the failed jobs once, in case the tests are flaky, before giving the agent a repair round. ${run.pr}`,
  );
  return true;
}

/** Each failed job's last log lines, as the repair prompt and Ryan's comment show them. */
export function failedLogs(
  deps: Pick<RunDeps, 'failedLog'>,
  failed: readonly CheckRun[],
): Promise<string[]> {
  return Promise.all(
    failed.map(async (c) => `### ${c.name}\n\n\`\`\`\n${await deps.failedLog(c)}\n\`\`\``),
  );
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
      `${run.prompt}\n\n## CI failed (repair round ${round})\n\nThe PR from \`${run.branch}\` is open and its CI failed. The failed jobs' last log lines:\n\n${logs}\n\nFix the cause (never by weakening or skipping tests), commit, and write \`.factory/result.json\` again. ${CI_REPAIR_LIMITS} ${STALE_MAIN}`,
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
  | {
      readonly ok: true;
      readonly rebase: Rebased;
      /** The number each A-NEW-k on the branch has now (`branchNumbering`), when asked for. */
      readonly numbering?: Readonly<Record<string, string>>;
    }
  | {
      readonly ok: false;
      readonly why: string;
      /** The refusal in one short line, for the ledger and daemon.log (`gate-failed`). */
      readonly reason: string;
      readonly conflict?: readonly string[];
    };

/**
 * The branch rebased onto a fresh main in a gate sandbox, and the gate run on it again. `light`:
 * when the rebase changed nothing but docs/decisions.md (main's new decision rows, a number
 * moved), the gate's check is skipped: the code it passed is the code that is there.
 * `numbering`: also read the number each A-NEW-k has on the branch, for a PR body.
 */
async function regate(
  deps: RunDeps,
  branch: string,
  scope: Scope,
  options: { readonly light?: boolean; readonly numbering?: boolean } = {},
): Promise<Regated> {
  await deps.step('the gate');
  await deps.fetchMain();
  const gate = await deps.openSandbox(branch);
  const numbering = async () =>
    options.numbering ? { numbering: await sandboxNumbering(gate) } : {};
  try {
    const before = options.light ? await gate.exec('git rev-parse HEAD') : undefined;
    const rebased = await deps.rebase(gate);
    if (rebased.kind === 'conflict')
      return {
        ok: false,
        why: conflictFeedback(branch, rebased),
        reason: conflictReason(rebased.files),
        conflict: rebased.files,
      };
    noteRebase(deps, rebased);
    const numbered = await deps.numberDecisions(gate, branch);
    if (Object.keys(numbered).length > 0) deps.log('decisions-numbered', numbered);
    if (before?.exitCode === 0 && /^[0-9a-f]{7,64}$/.test(before.stdout.trim())) {
      const changed = await gate.exec(`git diff --name-only ${before.stdout.trim()} HEAD`);
      const paths = changed.stdout.split('\n').filter(Boolean);
      if (changed.exitCode === 0 && paths.every((path) => path === DECISIONS)) {
        deps.log('rebased', { phase: 'push', gate: 'skipped', changed: paths });
        return { ok: true, rebase: rebased, ...(await numbering()) };
      }
    }
    const installed = await gate.exec(GATE_INSTALL);
    if (installed.exitCode !== 0)
      return { ok: false, why: installFeedback(installed), reason: INSTALL_REASON };
    const patch = (await gate.exec('git diff origin/main...HEAD')).stdout;
    const weak = scanWeakenedTests(patch);
    if (weak.length > 0)
      return { ok: false, why: weakenedFeedback(weak), reason: weakenedReason(weak) };
    const workflows = workflowChanges(patch);
    if (workflows.length > 0)
      return {
        ok: false,
        why: workflowFeedback(workflows),
        reason: `workflow change: ${workflows.join(', ')}`,
      };
    const command = gateCommand(scope);
    const checked = await deps.heavy(`factory gate ${branch}`, () => gate.exec(command));
    if (checked.exitCode !== 0) {
      deps.keep?.('gate.log', checked.stdout + checked.stderr);
      return {
        ok: false,
        reason: `${command} failed`,
        why: `\`${command}\` failed:\n\n\`\`\`\n${excerpt(checked.stdout + checked.stderr)}\n\`\`\``,
      };
    }
    deps.log('gate-passed', { command, phase: 'rebase' });
    return { ok: true, rebase: rebased, ...(await numbering()) };
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
  | {
      readonly ok: true;
      readonly rebase: Rebased;
      readonly numbering?: Readonly<Record<string, string>>;
    }
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
  const fresh = await bringUpToDate(deps, run);
  if (!fresh.ok) return fresh;
  await deps.push(run.branch);
  deps.log('pushed', { branch: run.branch, phase: 'rebase' });
  return fresh;
}

/**
 * `refreshBranch` without the push: the branch rebased onto main and gated again, with one fix
 * round for the agent. `beforePush`, the first push's: the gate's check is skipped when the
 * rebase brought in nothing but docs/decisions.md (`regate`'s `light`; after an agent's fix
 * round it always runs), and the outcome has the branch's decision numbers for the PR body.
 */
async function bringUpToDate(
  deps: RunDeps,
  run: { readonly branch: string; readonly scope: Scope; readonly prompt: string },
  options: { readonly beforePush?: boolean } = {},
): Promise<RefreshOutcome> {
  const numbering = options.beforePush ?? false;
  let gated = await regate(deps, run.branch, run.scope, { light: numbering, numbering });
  if (!gated.ok) {
    const first = gated;
    deps.log(first.conflict ? 'rebase-conflict' : 'gate-failed', {
      ...(first.conflict ? { files: first.conflict } : {}),
      phase: 'rebase',
      reason: oneLine(first.reason),
    });
    const ask = first.conflict
      ? `## \`origin/main\` moved: rebase onto it\n\n\`${run.branch}\` no longer rebases onto \`origin/main\`. ${first.why}\n\nKeep what \`origin/main\` changed and what this branch changes. ${STALE_MAIN} Run the checks, commit, and write \`.factory/result.json\` again.`
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
    gated = await regate(deps, run.branch, run.scope, { numbering });
    if (!gated.ok) return stuck(run.branch, gated, '');
  }
  return {
    ok: true,
    rebase: gated.rebase,
    ...(gated.numbering ? { numbering: gated.numbering } : {}),
  };
}

function tail(text: string): string {
  return text.trim().split('\n').slice(-30).join('\n');
}

const ERROR_LINE = /\berror\b|✖|✘|×|\bFAIL\b|\bfailed\b/i;

/** A terminal colour code (ESC, then `[…m` and the like). */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, 'g');
/** A failure's heading in Playwright's list reporter: `  1) [chromium] › a.spec.ts:12:3 › title`. */
const PW_FAILURE = /^ {2}(\d+)\) (\S.*(›|:\d+:\d+).*)$/;
/** The line that ends a failure's own block: its first attachment or its error context. */
const PW_BLOCK_END = /^\s+(attachment #\d+:|Error Context:)/;
/** The line after Playwright's failures: its summary, `  1 failed` and the like. */
const PW_SUMMARY = /^ {2}\d+ (failed|flaky|passed|skipped|interrupted|did not run)\b/;
/** A failing test's retry: the same failure again. */
const PW_RETRY = /^\s+Retry #\d+\b/;
/** A failure's block, and all of them, at most. */
const BLOCK_LINES = 60;
const BLOCKS_CHARS = 12_000;

/** A line as the excerpt shows it: no colour codes, no box-drawing rule at its end. */
function plain(line: string): string {
  return line
    .replaceAll(ANSI, '')
    .replace(/\s*─+\s*$/, '')
    .trimEnd();
}

/**
 * Each Playwright failure in a test run's output: from its `  1) <title>` heading through its
 * first `attachment #` or `Error Context:` line, so the error, its call log, the code frame with
 * its `>` line and the `at file:line` lines, without colour codes. A failing test's retry is the
 * same failure again and is left out, as is a heading seen before. `span` is the lines the
 * failures take, from the first heading up to the summary.
 */
export function playwrightFailures(text: string): {
  blocks: string[];
  span?: { from: number; to: number };
} {
  const lines = text.split('\n').map(plain);
  const blocks: string[] = [];
  const seen = new Set<string>();
  let chars = 0;
  let more = 0;
  let from: number | undefined;
  let to = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (from !== undefined && PW_SUMMARY.test(line)) {
      to = i;
      break;
    }
    const heading = PW_FAILURE.exec(line);
    if (!heading) continue;
    from ??= i;
    const block = [line];
    let j = i + 1;
    for (; j < lines.length && block.length < BLOCK_LINES; j++) {
      const next = lines[j] ?? '';
      if (PW_FAILURE.test(next) || PW_RETRY.test(next) || PW_SUMMARY.test(next)) break;
      block.push(next);
      if (PW_BLOCK_END.test(next)) break;
    }
    const title = (heading[2] ?? '').trim();
    if (seen.has(title)) continue;
    seen.add(title);
    while (block.length > 1 && !block.at(-1)?.trim()) block.pop();
    const shown = block.join('\n');
    if (blocks.length > 0 && chars + shown.length > BLOCKS_CHARS) {
      more++;
      continue;
    }
    chars += shown.length;
    blocks.push(shown);
  }
  if (more > 0) blocks.push(`… and ${more} more failures, in the whole output`);
  return from === undefined ? { blocks } : { blocks, span: { from, to } };
}

/**
 * A failed check's or proof's Playwright failures (each one's error, call log and code frame),
 * then its other lines that name an error (up to 40), then its last lines. The tail alone stopped
 * before ESLint's errors in PEN-70's gate, so neither the agent nor the log said what failed; the
 * whole output is kept in the run folder too (`gate.log`, A1250). In a Playwright run the tail is
 * retries and attachments, and its error lines alone lose the call log and the code frame:
 * PEN-121's agent guessed the wrong assertion (A1343). The error lines leave out the failures'
 * own span, which their blocks show.
 */
export function excerpt(text: string): string {
  const last = tail(text);
  const { blocks, span } = playwrightFailures(text);
  const shown = new Set(last.split('\n'));
  const errors = text
    .split('\n')
    .filter(
      (line, i) =>
        ERROR_LINE.test(line) && !shown.has(line) && !(span && i >= span.from && i < span.to),
    )
    .slice(0, 40);
  const before = [...blocks, ...(errors.length ? [errors.join('\n')] : [])];
  return before.length ? `${before.join('\n\n')}\n…\n${last}` : last;
}

/**
 * What the agent's next sandbox has from the proof (`stageLastProof` in host.ts, and
 * proof/evidence.ts for what a failing test leaves), named as the files are.
 */
export const LAST_PROOF_NOTE =
  "The harness's files from this proof are in `.factory/last-proof/`: each test's last screenshot (`<platform>-<n>-screenshot.png`, or `.jpg` when it is the Mac window's last screencast frame), and for each failing test `<platform>-failures.md`, which gives its error and lists its files there: Playwright's `<platform>-<n>-error-context.md`, its text attachments and logs (`<platform>-<n>-<attachment>.txt` or `.log`, each cut to its last 200 KB; on Android its instrumentation output and logcat) and its PNG attachments. Read them before you change anything, to see where and why the spec stopped.";

/** What each missing platform's proof printed, for the agent: the harness's run, not its own. */
function proofOutput(deps: RunDeps, platforms: readonly Platform[]): string {
  return platforms
    .map((p) => [p, deps.proofLog?.(p)] as const)
    .filter((e): e is readonly [Platform, string] => Boolean(e[1]?.trim()))
    .map(([p, log]) => `\n\nThe ${p} proof's output:\n\n\`\`\`\n${excerpt(log)}\n\`\`\``)
    .join('');
}
