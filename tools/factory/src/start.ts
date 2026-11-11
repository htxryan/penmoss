/** Starting one run: shared by `factory run <issue>` (foreground) and the daemon. */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { agentFor, remoteAgentFor } from './agents/index.ts';
import { postChat } from './chat.ts';
import type { Board, BoardItem } from './board.ts';
import { expandHome, type FactoryConfig, type SlotConfig } from './config.ts';
import { scopeText } from './platforms.ts';
import { nodeExec } from './exec.ts';
import { createGh, type Gh } from './github.ts';
import { createAppTokens, loadAppCredentials, type AppTokens } from './github-app.ts';
import { loadProofStore, type ProofStore } from './proof/store.ts';
import { BlockedByRyan, guardEffects, RUN_GUARDED, RUN_STEPS } from './guard.ts';
import { AgentNotInstalled, ensureClone, hostDeps, publisherEnv } from './host.ts';
import { issueText, type Issue } from './issue.ts';
import { ATTACHMENTS, localizeImages, type LocalImageOptions } from './attachments.ts';
import { optedIn, parseIssueSpec, type IssueSpec } from './labels.ts';
import { formatMarker } from './pick.ts';
import { advancePlanning, type PlanDeps } from './plan-run.ts';
import {
  agreedPlanPath,
  findSession,
  launchSession,
  planFiles,
  planningEnv,
  planText,
  prepareSnapshot,
  readMeta,
  stopSession,
} from './planning-host.ts';
import type { PlanningAction } from './planning.ts';
import { fill, promptTemplate } from './prompt.ts';
import { branchName, runImplement, type RunOutcome } from './run.ts';
import { parseAgentResult, type AgentResult } from './result.ts';
import { loadSecrets, type Secrets } from './secrets.ts';
import { openTracker } from './tracker/index.ts';
import { ensureTrackerState } from './tracker/state.ts';
import { issueKey, type Tracker } from './tracker/port.ts';

export interface Factory {
  readonly config: FactoryConfig;
  readonly gh: Gh;
  /** Where the cards live (LD1): Project 8 through the bot's gh, or Linear as the factory app. */
  readonly tracker: Tracker;
  readonly secrets: Secrets;
  /** The GitHub App's installation tokens (A1222). */
  readonly app: AppTokens;
  /** The R2 bucket proof goes to (A1223). */
  readonly proof: ProofStore;
}

export interface OpenOptions {
  /**
   * Whether to prepare the runs' clone and the publish repo (`ensureClone`). Only what runs
   * cards needs them: the daemon and `factory run`. The UI reads the tracker and the state
   * folder only, and `factory:update` starts it with the daemon: both writing the clone's
   * config at once made one of them lose `config.lock` and exit.
   */
  readonly clone?: boolean;
}

/** The GitHub App, the env file and the tracker, checked. */
export async function openFactory(
  config: FactoryConfig,
  options: OpenOptions = {},
): Promise<{ ok: true; factory: Factory } | { ok: false; error: string }> {
  const secrets = loadSecrets(expandHome(config.envFile));
  if (!secrets.ok) return { ok: false, error: `the env file: ${secrets.error}` };
  const proof = loadProofStore(config);
  if (!proof.ok) return { ok: false, error: `the proof bucket: ${proof.error}` };
  const creds = loadAppCredentials(expandHome(config.publisher.envFile));
  if (!creds.ok) return { ok: false, error: `the GitHub App: ${creds.error}` };
  const app = createAppTokens({
    appId: creds.appId,
    privateKey: creds.privateKey,
    repo: config.repo,
  });
  let identity;
  try {
    identity = await app.identity();
    await app.write();
  } catch (error) {
    return {
      ok: false,
      error: `the GitHub App: ${error instanceof Error ? error.message : String(error)} (is it installed on ${config.repo}?)`,
    };
  }
  if (identity.slug !== config.publisher.login)
    return {
      ok: false,
      error: `the GitHub App's key is for "${identity.slug}", not ${config.publisher.login}`,
    };
  const gh = createGh({ exec: nodeExec, env: publisherEnv(config), token: () => app.write() });
  if (options.clone ?? true) await ensureClone(config, nodeExec, identity);
  const tracker = await openTracker(config, gh);
  if (!tracker.ok) return tracker;
  ensureTrackerState(config);
  return {
    ok: true,
    factory: {
      config,
      gh,
      tracker: tracker.tracker,
      secrets: secrets.secrets,
      app,
      proof: proof.store,
    },
  };
}

/**
 * The issue for an agent: its images downloaded on the host, with the tracker's credentials, to
 * where the agent reads them, and its text pointing there (attachments.ts). Nothing here stops
 * the run: if the images can't be handled at all, the agent gets the issue as it is.
 */
export async function issueForAgent(
  tracker: Tracker,
  issue: Issue,
  where: Omit<LocalImageOptions, 'download'>,
): Promise<{ readonly issue: Issue; readonly text: string; readonly images: string }> {
  let local: { issue: Issue; note: string };
  try {
    local = await localizeImages(issue, tracker.owner, {
      ...where,
      download: tracker.download?.bind(tracker),
    });
  } catch (error) {
    local = {
      issue,
      note: `## The issue's images\n\nThe factory couldn't download the issue's images: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const text = issueText(local.issue, tracker.owner, 'penmoss-factory');
  return {
    issue: local.issue,
    text: local.note ? `${text}\n\n${local.note}` : text,
    images: local.note,
  };
}

/** Where a run's agent reads the issue's images: its worktree's `.factory/attachments/`. */
export function runImages(
  config: FactoryConfig,
  runId: string,
): Omit<LocalImageOptions, 'download'> {
  return {
    dir: join(expandHome(config.stateDir), 'runs', runId, ATTACHMENTS),
    shownAs: (file) => `.factory/${ATTACHMENTS}/${file}`,
    relativeTo: 'the repository root, your working folder',
  };
}

/** Why a card can't run now, or its spec. */
export function runnable(
  config: FactoryConfig,
  item: BoardItem,
  statuses: readonly string[],
): { ok: true; spec: IssueSpec } | { ok: false; error: string } {
  if (item.blocked)
    return {
      ok: false,
      error: `${item.key} has ${config.blockedField} set; the factory never acts on it`,
    };
  if (!optedIn(item.labels, config))
    return {
      ok: false,
      error: `${item.key} has no ${config.optInLabel} label; the factory acts only on cards that do`,
    };
  if (!statuses.includes(item.status ?? ''))
    return { ok: false, error: `${item.key} is in ${item.status ?? 'no status'}` };
  const parsed = parseIssueSpec(item.labels, config);
  if (!parsed.ok) return { ok: false, error: `${item.key}'s labels: ${parsed.error}` };
  return { ok: true, spec: parsed.spec };
}

/** What the implementation prompt says about planning: the agreed plan, or why there is none. */
export function planFor(config: FactoryConfig, issue: number, spec: IssueSpec): string {
  if (spec.planSkip)
    return `None: the issue is labelled ${config.planning.skipLabel}, so the issue is the spec.`;
  const files = planFiles(config, issue);
  const agreed = readMeta(files).agreed;
  if (agreed?.trivial) return `None: planning judged the issue trivial (${agreed.quote}).`;
  const path = agreedPlanPath(files);
  if (!agreed || !existsSync(path))
    throw new Error(`${issueKey(config, issue)} has no agreed plan`);
  return `Ryan agreed this plan ("${agreed.quote}"). Build what it specifies and meet every acceptance criterion; where it and the issue differ, the plan wins.\n\n${planText(readFileSync(path, 'utf8'))}`;
}

/** The agreed plan and design artifacts with their versions, for the PR body (F16). */
export function agreedArtifacts(
  config: FactoryConfig,
  issue: number,
): { label: string; href: string }[] {
  const a = readMeta(planFiles(config, issue)).agreed;
  if (!a || a.trivial) return [];
  const v = (n: number | null | undefined) => (typeof n === 'number' ? ` (v${n})` : '');
  return [
    ...(a.planUrl ? [{ label: `plan${v(a.planVersion)}`, href: a.planUrl }] : []),
    ...(a.designUrl ? [{ label: `design${v(a.designVersion)}`, href: a.designUrl }] : []),
  ];
}

/** The agreed plan's text for validation (F19); none when planning was skipped or trivial. */
export function agreedPlanText(
  config: FactoryConfig,
  issue: number,
  spec: IssueSpec,
): string | undefined {
  if (spec.planSkip) return undefined;
  const files = planFiles(config, issue);
  const agreed = readMeta(files).agreed;
  const path = agreedPlanPath(files);
  if (!agreed || agreed.trivial || !existsSync(path)) return undefined;
  return planText(readFileSync(path, 'utf8'));
}

/** Whether the card's plan is agreed (or planning was skipped as trivial). */
export function planAgreed(config: FactoryConfig, issue: number): boolean {
  return !!readMeta(planFiles(config, issue)).agreed;
}

/** One step of a card's planning on this Mac (no slot), every effect guarded by Blocked. */
export async function executePlanning(
  factory: Factory,
  item: BoardItem,
  log: (line: string) => void,
): Promise<PlanningAction | { kind: 'stopped' }> {
  const { config, tracker } = factory;
  await ensureClone(config, nodeExec);
  const files = planFiles(config, item.number);
  // The session reads the issue's images from the plan's own folder, which only the host writes.
  const { issue, text, images } = await issueForAgent(
    tracker,
    await tracker.readIssue(item.number),
    {
      dir: files.attachments,
      shownAs: (file) => join(files.attachments, file),
    },
  );
  // Ryan's own Claude.ai login, not the factory's token, so Remote Control works (A1286).
  const env = planningEnv(process.env);
  const deps: PlanDeps = {
    comment: (n, body) => tracker.comment(n, body),
    setStatus: (i, status) => tracker.setStatus(i, status),
    setBlocked: (i) => tracker.setBlocked(i),
    snapshot: () => prepareSnapshot(config, files, nodeExec),
    launch: async (message, resume) => {
      const { id, chatUrl } = await launchSession(
        config,
        nodeExec,
        files,
        item.number,
        message,
        env,
        resume,
      );
      const found = await findSession(config, nodeExec, item.number, env, { id });
      if (!found)
        throw new Error(
          `the planning session started${id ? ` (${id})` : ''} but \`claude agents\` does not list it`,
        );
      log(`planning session ${found.sessionId}${resume ? ' resumed' : ' started'}`);
      return { sessionId: found.sessionId, ...(chatUrl ? { chatUrl } : {}) };
    },
    stop: (sessionId) => stopSession(config, nodeExec, item.number, sessionId, env),
    session: async () => {
      const found = await findSession(config, nodeExec, item.number, env, {
        sessionId: readMeta(files).sessionId,
      });
      return found ? { busy: found.status === 'busy' } : undefined;
    },
    now: () => new Date(),
  };
  const isBlocked = () => tracker.isBlocked(item.number);
  const guarded = guardEffects(
    deps,
    ['comment', 'setStatus', 'setBlocked', 'snapshot', 'launch'],
    item.number,
    isBlocked,
  );
  const prompt = fill(promptTemplate('planning'), {
    issue: text,
    repo: files.repo,
    out: files.out,
  });
  try {
    return await advancePlanning(guarded, {
      config,
      owner: tracker.owner,
      item,
      issue,
      files,
      prompt,
      images,
    });
  } catch (error) {
    if (error instanceof BlockedByRyan) return { kind: 'stopped' };
    const message = error instanceof Error ? error.message : String(error);
    if (!(await isBlocked())) {
      await deps
        .comment(
          item.number,
          `Planning stopped on an error: ${message}\n\n${formatMarker({ issue: String(item.number), event: 'blocked' })}`,
        )
        .catch(() => undefined);
      await tracker.setBlocked(item).catch(() => undefined);
    }
    throw error;
  }
}

/**
 * The run whose agent last finished its work on `issue` ("agent-finished" done) with nothing
 * started since: no later agent round, no In review or merge. A recovered run (R12) goes on from
 * that run's result at the gate rather than running the agent again. A run that resumed this way
 * names the run it took the result from (`from`), which is where the result still is.
 */
export function finishedRound(ledger: string, issue: number): string | undefined {
  let finished: string | undefined;
  for (const line of ledger.split('\n')) {
    if (!line.trim()) continue;
    let e: { event?: string; issue?: number; run?: string; status?: string; from?: string };
    try {
      e = JSON.parse(line) as typeof e;
    } catch {
      continue; // A torn last line from a crash.
    }
    if ((e.issue ?? Number(String(e.run ?? '').split('-')[0])) !== issue) continue;
    if (e.event === 'agent-finished')
      finished = e.status === 'done' ? (e.from ?? e.run) : undefined;
    else if (['agent-started', 'in-review', 'merged', 'done'].includes(e.event ?? ''))
      finished = undefined;
  }
  return finished;
}

/**
 * For a recovered run (R12): the run whose agent last finished its work on the card, from the
 * ledger, with the result the host kept in its folder (`runs/<run>/result.json`). Nothing when
 * there is none, or the result no longer reads: the run then starts the agent again.
 */
export function resumeFrom(
  config: FactoryConfig,
  issue: number,
): { resume?: { run: string; result: AgentResult } } {
  const state = expandHome(config.stateDir);
  const ledger = join(state, 'runs.jsonl');
  if (!existsSync(ledger)) return {};
  const run = finishedRound(readFileSync(ledger, 'utf8'), issue);
  if (!run || !/^[\w-]+$/.test(run)) return {};
  const file = join(state, 'runs', run, 'result.json');
  if (!existsSync(file)) return {};
  const parsed = parseAgentResult(readFileSync(file, 'utf8'));
  return parsed.ok && parsed.result.status === 'done'
    ? { resume: { run, result: parsed.result } }
    : {};
}

/**
 * What the card's comment says when a run stops on an error. An agent the factory can't find is
 * its installation's problem (PEN-75's first run: `claude` missing from the LaunchAgent's PATH),
 * and says so, rather than reading as if the card had failed.
 */
export function stoppedText(error: unknown, message: string): string {
  if (error instanceof AgentNotInstalled)
    return `The run couldn't start the agent: ${message}. Nothing is wrong with this card: once the factory can find \`${error.command}\`, clear Blocked and the run starts again.`;
  return `The run stopped on an error: ${message}`;
}

/** One implementation run on a slot, with every side effect guarded by the card's Blocked field. */
export async function executeRun(
  factory: Factory,
  board: Board,
  item: BoardItem,
  spec: IssueSpec,
  slot: SlotConfig,
  log: (line: string) => void,
  /** The daemon restarts this run after it stopped mid-run (R12). */
  recovered = false,
  /** What the run waits for, for the daemon's status.json (F10). */
  waitingFor?: (reason: string | null) => void,
): Promise<RunOutcome | { kind: 'stopped' }> {
  const { config, gh, tracker } = factory;
  const runId = `${item.number}-${Date.now().toString(36)}-${randomBytes(2).toString('hex')}`;
  await ensureClone(config, nodeExec);
  const { text, images } = await issueForAgent(
    tracker,
    await tracker.readIssue(item.number),
    runImages(config, runId),
  );
  const prompt = fill(promptTemplate('implement'), {
    branch: branchName(config, item),
    issue: text,
    plan: planFor(config, item.number, spec),
    scope: scopeText(spec.platforms),
  });
  const agent = await agentFor(config, spec);
  const remoteAgent = await remoteAgentFor(config, spec, item.number);
  const deps = hostDeps({
    config,
    slot,
    runId,
    board,
    gh,
    tracker,
    exec: nodeExec,
    secrets: factory.secrets,
    pushToken: () => factory.app.write(),
    sandboxToken: () => factory.app.read(),
    proofStore: factory.proof,
    agent,
    remoteAgent,
    onChat: (url) => postChat(tracker, item.number, url, log),
    log,
    ...(waitingFor ? { waitingFor } : {}),
  });
  const isBlocked = () => tracker.isBlocked(item.number);
  // Every effect, and every step that starts work: Blocked set mid-run stops the run before its
  // next sandbox, gate, proof, numbering, push or PR, not only before the next effect (PEN-75's
  // gate ran on after Ryan set Blocked). macVmCheck too: a run waiting for the test VM stops at
  // its next check.
  const guarded = guardEffects(deps, RUN_GUARDED, item.number, isBlocked, RUN_STEPS);
  try {
    const artifacts = spec.planSkip ? [] : agreedArtifacts(config, item.number);
    const plan = agreedPlanText(config, item.number, spec);
    return await runImplement(guarded, {
      item,
      spec,
      prompt,
      ...(artifacts.length ? { artifacts } : {}),
      ...(plan ? { plan } : {}),
      ...(images ? { images } : {}),
      ...(recovered ? { recovered } : {}),
      ...(recovered ? resumeFrom(config, item.number) : {}),
    });
  } catch (error) {
    if (error instanceof BlockedByRyan) {
      // The claim stays open in the ledger: clearing Blocked restarts the run (R12).
      deps.log('failed', { stopped: `Blocked set by Ryan: stopped before ${error.step}` });
      return { kind: 'stopped' };
    }
    // Anything unexpected: say so on the issue and set Blocked, so the card is never left stuck.
    const message = error instanceof Error ? error.message : String(error);
    deps.log(
      'failed',
      error instanceof AgentNotInstalled
        ? { error: message, installation: error.command }
        : { error: message },
    );
    if (!(await isBlocked())) {
      await deps
        .comment(
          item.number,
          `${stoppedText(error, message)}\n\n${formatMarker({ run: runId, event: 'blocked' })}`,
        )
        .catch(() => undefined);
      await tracker.setBlocked(item).catch(() => undefined);
    }
    return { kind: 'blocked', reason: message };
  }
}

/** `factory run <issue>`: one run in the foreground. */
export async function startRun(
  config: FactoryConfig,
  args: readonly string[],
  log: (line: string) => void,
): Promise<number> {
  const number = Number(args[0]);
  if (!Number.isInteger(number) || number < 1) {
    log('Usage: factory run <issue> [--slot n]');
    return 2;
  }
  const slotId = args.includes('--slot')
    ? Number(args[args.indexOf('--slot') + 1])
    : (config.slots[0]?.id ?? 1);
  const slot = config.slots.find((s) => s.id === slotId);
  if (!slot) {
    log(`No slot ${slotId}.`);
    return 2;
  }
  const opened = await openFactory(config);
  if (!opened.ok) {
    log(`Can't run: ${opened.error}.`);
    return 2;
  }
  const board = await opened.factory.tracker.readBoard();
  const item = board.items.find((i) => i.number === number && i.repo === config.repo);
  if (!item) {
    log(`${issueKey(config, number)} isn't on the board.`);
    return 1;
  }
  const ok = runnable(config, item, [config.status.pick, config.status.planning]);
  if (!ok.ok) {
    log(`${ok.error}.`);
    return 1;
  }
  if (!ok.spec.planSkip && !planAgreed(config, number)) {
    log(
      `${issueKey(config, number)} needs a plan first: the daemon runs planning (factory:start), or label it ${config.planning.skipLabel}.`,
    );
    return 1;
  }
  const outcome = await executeRun(opened.factory, board, item, ok.spec, slot, log);
  log(
    outcome.kind === 'in-review'
      ? `In review: ${outcome.pr}`
      : outcome.kind === 'stopped'
        ? 'Stopped: Blocked was set.'
        : `Blocked: ${outcome.reason}`,
  );
  return outcome.kind === 'in-review' ? 0 : 1;
}
