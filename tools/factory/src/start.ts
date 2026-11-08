/** Starting one run: shared by `factory run <issue>` (foreground) and the daemon. */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { agentFor } from './agents/index.ts';
import type { Board, BoardItem } from './board.ts';
import { expandHome, type FactoryConfig, type SlotConfig } from './config.ts';
import { nodeExec } from './exec.ts';
import { createGh, type Gh } from './github.ts';
import { createAppTokens, loadAppCredentials, type AppTokens } from './github-app.ts';
import { loadProofStore, type ProofStore } from './proof/store.ts';
import { BlockedByRyan, guardEffects } from './guard.ts';
import { ensureClone, hostDeps, publisherEnv } from './host.ts';
import { issueText } from './issue.ts';
import { parseIssueSpec, type IssueSpec } from './labels.ts';
import { formatMarker } from './pick.ts';
import { advancePlanning, type PlanDeps } from './plan-run.ts';
import {
  agreedPlanPath,
  findSession,
  launchSession,
  planFiles,
  planText,
  prepareSnapshot,
  readMeta,
  stopSession,
} from './planning-host.ts';
import type { PlanningAction } from './planning.ts';
import { fill, promptTemplate } from './prompt.ts';
import { branchName, runImplement, type RunOutcome } from './run.ts';
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

/** The GitHub App, the env file and the tracker, checked. */
export async function openFactory(
  config: FactoryConfig,
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
  await ensureClone(config, nodeExec, identity);
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
  const { config, tracker, secrets } = factory;
  await ensureClone(config, nodeExec);
  const files = planFiles(config, item.number);
  const issue = await tracker.readIssue(item.number);
  const env: Record<string, string> = {
    PATH: process.env['PATH'] ?? '/usr/bin:/bin',
    HOME: process.env['HOME'] ?? '',
    ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
    ...(secrets.CLAUDE_CODE_OAUTH_TOKEN
      ? { CLAUDE_CODE_OAUTH_TOKEN: secrets.CLAUDE_CODE_OAUTH_TOKEN }
      : {}),
  };
  const deps: PlanDeps = {
    comment: (n, body) => tracker.comment(n, body),
    setStatus: (i, status) => tracker.setStatus(i, status),
    setBlocked: (i) => tracker.setBlocked(i),
    snapshot: () => prepareSnapshot(config, files, nodeExec),
    launch: async (message, resume) => {
      const { chatUrl } = await launchSession(
        config,
        nodeExec,
        files,
        item.number,
        message,
        env,
        resume,
      );
      const found = await findSession(config, nodeExec, item.number, env);
      if (!found)
        throw new Error('the planning session started but `claude agents` does not list it');
      log(`planning session ${found.sessionId}${resume ? ' resumed' : ' started'}`);
      return { sessionId: found.sessionId, ...(chatUrl ? { chatUrl } : {}) };
    },
    stop: (id) => stopSession(config, nodeExec, id, env),
    session: async () => {
      const found = await findSession(config, nodeExec, item.number, env);
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
    issue: issueText(issue, tracker.owner, 'penmoss-factory'),
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

/** One implementation run on a slot, with every side effect guarded by the card's Blocked field. */
export async function executeRun(
  factory: Factory,
  board: Board,
  item: BoardItem,
  spec: IssueSpec,
  slot: SlotConfig,
  log: (line: string) => void,
): Promise<RunOutcome | { kind: 'stopped' }> {
  const { config, gh, tracker } = factory;
  const runId = `${item.number}-${Date.now().toString(36)}-${randomBytes(2).toString('hex')}`;
  await ensureClone(config, nodeExec);
  const issue = await tracker.readIssue(item.number);
  const prompt = fill(promptTemplate('implement'), {
    branch: branchName(config, item),
    issue: issueText(issue, tracker.owner, 'penmoss-factory'),
    plan: planFor(config, item.number, spec),
    scope: spec.platforms
      ? `The issue is labelled for ${spec.platforms.join(', ')}. Prove the change there.`
      : 'The path classifier decides the platforms from your diff: shared code means web, Mac and Android.',
  });
  const agent = await agentFor(config, spec);
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
    log,
  });
  const isBlocked = () => tracker.isBlocked(item.number);
  const guarded = guardEffects(
    deps,
    ['comment', 'setStatus', 'setBlocked', 'push', 'openPr', 'runAgent'],
    item.number,
    isBlocked,
  );
  try {
    const artifacts = spec.planSkip ? [] : agreedArtifacts(config, item.number);
    const plan = agreedPlanText(config, item.number, spec);
    return await runImplement(guarded, {
      item,
      spec,
      prompt,
      ...(artifacts.length ? { artifacts } : {}),
      ...(plan ? { plan } : {}),
    });
  } catch (error) {
    if (error instanceof BlockedByRyan) {
      deps.log('failed', { stopped: 'Blocked set by Ryan' });
      return { kind: 'stopped' };
    }
    // Anything unexpected: say so on the issue and set Blocked, so the card is never left stuck.
    const message = error instanceof Error ? error.message : String(error);
    deps.log('failed', { error: message });
    if (!(await isBlocked())) {
      await deps
        .comment(
          item.number,
          `The run stopped on an error: ${message}\n\n${formatMarker({ run: runId, event: 'blocked' })}`,
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
