/**
 * What an implementation run works through (F4, #263): `RunDeps`, every outside effect the run
 * has, and the sandbox, input and outcome types. host.ts is the real one; the tests give fakes, so
 * the run's sequence (run.ts) is tested without GitHub, git or an agent.
 */
import type { Board, BoardItem } from './board.ts';
import type { FactoryConfig, Platform, SlotConfig } from './config.ts';
import type { IssueSpec } from './labels.ts';
import type { CheckRun } from './checks.ts';
import type { CiHistory } from './ci-failure.ts';
import type { RunJob } from './merge.ts';
import type { Scope } from './platforms.ts';
import type { FidelityRow } from './fidelity.ts';
import type { AttachedProof } from './proof/body.ts';
import type { ProofItem } from './proof/manifest.ts';
import type { VmCheck } from './proof/mac.ts';
import type { RebaseOutcome } from './rebase.ts';
import type { Proven } from './carry.ts';
import type { AgentResult } from './result.ts';
import type { IssueComment } from './issue.ts';
import type { WalkOutcome, WalkPlatform } from './walk.ts';

export type RunEvent =
  | 'claimed'
  | 'agent-started'
  | 'agent-continued'
  | 'agent-finished'
  | 'owner-comments'
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
  | 'validation-incomplete'
  | 'budgets-checked'
  | 'validation-reused'
  | 'resumed-at-ci'
  | 'release-note-refused';

/** `.factory/result.json` as read: `missing` when the agent wrote none at all. */
export type ResultRead =
  | { readonly ok: true; readonly result: AgentResult }
  | { readonly ok: false; readonly error: string; readonly missing?: boolean };

export interface RunSandbox {
  readonly worktreePath: string;
  /** Runs `command` in the sandbox; aborting `signal` stops everything running in it (F2). */
  exec(
    command: string,
    options?: { readonly signal?: AbortSignal },
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
  /**
   * Whether the sandbox's last agent session can be continued (`continueAgent`): its agent keeps
   * its sessions for a resume (Claude Code does; the factory's OpenCode doesn't, A1263).
   */
  canContinue?(sandbox: RunSandbox): boolean;
  /** Continues the sandbox's last agent session with `message`; resolves as `runAgent` does. */
  continueAgent?(sandbox: RunSandbox, message: string): Promise<{ readonly output: string } | void>;
  /**
   * Ryan's comments on the run's card that its prompt doesn't hold: newer than the issue the
   * prompt was built from, oldest first, the factory's own left out (A1347). Each agent round
   * gets them, so what he says mid-run lands on the next round.
   */
  ownerComments?(): Promise<readonly IssueComment[]>;
  /** Keeps a file in the run's folder (`runs/<run>/<name>`), such as the gate's whole output. */
  keep?(name: string, text: string): void;
  /** The last proof run's output for a platform (`runs/<run>/proof-<platform>.log`), if kept. */
  proofLog?(platform: Platform): string | undefined;
  /**
   * The tracked files the sandbox's worktree has uncommitted changes to, as the gate checks them
   * (PEN-141): a session that reported done with some gets one more turn to commit them.
   */
  uncommitted?(sandbox: RunSandbox): Promise<readonly string[]>;
  /** `.factory/result.json` from the worktree, parsed (or why it couldn't be). */
  readResult(sandbox: RunSandbox): Promise<ResultRead>;
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
  /** captures.json, for validation's coverage check (A1650). */
  readCaptures?(sandbox: RunSandbox): Promise<string | null>;
  /** The proof's stills for the reviewer (A1650); see validate.ts. */
  stageProof?(sandbox: RunSandbox, proof: readonly AttachedProof[]): Promise<string>;
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
  /**
   * A recovered run's gate rounds so far (PEN-142): the rounds the runs it recovers used, from
   * the ledger (`roundsUsed`). Its rounds go on from there, so the limit holds across recoveries.
   */
  readonly firstRound?: number;
  /**
   * A recovered run whose agent had finished, and Ryan's comments on the card since it did
   * (A1347): the agent runs again with them, rather than the run going on from the gate.
   */
  readonly replies?: readonly IssueComment[];
}

export type RunOutcome =
  | { readonly kind: 'in-review'; readonly pr: string; readonly scope: Scope }
  | { readonly kind: 'blocked'; readonly reason: string };
