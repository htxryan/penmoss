/**
 * Merge on approval (F18, #273): when Ryan approves and CI is green, the factory squash-merges,
 * watches main's CI for the merge commit, then closes the issue and moves the card to Done. A
 * red main sets Blocked with the failing jobs; the card keeps its status. Production deploys
 * happen in main's own workflow after merge (FD24), never from a branch.
 */
import type { BoardItem } from './board.ts';
import type { FactoryConfig } from './config.ts';
import { summarizeChecks, type CheckRun } from './checks.ts';
import { formatMarker } from './pick.ts';

export interface MainRun {
  /** queued, in_progress or completed. */
  readonly status: string;
  /** success, failure, cancelled, skipped, or null while running. */
  readonly conclusion: string | null;
  readonly url: string;
}

export interface MergeDeps {
  readonly config: FactoryConfig;
  readonly runId: string;
  checks(pr: string): Promise<CheckRun[]>;
  merge(pr: string): Promise<string>;
  /** main's workflow runs for a commit (none yet right after a merge). */
  mainRuns(sha: string): Promise<MainRun[]>;
  comment(issue: number, body: string): Promise<void>;
  closeIssue(issue: number, comment: string): Promise<void>;
  setStatus(item: BoardItem, status: string): Promise<void>;
  setBlocked(item: BoardItem): Promise<void>;
  notify(title: string, message: string): Promise<void>;
  sleep(seconds: number): Promise<void>;
  now(): Date;
  log(event: string, detail?: Record<string, unknown>): void;
}

export type MergeOutcome =
  | { readonly kind: 'done'; readonly sha: string }
  | { readonly kind: 'not-yet'; readonly reason: string }
  | { readonly kind: 'blocked'; readonly reason: string };

export async function mergeApproved(
  deps: MergeDeps,
  item: BoardItem,
  pr: string,
): Promise<MergeOutcome> {
  const marker = (event: string) => formatMarker({ run: deps.runId, phase: 'merge', event });
  const summary = summarizeChecks(
    await deps.checks(pr),
    deps.now(),
    deps.config.timeouts.ciMinutes,
    deps.now(),
  );
  if (summary.kind !== 'green')
    return { kind: 'not-yet', reason: `approved, but CI is ${summary.kind}` };

  const sha = await deps.merge(pr);
  deps.log('merged', { pr, sha });
  await deps.comment(
    item.number,
    `Merged ${pr} as ${sha.slice(0, 10)}. Watching main's CI.\n\n${marker('merged')}`,
  );

  const started = deps.now();
  for (;;) {
    await deps.sleep(deps.config.pollSeconds);
    const runs = await deps.mainRuns(sha);
    const minutes = (deps.now().getTime() - started.getTime()) / 60_000;
    if (runs.length === 0 && minutes < deps.config.timeouts.ciMinutes) continue;
    if (runs.some((r) => r.status !== 'completed')) continue;
    const failed = runs.filter((r) => r.conclusion !== 'success' && r.conclusion !== 'skipped');
    if (runs.length === 0 || failed.length > 0) {
      const why =
        runs.length === 0
          ? `no CI run started on main for ${sha.slice(0, 10)} within ${deps.config.timeouts.ciMinutes} min`
          : `main's CI failed after the merge: ${failed.map((r) => r.url).join(', ')}`;
      await deps.comment(
        item.number,
        `${why}. Nothing more happens until you look.\n\n${marker('blocked')}`,
      );
      await deps.setBlocked(item);
      return { kind: 'blocked', reason: why };
    }
    // Verified: the PR said `Part of`, so the factory closes the issue itself (R20).
    await deps.closeIssue(
      item.number,
      `main is green with ${sha.slice(0, 10)} (${runs.map((r) => r.url).join(', ')}). Done.\n\n${marker('done')}`,
    );
    await deps.setStatus(item, deps.config.status.done);
    await deps.notify(
      `Penmoss ${item.key} is done`,
      `Merged and verified on main (${sha.slice(0, 10)}).`,
    );
    deps.log('done', { sha });
    return { kind: 'done', sha };
  }
}
