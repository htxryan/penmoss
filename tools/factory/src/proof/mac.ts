/**
 * The Mac proof's host side (F7, F10): the test VM (Tart, `scripts/vm/desktop-test.sh`), which
 * only the host can start (W10). Before a Mac proof the host asks the VM script whether a run
 * can start now (`--check`: tart installed, the VM made, no other run on it, no VM started some
 * other way); the script says no, and a run that couldn't boot the VM ends, with exit 75. The
 * run then waits and asks again (run.ts), rather than failing or using a round.
 */
import { join } from 'node:path';
import { ownCheckout } from '../code.ts';
import type { FactoryConfig } from '../config.ts';
import type { Exec, ExecResult } from '../exec.ts';

/** The VM script's exit for "the VM can't take a run now" (EX_TEMPFAIL). */
export const VM_TEMPFAIL = 75;

/**
 * How long a stopped Mac proof gets to clean up: the script's trap stops the VM (`tart stop`
 * waits up to 30 s for macOS to shut down) before the SIGKILL.
 */
export const MAC_KILL_GRACE_MS = 60_000;

/** The Mac proof couldn't start: the VM can't be used now. A reason to wait, not a failure. */
export class VmUnavailable extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'VmUnavailable';
  }
}

export type VmCheck = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/**
 * The VM script the host runs: the factory's own (its code checkout, A1226), never the run's
 * worktree's, which the agent can edit (A1230). The worktree is only what it copies into the VM.
 */
export function vmScript(checkout: string = ownCheckout()): string {
  return join(checkout, 'scripts', 'vm', 'desktop-test.sh');
}

/**
 * The script's environment: nothing of the run's sandbox, the configured VM, and the worktree to
 * test (`PENMOSS_VM_ROOT`).
 */
export function vmEnv(
  config: FactoryConfig,
  worktree: string,
  proof = false,
): Record<string, string> {
  return {
    PATH: process.env['PATH'] ?? '/usr/bin:/bin',
    HOME: process.env['HOME'] ?? '',
    PENMOSS_VM: config.macProof.vm,
    PENMOSS_VM_ROOT: worktree,
    ...(proof ? { PENMOSS_PROOF: '1' } : {}),
  };
}

/** Why the script said no: its last `[vm]` line, else its last line (its errors first). */
export function vmReason(result: ExecResult): string {
  const lines = (result.stderr.trim() ? result.stderr : result.stdout)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const said = lines.filter((l) => l.startsWith('[vm] ')).at(-1);
  return (said ?? lines.at(-1) ?? `the VM script exited ${result.code}`).replace(/^\[vm\] /, '');
}

/** Whether the test VM can take a Mac proof now. */
export async function checkMacVm(
  exec: Exec,
  config: FactoryConfig,
  worktree: string,
): Promise<VmCheck> {
  const result = await exec('sh', [vmScript(), '--check'], {
    cwd: ownCheckout(),
    env: vmEnv(config, worktree),
  });
  return result.code === 0 ? { ok: true } : { ok: false, reason: vmReason(result) };
}

/**
 * Runs the proof specs in the test VM, with every window recorded; the outputs land in the
 * worktree's `test-results/vm`. Throws `VmUnavailable` when the VM couldn't take the run. When
 * `signal` aborts (the proof timeout), the script and everything it started get SIGTERM, so it
 * stops the VM and frees the VM's lock for the next run, then SIGKILL.
 */
export async function runMacProof(
  exec: Exec,
  config: FactoryConfig,
  worktree: string,
  specs: readonly string[],
  signal?: AbortSignal,
): Promise<void> {
  const result = await exec('sh', [vmScript(), ...specs], {
    cwd: ownCheckout(),
    env: vmEnv(config, worktree, true),
    ...(signal ? { signal, killGraceMs: MAC_KILL_GRACE_MS } : {}),
  });
  // Its exit code is otherwise not the verdict: the report says which tests passed.
  if (result.code === VM_TEMPFAIL && !result.aborted) throw new VmUnavailable(vmReason(result));
}

/**
 * Runs validation's Mac walkthrough (PEN-94) in the test VM, without recording: its screenshots
 * come back under the worktree's `test-results/vm`. Throws `VmUnavailable` as a proof does, and
 * stops the same way at the timeout. Its exit code says whether the walkthrough passed.
 */
export async function runMacWalk(
  exec: Exec,
  config: FactoryConfig,
  worktree: string,
  spec: string,
  signal?: AbortSignal,
): Promise<ExecResult> {
  const result = await exec('sh', [vmScript(), spec], {
    cwd: ownCheckout(),
    env: vmEnv(config, worktree),
    ...(signal ? { signal, killGraceMs: MAC_KILL_GRACE_MS } : {}),
  });
  if (result.code === VM_TEMPFAIL && !result.aborted) throw new VmUnavailable(vmReason(result));
  return result;
}
