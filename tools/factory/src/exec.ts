/**
 * Running other programs (gh, git, claude). Everything that shells out takes
 * an `Exec`, so tests swap in a fake and never touch the network.
 */
import { spawn } from 'node:child_process';

export interface ExecOptions {
  readonly cwd?: string;
  /** Replaces the child's environment entirely when given. */
  readonly env?: Readonly<Record<string, string>>;
  readonly input?: string;
  /**
   * Aborting it stops the command and everything it started. With a signal the command runs in
   * a process group of its own, which gets SIGTERM (so its traps can clean up: the VM script
   * stops the VM), then SIGKILL `killGraceMs` later. The group is stopped the same way if this
   * process dies before the command ends, so a proof never outlives the daemon holding the VM.
   */
  readonly signal?: AbortSignal;
  /** How long a stopped command gets between SIGTERM and SIGKILL (default 30 s). */
  readonly killGraceMs?: number;
}

export interface ExecResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  /** The command was stopped through `signal`. */
  readonly aborted?: boolean;
}

export type Exec = (
  cmd: string,
  args: readonly string[],
  options?: ExecOptions,
) => Promise<ExecResult>;

export const KILL_GRACE_MS = 30_000;

/**
 * Stops the group `$1` if its reader goes away without saying "done": this process died (even by
 * SIGKILL), which closes the pipe. SIGTERM first, SIGKILL `$2` seconds later. No `--` before the
 * group: dash, Linux's /bin/sh, reads it as a pid and refuses ("Illegal number: -"), and both it
 * and bash take `-<pgid>` after a signal as the group.
 */
export const WATCHDOG =
  'read -r reply || { kill -TERM "-$1"; /bin/sleep "$2"; kill -KILL "-$1"; } 2>/dev/null';

function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // The group has gone.
  }
}

export const nodeExec: Exec = (cmd, args, options = {}) =>
  new Promise((resolve, reject) => {
    const { signal } = options;
    const grace = options.killGraceMs ?? KILL_GRACE_MS;
    const child = spawn(cmd, args, {
      cwd: options.cwd,
      env: options.env ? { ...options.env } : process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Its own process group, so a stop reaches everything it started.
      detached: signal !== undefined,
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let aborted = false;
    let escalate: ReturnType<typeof setTimeout> | undefined;
    let standDown: () => void = () => undefined;
    const onAbort = () => {
      if (aborted || child.pid === undefined) return;
      aborted = true;
      const pid = child.pid;
      killGroup(pid, 'SIGTERM');
      escalate = setTimeout(() => killGroup(pid, 'SIGKILL'), grace);
    };
    if (signal && child.pid !== undefined) {
      const pid = child.pid;
      const watchdog = spawn(
        '/bin/sh',
        ['-c', WATCHDOG, 'watchdog', String(pid), String(Math.ceil(grace / 1000))],
        { detached: true, stdio: ['pipe', 'ignore', 'ignore'] },
      );
      watchdog.on('error', () => undefined);
      watchdog.stdin.on('error', () => undefined);
      standDown = () => void watchdog.stdin.end('done\n');
      // Whatever the command left behind in its group goes when it ends. A stopped command's
      // leader can die first (lockf does on SIGTERM) while the rest cleans up, so that one is
      // only swept once every holder of its output has finished, or at the SIGKILL.
      child.on('exit', () => {
        if (!aborted) killGroup(pid, 'SIGKILL');
      });
      child.on('close', () => {
        if (aborted) killGroup(pid, 'SIGKILL');
      });
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => err.push(d));
    child.stdin.on('error', () => undefined);
    child.on('error', (error) => {
      standDown();
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(escalate);
      signal?.removeEventListener('abort', onAbort);
      standDown();
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        ...(aborted ? { aborted } : {}),
      });
    });
    child.stdin.end(options.input ?? '');
  });
