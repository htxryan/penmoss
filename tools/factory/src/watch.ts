/**
 * What the daemon does for each In review card (F11, F18): find the factory's PR for it, read
 * what Ryan has said, then start a review round in a free slot, rebase a PR main has moved past
 * (F6), repair a red check, or merge on approval. Blocked cards are never looked at (R23).
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { agentFor, remoteAgentFor } from './agents/index.ts';
import { postChat } from './chat.ts';
import type { Board, BoardItem } from './board.ts';
import { summarizeChecks, type CheckRun } from './checks.ts';
import { expandHome, type FactoryConfig, type SlotConfig } from './config.ts';
import { scopeText } from './platforms.ts';
import { nodeExec } from './exec.ts';
import { BlockedByRyan, guardEffects, RUN_GUARDED, RUN_STEPS } from './guard.ts';
import { appendLedger, hostDeps } from './host.ts';
import { fence } from './issue.ts';
import type { IssueSpec } from './labels.ts';
import { ciRunsFor, mergeApproved, type MainRun, type MergeDeps, type RunJob } from './merge.ts';
import { fill, promptTemplate } from './prompt.ts';
import { proofFiles } from './proof/body.ts';
import { publishRefs } from './proof/store.ts';
import { readConversation, reviewState, roundText, type ReviewState } from './review.ts';
import { runRebase, runRevise, type ReviseDeps } from './revise.ts';
import { branchName, failedLogs } from './run.ts';
import { issueForAgent, planFor, runImages, type Factory } from './start.ts';

export interface FactoryPr {
  readonly number: number;
  readonly url: string;
  readonly state: 'OPEN' | 'MERGED' | 'CLOSED';
  /** GitHub's MERGEABLE, CONFLICTING or UNKNOWN (still being worked out). */
  readonly mergeable?: string;
  /** DIRTY (conflicts), BEHIND (main must be merged in first), CLEAN, BLOCKED… */
  readonly mergeStateStatus?: string;
}

/** Whether main has moved past the PR so it can't merge as it is: it needs a rebase (F6). */
export function mainMovedPast(pr: FactoryPr): boolean {
  return (
    pr.mergeable === 'CONFLICTING' ||
    pr.mergeStateStatus === 'DIRTY' ||
    pr.mergeStateStatus === 'BEHIND'
  );
}

export async function findPr(factory: Factory, item: BoardItem): Promise<FactoryPr | undefined> {
  const prs = await factory.gh.json<FactoryPr[]>([
    'pr',
    'list',
    '--repo',
    factory.config.repo,
    '--head',
    branchName(factory.config, item),
    '--state',
    'all',
    '--json',
    'number,url,state,mergeable,mergeStateStatus',
  ]);
  return prs[0];
}

export type ReviewAction =
  | { readonly kind: 'none'; readonly reason: string }
  | { readonly kind: 'round'; readonly state: Extract<ReviewState, { kind: 'round' }> }
  | { readonly kind: 'rebase' }
  | { readonly kind: 'repair'; readonly failed: readonly CheckRun[] }
  | { readonly kind: 'merge' };

/** The next thing to do for an In review card's PR. */
export async function nextReviewAction(
  factory: Factory,
  pr: FactoryPr,
  now: Date,
): Promise<ReviewAction> {
  // Merged while the daemon was away (it stopped while main's CI ran, or Ryan merged it):
  // verify main and finish the card, so it never stays In review (R12, R20).
  if (pr.state === 'MERGED') return { kind: 'merge' };
  if (pr.state !== 'OPEN') return { kind: 'none', reason: `the PR is ${pr.state.toLowerCase()}` };
  const { config, gh } = factory;
  const conversation = await readConversation(
    gh,
    config.repo,
    pr.number,
    'penmoss-factory',
    config.publisher.login,
  );
  const state = reviewState(
    conversation,
    config.owner,
    config.publisher.login,
    now,
    config.review.commentQuietMinutes,
  );
  if (state.kind === 'round') return { kind: 'round', state };
  // Before checks or a merge: a PR that conflicts with main gets no new CI and can't merge.
  if (mainMovedPast(pr)) return { kind: 'rebase' };
  const checks = await gh
    .json<CheckRun[]>([
      'pr',
      'checks',
      pr.url,
      '--repo',
      config.repo,
      '--json',
      'name,state,bucket,link,startedAt',
    ])
    .catch(() => []);
  const ci = summarizeChecks(checks, now, config.timeouts.ciMinutes, new Date(0));
  if (ci.kind === 'red') return { kind: 'repair', failed: ci.failed };
  if (state.kind === 'approved')
    return ci.kind === 'green'
      ? { kind: 'merge' }
      : { kind: 'none', reason: `approved; CI is ${ci.kind}` };
  return { kind: 'none', reason: state.reason };
}

/**
 * The build prompt a review, rebase or CI round starts from: the issue, the agreed plan and the
 * scope, as the run's own. It had no plan, so `fill` refused it and no round could start.
 */
export function roundPrompt(
  config: FactoryConfig,
  item: BoardItem,
  spec: IssueSpec,
  issue: string,
): string {
  let plan: string;
  try {
    plan = planFor(config, item.number, spec);
  } catch {
    // The plan's copy is gone (a tracker change archives it): the round still has the issue.
    plan = 'None kept: the issue below is the spec.';
  }
  return fill(promptTemplate('implement'), {
    branch: branchName(config, item),
    issue,
    plan,
    scope: scopeText(spec.platforms),
  });
}

/** A review round, a rebase or a CI repair on a slot, guarded by the card's Blocked field. */
export async function executeRevise(
  factory: Factory,
  board: Board,
  item: BoardItem,
  spec: IssueSpec,
  slot: SlotConfig,
  pr: FactoryPr,
  action: Extract<ReviewAction, { kind: 'round' | 'rebase' | 'repair' }>,
  log: (line: string) => void,
  /** What the round waits for, for the daemon's status.json (F10). */
  waitingFor?: (reason: string | null) => void,
): Promise<string> {
  const { config, gh, tracker } = factory;
  const runId = `${item.number}-${Date.now().toString(36)}-${randomBytes(2).toString('hex')}`;
  const { text } = await issueForAgent(
    tracker,
    await tracker.readIssue(item.number),
    runImages(config, runId),
  );
  const base = roundPrompt(config, item, spec, text);
  const items = action.kind === 'round' ? action.state.items : [];
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
  const prompt =
    action.kind === 'round'
      ? `${base}\n\n## Ryan's review of ${pr.url}\n\nThe PR is open and in review. Address every item below in the same branch, then write \`.factory/result.json\` with a \`replies\` object: for each review thread ID, one or two sentences saying what you changed (or why not), and under \`general\` your answer to the PR comments and review summaries, which goes on the PR in the round's comment. You can't edit the PR yourself.\n\n${roundText(items, fence)}`
      : action.kind === 'rebase'
        ? base
        : ciRepairText(base, pr.url, action.failed, await failedLogs(deps, action.failed));
  const dir = join(expandHome(config.stateDir), 'runs', runId, 'proof');
  const revise: ReviseDeps = {
    ...deps,
    prComment: async (url, body, proof = []) => {
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `comment-${Date.now()}.md`);
      const refs = proof
        .map((p) => [p.label, p.image, p.video] as const)
        .flatMap(([label, image, video]) => [
          ...(image ? [`![${label.replaceAll(/[[\]\n]/g, ' ')}](./${image})`] : []),
          ...(video ? [`[▶ Watch the recording (MP4)](./${video})`] : []),
        ]);
      const text = refs.length ? `${body}\n\n${refs.join('\n\n')}` : body;
      writeFileSync(
        file,
        await publishRefs(text, dir, proofFiles(proof), factory.proof, `runs/${runId}`),
      );
      await gh.run(['pr', 'comment', url, '--repo', config.repo, '--body-file', file]);
    },
    replyToThread: async (threadId, body) => {
      await gh.graphql(
        'mutation($thread: ID!, $body: String!) { addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $thread, body: $body }) { comment { id } } }',
        { thread: threadId, body },
      );
    },
  };
  const isBlocked = () => tracker.isBlocked(item.number);
  // A run's steps, and the round's PR replies: Blocked stops it at the next one (R23).
  const guarded = guardEffects(
    revise,
    [...RUN_GUARDED, 'prComment', 'replyToThread'],
    item.number,
    isBlocked,
    { ...RUN_STEPS, prComment: 'a PR comment', replyToThread: 'a reply on the PR' },
  );
  try {
    const input = { item, spec, pr: pr.url, branch: branchName(config, item), items, prompt };
    const outcome =
      action.kind === 'rebase' ? await runRebase(guarded, input) : await runRevise(guarded, input);
    return outcome.kind;
  } catch (error) {
    if (error instanceof BlockedByRyan) {
      deps.log('failed', { stopped: `Blocked set by Ryan: stopped before ${error.step}` });
      return 'stopped';
    }
    const message = error instanceof Error ? error.message : String(error);
    if (!(await isBlocked())) {
      await deps
        .comment(item.number, `A review round stopped on an error: ${message}`)
        .catch(() => undefined);
      await tracker.setBlocked(item).catch(() => undefined);
    }
    return `blocked: ${message}`;
  }
}

/** A repair round in review (F11): the failed checks and their last log lines (A1278). */
export function ciRepairText(
  base: string,
  pr: string,
  failed: readonly CheckRun[],
  logs: readonly string[],
): string {
  return `${base}\n\n## CI failed on ${pr}\n\nThe PR is in review and these checks failed: ${failed.map((c) => `${c.name} (${c.link})`).join(', ')}. Their last log lines:\n\n${logs.join('\n\n')}\n\nFix the cause (never by weakening or skipping tests), commit, and write \`.factory/result.json\`.`;
}

/** Merge an approved PR and see main through (F18). Needs no slot: it only waits on GitHub. */
/**
 * The merge's events (`resumed`, `merged`, `done`) in the run ledger as well as the daemon log,
 * the same shape as a run's, under the merge's own run id and with the card: the report counts
 * `merged`, and `unfinishedClaims` closes a claim on `merged` or `done` (a run that failed after
 * In Review left its claim open, PEN-75).
 */
export function mergeLog(
  config: FactoryConfig,
  runId: string,
  issue: number,
  log: (line: string) => void,
): MergeDeps['log'] {
  return (event, detail = {}) => {
    appendLedger(config, { run: runId, issue, event, ...detail });
    log(`${event} ${JSON.stringify(detail)}`);
  };
}

export async function executeMerge(
  factory: Factory,
  item: BoardItem,
  pr: FactoryPr,
  log: (line: string) => void,
): Promise<string> {
  const { config, gh, tracker } = factory;
  const runId = `${item.number}-merge-${Date.now().toString(36)}`;
  const deps: MergeDeps = {
    config,
    runId,
    checks: (url) =>
      gh
        .json<CheckRun[]>([
          'pr',
          'checks',
          url,
          '--repo',
          config.repo,
          '--json',
          'name,state,bucket,link,startedAt',
        ])
        .catch(() => []),
    mergedSha: async (url) => {
      const view = await gh.json<{ state: string; mergeCommit: { oid: string } | null }>([
        ...['pr', 'view', url, '--repo', config.repo, '--json', 'state,mergeCommit'],
      ]);
      return view.state === 'MERGED' && view.mergeCommit?.oid ? view.mergeCommit.oid : undefined;
    },
    mainRunsCi: async (url, sha) => {
      try {
        const { files } = await gh.json<{ files: { path: string }[] }>([
          ...['pr', 'view', url, '--repo', config.repo, '--json', 'files'],
        ]);
        // gh lists at most 100 files: a longer list may hide code, so CI is assumed to run.
        if (files.length >= 100) return true;
        const ci = await gh.run([
          ...['api', `repos/${config.repo}/contents/.github/workflows/ci.yml?ref=${sha}`],
          ...['-H', 'Accept: application/vnd.github.raw'],
        ]);
        return ciRunsFor(
          ci,
          files.map((f) => f.path),
        );
      } catch {
        return true;
      }
    },
    runJobs: async (run) => {
      if (!run.databaseId) return Promise.reject(new Error('no run id'));
      const { jobs } = await gh.json<{ jobs: RunJob[] }>([
        ...['run', 'view', String(run.databaseId), '--repo', config.repo, '--json', 'jobs'],
      ]);
      return jobs;
    },
    rerun: async (run) => {
      if (run.databaseId)
        await gh.run(['run', 'rerun', String(run.databaseId), '--repo', config.repo]);
    },
    merge: async (url) => {
      await gh.run(['pr', 'merge', url, '--repo', config.repo, '--squash', '--delete-branch']);
      const view = await gh.json<{ mergeCommit: { oid: string } | null }>([
        'pr',
        'view',
        url,
        '--repo',
        config.repo,
        '--json',
        'mergeCommit',
      ]);
      return view.mergeCommit?.oid ?? '';
    },
    mainRuns: (sha) =>
      gh.json<MainRun[]>([
        'run',
        'list',
        '--repo',
        config.repo,
        '--branch',
        'main',
        '--commit',
        sha,
        '--json',
        'status,conclusion,url,databaseId',
      ]),
    comment: (n, body) => tracker.comment(n, body),
    closeIssue: (n, body) => tracker.closeIssue(n, body),
    setStatus: (i, s) => tracker.setStatus(i, s),
    setBlocked: (i) => tracker.setBlocked(i),
    notify: async (title, message) => {
      await nodeExec('osascript', [
        '-e',
        `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`,
      ]);
    },
    sleep: (s) => new Promise((resolve) => setTimeout(resolve, s * 1000)),
    now: () => new Date(),
    log: mergeLog(config, runId, item.number, log),
  };
  const isBlocked = () => tracker.isBlocked(item.number);
  const guarded = guardEffects(
    deps,
    ['merge', 'comment', 'closeIssue', 'setStatus', 'setBlocked'],
    item.number,
    isBlocked,
    {
      merge: 'the merge',
      comment: 'a comment on the card',
      closeIssue: 'closing the card',
      setStatus: 'moving the card',
      setBlocked: 'setting Blocked',
    },
  );
  try {
    return (await mergeApproved(guarded, item, pr.url)).kind;
  } catch (error) {
    if (error instanceof BlockedByRyan) {
      log(`Blocked set by Ryan: stopped before ${error.step}`);
      return 'stopped';
    }
    throw error;
  }
}
