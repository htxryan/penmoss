/**
 * The janitor (F13, #272): what finished or crashed runs leave behind. Sandcastle's worktrees in
 * the factory's clone (a crash skips `close()`), and run folders (logs, recordings) past their
 * keep. It never touches a worktree of a run that is in progress, or anything in Ryan's own
 * checkouts.
 */
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expandHome, type FactoryConfig } from './config.ts';
import type { Exec } from './exec.ts';
import { repoDir } from './host.ts';

/** Run folders are kept this long: the PR has its own copies of the proof. */
export const KEEP_RUN_DAYS = 14;
/** A worktree untouched this long, of no running issue, is an orphan. */
export const ORPHAN_HOURS = 12;

export interface Worktree {
  readonly path: string;
  readonly branch: string | null;
}

export function parseWorktrees(porcelain: string): Worktree[] {
  return porcelain
    .split('\n\n')
    .map((block) => {
      const path = /^worktree (.+)$/m.exec(block)?.[1];
      const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1] ?? null;
      return path ? { path, branch } : null;
    })
    .filter((w): w is Worktree => w !== null);
}

/** The issue a factory branch (`factory/<n>-slug`) or doctor branch belongs to, if any. */
export function issueOfBranch(branch: string | null, prefix: string): number | null {
  if (!branch?.startsWith(prefix)) return null;
  const n = Number(/^(\d+)-/.exec(branch.slice(prefix.length))?.[1]);
  return Number.isInteger(n) ? n : null;
}

/** The sandbox worktrees to remove: Sandcastle's, old, and of no issue that is running now. */
export function orphanWorktrees(
  worktrees: readonly Worktree[],
  clone: string,
  prefix: string,
  running: ReadonlySet<number>,
  ageHours: (path: string) => number,
): Worktree[] {
  return worktrees.filter((w) => {
    if (!w.path.startsWith(join(clone, '.sandcastle', 'worktrees'))) return false;
    const issue = issueOfBranch(w.branch, prefix);
    if (issue !== null && running.has(issue)) return false;
    return ageHours(w.path) >= ORPHAN_HOURS;
  });
}

export async function sweep(
  config: FactoryConfig,
  exec: Exec,
  running: ReadonlySet<number>,
  log: (line: string) => void,
  now: Date = new Date(),
): Promise<void> {
  const clone = repoDir(config);
  const hours = (path: string) => {
    try {
      return (now.getTime() - statSync(path).mtimeMs) / 3600_000;
    } catch {
      return Infinity;
    }
  };
  const listed = await exec('git', ['-C', clone, 'worktree', 'list', '--porcelain']);
  if (listed.code === 0) {
    for (const w of orphanWorktrees(
      parseWorktrees(listed.stdout),
      clone,
      config.branchPrefix,
      running,
      hours,
    )) {
      const removed = await exec('git', ['-C', clone, 'worktree', 'remove', '--force', w.path]);
      log(
        removed.code === 0
          ? `janitor: removed the worktree ${w.path}`
          : `janitor: couldn't remove ${w.path}: ${removed.stderr.trim()}`,
      );
    }
    await exec('git', ['-C', clone, 'worktree', 'prune']);
  }
  const runs = join(expandHome(config.stateDir), 'runs');
  if (!existsSync(runs)) return;
  const names = readdirSync(runs);
  for (const name of names) {
    const issue = Number(name.split('-')[0]);
    if (running.has(issue)) continue;
    const path = join(runs, name);
    if (hours(path) >= KEEP_RUN_DAYS * 24) {
      rmSync(path, { recursive: true, force: true });
      log(`janitor: removed the run folder ${name}`);
    }
  }
}
