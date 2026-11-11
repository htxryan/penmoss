/**
 * Processes an agent session left running in its worktree (A1297). A command an agent starts
 * in the background, a dev server or a test run, outlives the session: launchd adopts it once
 * the session's process exits, and it keeps the run's ports. PEN-71's CI repair round ended
 * with its E2E run still going, and its Vite servers held ports 20173 and 20174 for the next
 * round, whose specs couldn't start.
 *
 * So when a sandbox closes, and before one opens, the host stops every process whose working
 * folder is in the sandbox's worktree: SIGTERM, then SIGKILL for what is left after a grace.
 * The host never runs in a worktree itself, and a run's steps on one worktree come one after
 * another, so whatever is there is a leftover.
 */
import { realpathSync } from 'node:fs';
import type { Exec } from './exec.ts';

/** The pids whose working folder is `dir` or under it, from `lsof -d cwd -Fpn`'s output. */
export function inFolder(lsof: string, dir: string, self: readonly number[]): number[] {
  const pids: number[] = [];
  let pid: number | undefined;
  for (const line of lsof.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && pid !== undefined) {
      const path = line.slice(1);
      if ((path === dir || path.startsWith(`${dir}/`)) && !self.includes(pid)) pids.push(pid);
    }
  }
  return [...new Set(pids)];
}

const real = (dir: string) => {
  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
};

/** How long a process gets after SIGTERM before SIGKILL. */
export const GRACE_MS = 3000;

/**
 * Stops the processes left in `worktree`; returns their pids. `kill` sends a signal and says
 * whether the process was still there (process.kill, which throws once it is gone).
 */
export async function stopLeftovers(
  exec: Exec,
  worktree: string,
  deps: {
    readonly kill: (pid: number, signal: NodeJS.Signals | 0) => boolean;
    readonly sleep: (ms: number) => Promise<void>;
    readonly self?: readonly number[];
  },
): Promise<number[]> {
  // lsof exits 1 when some process can't be read; its output still lists the rest.
  const listed = await exec('lsof', ['-w', '-d', 'cwd', '-Fpn']);
  const self = deps.self ?? [process.pid, process.ppid];
  const pids = [...new Set([worktree, real(worktree)])].flatMap((dir) =>
    inFolder(listed.stdout, dir, self),
  );
  const found = [...new Set(pids)];
  if (found.length === 0) return [];
  for (const pid of found) deps.kill(pid, 'SIGTERM');
  await deps.sleep(GRACE_MS);
  for (const pid of found) if (deps.kill(pid, 0)) deps.kill(pid, 'SIGKILL');
  return found;
}

/** process.kill, as `stopLeftovers` wants it: false once the process is gone. */
export function signal(pid: number, sig: NodeJS.Signals | 0): boolean {
  try {
    process.kill(pid, sig);
    return true;
  } catch {
    return false;
  }
}
