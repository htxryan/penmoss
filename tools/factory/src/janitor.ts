/**
 * The janitor (F13, #272): what finished or crashed runs leave behind. Sandcastle's worktrees in
 * the factory's clone (a crash skips `close()`), and run folders (logs, recordings) past their
 * keep. It never touches a worktree of a run that is in progress, or anything in Ryan's own
 * checkouts.
 *
 * It runs no git (A-NEW-1). `git worktree list` reads paths from the clone's
 * `.git/worktrees/*\/gitdir`, which any sandbox can write, so a path it names could be anywhere
 * (Ryan's checkout), and `git worktree remove` would delete it. The janitor lists the factory's
 * own worktrees folder instead, deletes only real folders directly in it, and then drops the
 * clone's records of worktrees that are gone, as `git worktree prune` does.
 */
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { expandHome, type FactoryConfig } from './config.ts';
import type { Exec } from './exec.ts';
import { repoDir } from './host.ts';

/** Run folders are kept this long: the PR has its own copies of the proof. */
export const KEEP_RUN_DAYS = 14;
/** A worktree untouched this long, of no running issue, is an orphan. */
export const ORPHAN_HOURS = 12;

export interface Worktree {
  /** Its folder's name in the worktrees folder: Sandcastle's, the branch with `-` for `/`. */
  readonly name: string;
  readonly path: string;
}

/** Where Sandcastle makes the runs' worktrees: the only place the janitor deletes one. */
export function worktreesFolder(config: FactoryConfig): string {
  return join(repoDir(config), '.sandcastle', 'worktrees');
}

/** The issue a factory branch (`factory/<n>-slug`) or doctor branch belongs to, if any. */
export function issueOfBranch(branch: string | null, prefix: string): number | null {
  if (!branch?.startsWith(prefix)) return null;
  const n = Number(/^(\d+)-/.exec(branch.slice(prefix.length))?.[1]);
  return Number.isInteger(n) ? n : null;
}

/** The issue of a worktree, from its folder's name (Sandcastle's: the branch, `/` as `-`). */
export function issueOfWorktree(name: string, prefix: string): number | null {
  return issueOfBranch(name, prefix.replaceAll('/', '-'));
}

const inside = (path: string, folder: string) => {
  const rel = relative(folder, path);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) && !rel.includes('/');
};

/** The folders directly in the worktrees folder: real folders only, never a link. */
export function factoryWorktrees(folder: string): Worktree[] {
  let real: string;
  try {
    if (!lstatSync(folder).isDirectory()) return [];
    real = realpathSync(folder);
  } catch {
    return [];
  }
  return readdirSync(folder)
    .map((name) => ({ name, path: join(folder, name) }))
    .filter((w) => {
      try {
        return lstatSync(w.path).isDirectory() && inside(realpathSync(w.path), real);
      } catch {
        return false;
      }
    });
}

/** The sandbox worktrees to remove: old, and of no issue that is running now. */
export function orphanWorktrees(
  worktrees: readonly Worktree[],
  prefix: string,
  running: ReadonlySet<number>,
  ageHours: (path: string) => number,
): Worktree[] {
  return worktrees.filter((w) => {
    const issue = issueOfWorktree(w.name, prefix);
    if (issue !== null && running.has(issue)) return false;
    return ageHours(w.path) >= ORPHAN_HOURS;
  });
}

/**
 * Drops the clone's records (`.git/worktrees/<id>`) of worktrees whose folder is gone, unless
 * locked, as `git worktree prune` does: only those record folders are deleted, never the path a
 * record names.
 */
export function pruneWorktreeRecords(clone: string): string[] {
  const records = join(clone, '.git', 'worktrees');
  try {
    if (!lstatSync(join(clone, '.git')).isDirectory() || !lstatSync(records).isDirectory())
      return [];
  } catch {
    return [];
  }
  const pruned: string[] = [];
  for (const id of readdirSync(records)) {
    const record = join(records, id);
    try {
      if (!lstatSync(record).isDirectory() || existsSync(join(record, 'locked'))) continue;
      const gitdir = readFileSync(join(record, 'gitdir'), 'utf8').trim();
      if (gitdir !== '' && existsSync(gitdir)) continue;
    } catch {
      // No gitdir file: a record git would prune too.
    }
    rmSync(record, { recursive: true, force: true });
    pruned.push(id);
  }
  return pruned;
}

/**
 * One sweep; a failure rejects. `_exec` is not used: the janitor runs nothing, so a caller's
 * `exec`, whatever its `git worktree list` would say, can't change what it deletes.
 */
export function sweep(
  config: FactoryConfig,
  _exec: Exec,
  running: ReadonlySet<number>,
  log: (line: string) => void,
  now: Date = new Date(),
): Promise<void> {
  return Promise.resolve().then(() => sweepNow(config, running, log, now));
}

function sweepNow(
  config: FactoryConfig,
  running: ReadonlySet<number>,
  log: (line: string) => void,
  now: Date,
): void {
  const hours = (path: string) => {
    try {
      return (now.getTime() - statSync(path).mtimeMs) / 3600_000;
    } catch {
      return Infinity;
    }
  };
  for (const w of orphanWorktrees(
    factoryWorktrees(worktreesFolder(config)),
    config.branchPrefix,
    running,
    hours,
  )) {
    try {
      rmSync(w.path, { recursive: true, force: true });
      log(`janitor: removed the worktree ${w.path}`);
    } catch (error) {
      log(
        `janitor: couldn't remove ${w.path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  pruneWorktreeRecords(repoDir(config));
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
