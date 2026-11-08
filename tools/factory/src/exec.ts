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
}

export interface ExecResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type Exec = (
  cmd: string,
  args: readonly string[],
  options?: ExecOptions,
) => Promise<ExecResult>;

export const nodeExec: Exec = (cmd, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: options.cwd,
      env: options.env ? { ...options.env } : process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => err.push(d));
    child.on('error', reject);
    child.on('close', (code) =>
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
      }),
    );
    child.stdin.end(options.input ?? '');
  });
