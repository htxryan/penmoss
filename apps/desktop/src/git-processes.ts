/**
 * No git outlives the Mac app (T50 G3 #151, G0's finding; A853). Each git a git notebook runs is
 * its own process group (so it can never prompt), which also means quitting or crashing the app
 * would leave it running. So:
 *
 * - quitting (`will-quit`) and SIGINT, SIGTERM and SIGHUP kill every live group (`killLiveGit`);
 * - every live group is kept in `git-processes.json` as it starts, so a run that crashed (no
 *   handler ran) has its leftovers killed at the next launch. A pid is killed only if it still
 *   leads its own group, is git, and started when the one recorded did (`ps`), so a pid the
 *   system gave to something else, even another git, is spared.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { GitProcessListener } from '@penmoss/git-notebook/system-git';

/**
 * What `ps` says about a pid: its process group, when it started (ms since the epoch, to the
 * second) and its command, or null when it is gone.
 */
export type ProcessProbe = (
  pid: number,
) => { readonly pgid: number; readonly command: string; readonly started: number } | null;

export const probeProcess: ProcessProbe = (pid) => {
  // lstart is the same 24 characters on macOS and Linux in the C locale: "Thu Oct 29 13:54:28 2026".
  const result = spawnSync('ps', ['-o', 'pgid=,lstart=,comm=', '-p', String(pid)], {
    encoding: 'utf8',
    timeout: 5_000,
    env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
  });
  if (result.status !== 0) return null;
  const match = /^\s*(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d+:\d+:\d+\s+\d{4})\s+(.+?)\s*$/m.exec(
    result.stdout,
  );
  const started = match ? Date.parse(match[2]!.replace(/\s+/g, ' ')) : NaN;
  return match && Number.isFinite(started)
    ? { pgid: Number(match[1]), command: match[3]!, started }
    : null;
};

/** How far ps's start time may be from the time kept when git started (ps shows seconds). */
const START_SLACK_MS = 3_000;

/** A live git as the file keeps it: its pid, and when it started. */
interface Recorded {
  readonly pid: number;
  readonly at: number;
}

/** Whether `command` (ps's `comm`) is git or one of its helpers (`git-remote-https`, ssh). */
export function isGitCommand(command: string): boolean {
  const name = command.split('/').pop() ?? '';
  return /^git(-[a-z-]+)?$/.test(name) || name === 'ssh';
}

export class GitProcessFile implements GitProcessListener {
  private readonly live = new Map<number, number>();

  constructor(
    private readonly path: string,
    private readonly options: {
      readonly probe?: ProcessProbe;
      readonly kill?: (pid: number) => void;
      readonly log?: (message: string) => void;
    } = {},
  ) {}

  /** The gits a previous run left in the file; one with no start time is never killed. */
  private recorded(): Recorded[] {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.path, 'utf8'));
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(
        (entry): entry is Recorded =>
          typeof entry === 'object' &&
          entry !== null &&
          Number.isSafeInteger((entry as Recorded).pid) &&
          (entry as Recorded).pid > 1 &&
          Number.isFinite((entry as Recorded).at),
      );
    } catch {
      return [];
    }
  }

  private write(): void {
    try {
      const temporary = `${this.path}.tmp`;
      const entries = [...this.live].map(([pid, at]) => ({ pid, at }));
      writeFileSync(temporary, JSON.stringify(entries), { mode: 0o600 });
      renameSync(temporary, this.path);
    } catch (error) {
      this.options.log?.(`could not keep git's pids: ${String(error)}`);
    }
  }

  /** At launch: kills what a crashed run left behind, then starts an empty file. Returns them. */
  cleanUp(): number[] {
    const probe = this.options.probe ?? probeProcess;
    const kill =
      this.options.kill ??
      ((pid: number) => {
        process.kill(-pid, 'SIGKILL');
      });
    const killed: number[] = [];
    for (const { pid, at } of this.recorded()) {
      const found = probe(pid);
      // Gone, or the pid now belongs to something else (another program, or a later git): leave it.
      if (
        !found ||
        found.pgid !== pid ||
        !isGitCommand(found.command) ||
        Math.abs(found.started - at) > START_SLACK_MS
      ) {
        continue;
      }
      try {
        kill(pid);
        killed.push(pid);
      } catch {
        // Ended meanwhile.
      }
    }
    if (killed.length > 0) this.options.log?.(`killed ${killed.length} git left by the last run`);
    this.live.clear();
    this.write();
    return killed;
  }

  started(pid: number): void {
    this.live.set(pid, Date.now());
    this.write();
  }

  ended(pid: number): void {
    if (this.live.delete(pid)) this.write();
  }
}
