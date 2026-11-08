/**
 * Merge on approval (F18, #273): when Ryan approves and CI is green, the factory squash-merges,
 * watches main's CI for the merge commit, then closes the issue and moves the card to Done. A
 * red main sets Blocked with the failing jobs; the card keeps its status. Production deploys
 * happen in main's own workflow after merge (FD24), never from a branch.
 *
 * A PR that is already merged (the daemon stopped while main's CI ran, R12) is picked up where
 * it was: main is verified for its merge commit without merging again. A change main runs no CI
 * for (docs, the site, Markdown: ci.yml's push paths, A1095) is Done once it is merged.
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
  /** The run's ID, to name its failed jobs. */
  readonly databaseId?: number;
}

export interface MergeDeps {
  readonly config: FactoryConfig;
  readonly runId: string;
  checks(pr: string): Promise<CheckRun[]>;
  /** The PR's merge commit when it is already merged, else undefined. */
  mergedSha(pr: string): Promise<string | undefined>;
  merge(pr: string): Promise<string>;
  /** main's workflow runs for a commit (none yet right after a merge). */
  mainRuns(sha: string): Promise<MainRun[]>;
  /** Whether main's CI runs at all for the merge commit (ci.yml's push paths, A1095). */
  mainRunsCi(pr: string, sha: string): Promise<boolean>;
  /** The names of a run's failed jobs. */
  failedJobs(run: MainRun): Promise<string[]>;
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
  let sha = await deps.mergedSha(pr);
  if (sha) {
    deps.log('resumed', { pr, sha });
    await deps.comment(
      item.number,
      `${pr} is merged as ${sha.slice(0, 10)}. Watching main's CI.\n\n${marker('resumed')}`,
    );
  } else {
    const summary = summarizeChecks(
      await deps.checks(pr),
      deps.now(),
      deps.config.timeouts.ciMinutes,
      deps.now(),
    );
    if (summary.kind !== 'green')
      return { kind: 'not-yet', reason: `approved, but CI is ${summary.kind}` };

    sha = await deps.merge(pr);
    deps.log('merged', { pr, sha });
    await deps.comment(
      item.number,
      `Merged ${pr} as ${sha.slice(0, 10)}. Watching main's CI.\n\n${marker('merged')}`,
    );
  }
  const merged = sha;

  const done = async (how: string): Promise<MergeOutcome> => {
    // Verified: the PR said `Part of`, so the factory closes the issue itself (R20).
    await deps.closeIssue(item.number, `${how}. Done.\n\n${marker('done')}`);
    await deps.setStatus(item, deps.config.status.done);
    await deps.notify(
      `Penmoss ${item.key} is done`,
      `Merged and verified on main (${merged.slice(0, 10)}).`,
    );
    deps.log('done', { sha: merged });
    return { kind: 'done', sha: merged };
  };

  const started = deps.now();
  let runsCi: boolean | undefined;
  for (;;) {
    await deps.sleep(deps.config.pollSeconds);
    const runs = await deps.mainRuns(merged);
    const minutes = (deps.now().getTime() - started.getTime()) / 60_000;
    if (runs.length === 0) {
      // GitHub starts a push's runs within seconds, so one poll is enough to tell.
      runsCi ??= await deps.mainRunsCi(pr, merged);
      if (!runsCi)
        return done(
          `main has ${merged.slice(0, 10)}, and main runs no CI for a change like this (A1095)`,
        );
      if (minutes < deps.config.timeouts.ciMinutes) continue;
    }
    if (runs.some((r) => r.status !== 'completed')) continue;
    const failed = runs.filter((r) => r.conclusion !== 'success' && r.conclusion !== 'skipped');
    if (runs.length === 0 || failed.length > 0) {
      const named = await Promise.all(
        failed.map(async (r) => {
          const jobs = await deps.failedJobs(r).catch((): string[] => []);
          return jobs.length ? `${r.url} (${jobs.join(', ')})` : r.url;
        }),
      );
      const why =
        runs.length === 0
          ? `no CI run started on main for ${merged.slice(0, 10)} within ${deps.config.timeouts.ciMinutes} min`
          : `main's CI failed after the merge: ${named.join(', ')}`;
      await deps.comment(
        item.number,
        `${why}. Nothing more happens until you look.\n\n${marker('blocked')}`,
      );
      await deps.setBlocked(item);
      return { kind: 'blocked', reason: why };
    }
    return done(`main is green with ${merged.slice(0, 10)} (${runs.map((r) => r.url).join(', ')})`);
  }
}

/** A GitHub path filter as a regular expression (`*` stays in a folder, `**` crosses them). */
function globRegExp(glob: string): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') {
        out += '(?:.*/)?';
        i += 2;
      } else {
        out += '.*';
        i += 1;
      }
    } else if (c === '*') out += '[^/]*';
    else out += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

/**
 * Whether a push of these files to main runs ci.yml, from its `on.push.paths` (later patterns
 * win, `!` excludes). With no paths found, or no files, it assumes CI runs, so the factory
 * waits for main's run rather than calling a change Done unverified.
 */
export function ciRunsFor(ciYaml: string, files: readonly string[]): boolean {
  const lines = ciYaml.split('\n');
  const push = lines.findIndex((l) => /^ {2}push:\s*$/.test(l));
  const patterns: { negated: boolean; re: RegExp }[] = [];
  if (push >= 0) {
    let i = push + 1;
    // Find `paths:` among push's own keys; a line indented less than them ends the search.
    while (i < lines.length && !/^ {4}paths:\s*$/.test(lines[i]!)) {
      if (/^ {0,3}\S/.test(lines[i]!)) break;
      i++;
    }
    if (i < lines.length && /^ {4}paths:\s*$/.test(lines[i]!))
      for (i++; i < lines.length; i++) {
        const line = lines[i]!;
        if (/^\s*(#.*)?$/.test(line)) continue;
        const m = /^ {6}- +(['"]?)(.+?)\1\s*(#.*)?$/.exec(line);
        if (!m) break;
        const glob = m[2]!;
        patterns.push({ negated: glob.startsWith('!'), re: globRegExp(glob.replace(/^!/, '')) });
      }
  }
  if (patterns.length === 0 || files.length === 0) return true;
  return files.some((file) => {
    let included = false;
    for (const p of patterns) if (p.re.test(file)) included = !p.negated;
    return included;
  });
}
