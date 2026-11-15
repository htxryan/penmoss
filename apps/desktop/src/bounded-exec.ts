/**
 * One way for the main process to run a short-lived program with a time limit (A1480): never
 * through a shell, in a process group of its own, answered once it exits. A grandchild that holds
 * its pipes open (a credential helper, the daemons an interactive login shell starts) can't keep
 * the answer waiting: what the program wrote by the time it exited, plus DRAIN_MS, is the answer.
 * Out of time, the whole group is killed, not the program alone, and so is every group still
 * running when the app quits (`killBoundedGroups`, on `will-quit`).
 *
 * The CLI's `spawnExec` (packages/cli/src/token-store.ts) works the same way; git's own runs
 * have theirs (`@penmoss/git-notebook/system-git`), with a pid file across launches.
 */
import { spawn } from 'node:child_process';

/** How long to wait for the pipes to close after the program exits. */
export const DRAIN_MS = 100;

export interface BoundedExecOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  /** Written to stdin, which is then closed; absent, stdin is not opened. */
  readonly input?: string;
  readonly timeoutMs: number;
  /** Each chunk of stderr as it comes (then it isn't kept). */
  readonly onStderr?: (chunk: string) => void;
}

export type BoundedResult =
  | {
      readonly kind: 'exit';
      /** Null when a signal ended it. */
      readonly code: number | null;
      readonly stdout: string;
      readonly stderr: string;
    }
  | { readonly kind: 'timeout'; readonly stdout: string; readonly stderr: string }
  | { readonly kind: 'error'; readonly error: Error };

/** The process groups running now. */
const live = new Set<number>();

function killGroup(pid: number): void {
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // Already gone.
  }
}

/** Kills every group still running (the app is quitting). */
export function killBoundedGroups(): void {
  for (const pid of live) killGroup(pid);
  live.clear();
}

export function boundedExec(options: BoundedExecOptions): Promise<BoundedResult> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(options.command, [...options.args], {
        env: options.env ?? process.env,
        stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        detached: true,
        shell: false,
      });
    } catch (error) {
      resolve({ kind: 'error', error: error instanceof Error ? error : new Error(String(error)) });
      return;
    }
    const pid = child.pid;
    if (pid !== undefined) live.add(pid);
    let stdout = '';
    let stderr = '';
    let done = false;
    let drain: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: BoundedResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(drain);
      if (pid !== undefined) live.delete(pid);
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
      resolve(result);
    };
    const timer = setTimeout(() => {
      if (pid !== undefined) killGroup(pid);
      finish({ kind: 'timeout', stdout, stderr });
    }, options.timeoutMs);
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
      if (options.onStderr) options.onStderr(chunk);
      else stderr += chunk;
    });
    child.on('error', (error) => finish({ kind: 'error', error }));
    child.on('exit', (code) => {
      const result = (): BoundedResult => ({ kind: 'exit', code, stdout, stderr });
      child.on('close', () => finish(result()));
      drain = setTimeout(() => finish(result()), DRAIN_MS);
    });
    if (options.input !== undefined) {
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(options.input);
    }
  });
}
