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

/** A process left in a worktree: its pid, lsof's command name and, read before it stops, its arguments. */
export interface Leftover {
  readonly pid: number;
  readonly command: string;
  /** What it was running, short (`vite preview`); see `shortArgs`. */
  readonly args?: string;
}

/**
 * The processes whose working folder is `dir` or under it, from `lsof -d cwd -Fpcn`'s output:
 * `p` starts a process, `c` is its command name, `n` its working folder.
 */
export function processesIn(lsof: string, dir: string, self: readonly number[]): Leftover[] {
  const found = new Map<number, Leftover>();
  let pid: number | undefined;
  let command = '';
  for (const line of lsof.split('\n')) {
    if (line.startsWith('p')) {
      pid = Number(line.slice(1));
      command = '';
    } else if (line.startsWith('c')) command = line.slice(1);
    else if (line.startsWith('n') && pid !== undefined) {
      const path = line.slice(1);
      if ((path === dir || path.startsWith(`${dir}/`)) && !self.includes(pid) && !found.has(pid))
        found.set(pid, { pid, command });
    }
  }
  return [...found.values()];
}

/** The pids whose working folder is `dir` or under it, from `lsof -d cwd -Fpn`'s output. */
export function inFolder(lsof: string, dir: string, self: readonly number[]): number[] {
  return processesIn(lsof, dir, self).map((p) => p.pid);
}

/**
 * A process's arguments as the log shows them: the program's own path dropped, each path cut to
 * its last part, and only the words before the first flag, at most three (`node
 * /w/node_modules/.bin/vite preview --port 20173` is `vite preview`). Flags and their values stay
 * out of the factory's log, since a command line can carry a token.
 */
export function shortArgs(args: string): string {
  const words = args.trim().split(/\s+/).filter(Boolean).slice(1);
  const out: string[] = [];
  for (const word of words) {
    if (word.startsWith('-') || out.length === 3) break;
    out.push(word.includes('/') ? (word.split('/').filter(Boolean).at(-1) ?? word) : word);
  }
  return out.join(' ').slice(0, 60);
}

/** `ps -o pid=,args=`'s output, by pid. */
export function argsByPid(ps: string): Map<number, string> {
  const out = new Map<number, string>();
  for (const line of ps.split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (match) out.set(Number(match[1]), match[2]!);
  }
  return out;
}

/**
 * The host's log line for what it stopped: `stopped 1 process left in the worktree when the
 * sandbox closed: 4123 node (vite preview)`.
 */
export function leftoversLine(stopped: readonly Leftover[], when: string): string {
  const each = stopped.map((p) => `${p.pid} ${p.command || '?'}${p.args ? ` (${p.args})` : ''}`);
  const n = stopped.length;
  return `stopped ${n} process${n === 1 ? '' : 'es'} left in the worktree ${when}: ${each.join(', ')}`;
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
 * Stops the processes left in `worktree`; returns what they were. `kill` sends a signal and says
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
): Promise<Leftover[]> {
  // lsof exits 1 when some process can't be read; its output still lists the rest.
  const listed = await exec('lsof', ['-w', '-d', 'cwd', '-Fpcn']);
  const self = deps.self ?? [process.pid, process.ppid];
  const byPid = new Map<number, Leftover>();
  for (const dir of new Set([worktree, real(worktree)]))
    for (const p of processesIn(listed.stdout, dir, self))
      if (!byPid.has(p.pid)) byPid.set(p.pid, p);
  const found = [...byPid.values()];
  if (found.length === 0) return [];
  // What each one runs, for the log, read before it stops; the log does without it if ps can't.
  const pids = found.map((p) => p.pid).join(',');
  const ps = await exec('ps', ['-o', 'pid=,args=', '-p', pids]).catch(() => undefined);
  const args = argsByPid(ps?.stdout ?? '');
  const described = found.map((p) => {
    const short = shortArgs(args.get(p.pid) ?? '');
    return short ? { ...p, args: short } : p;
  });
  for (const p of found) deps.kill(p.pid, 'SIGTERM');
  await deps.sleep(GRACE_MS);
  for (const p of found) if (deps.kill(p.pid, 0)) deps.kill(p.pid, 'SIGKILL');
  return described;
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
