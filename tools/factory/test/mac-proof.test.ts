/**
 * The Mac proof's host side (F7, F10) against a fake `exec`: the check it asks the VM script
 * before a proof, why it says the VM can't take one, a boot that fails as a wait, and the proof
 * run stoppable at its timeout.
 */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ownCheckout } from '../src/code.ts';
import type { Exec, ExecOptions } from '../src/exec.ts';
import {
  checkMacVm,
  MAC_KILL_GRACE_MS,
  runMacProof,
  VmUnavailable,
  vmReason,
} from '../src/proof/mac.ts';
import { testConfig } from './helpers.ts';

const config = testConfig();
// The factory's own copy of the VM script, never the worktree's, which the agent can edit.
const script = join(ownCheckout(), 'scripts/vm/desktop-test.sh');

function fakeExec(result: { code: number; stdout?: string; stderr?: string; aborted?: boolean }) {
  const calls: { cmd: string; args: readonly string[]; options: ExecOptions | undefined }[] = [];
  const exec: Exec = (cmd, args, options) => {
    calls.push({ cmd, args, options });
    return Promise.resolve({ stdout: '', stderr: '', ...result });
  };
  return { exec, calls };
}

describe('checkMacVm', () => {
  it("asks the factory's VM script whether a run can start now, for the configured VM", async () => {
    const f = fakeExec({ code: 0, stdout: '[vm] penmoss-test is ready\n' });
    expect(await checkMacVm(f.exec, config, '/wt/2')).toEqual({ ok: true });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.cmd).toBe('sh');
    expect(f.calls[0]?.args).toEqual([script, '--check']);
    expect(f.calls[0]?.options?.cwd).toBe(ownCheckout());
    expect(f.calls[0]?.options?.env?.['PENMOSS_VM']).toBe('penmoss-test');
    expect(f.calls[0]?.options?.env?.['PENMOSS_VM_ROOT']).toBe('/wt/2');
    // Only a proof records.
    expect(f.calls[0]?.options?.env?.['PENMOSS_PROOF']).toBeUndefined();
  });

  it("says why the VM can't take a proof, from the script's own words", async () => {
    const f = fakeExec({ code: 75, stderr: '[vm] penmoss-test is busy with another run\n' });
    expect(await checkMacVm(f.exec, config, '/wt/2')).toEqual({
      ok: false,
      reason: 'penmoss-test is busy with another run',
    });
  });
});

describe('vmReason', () => {
  it('takes the last [vm] line, else the last line, else the exit code', () => {
    expect(
      vmReason({
        code: 75,
        stdout: '[vm] booting penmoss-test\n',
        stderr:
          '[vm] penmoss-test did not answer in 3 minutes; see /w/test-results/vm/tart-run.log\nError: the VM failed to start\n',
      }),
    ).toBe('penmoss-test did not answer in 3 minutes; see /w/test-results/vm/tart-run.log');
    expect(
      vmReason({ code: 75, stdout: '', stderr: 'tart is not installed: see docs/ci.md\n' }),
    ).toBe('tart is not installed: see docs/ci.md');
    expect(vmReason({ code: 75, stdout: '', stderr: '' })).toBe('the VM script exited 75');
  });
});

describe('runMacProof', () => {
  it('runs the specs in the VM with recording on, stoppable through the signal', async () => {
    const f = fakeExec({ code: 1 });
    const controller = new AbortController();
    await runMacProof(f.exec, config, '/wt/2', ['test/e2e/a.spec.ts'], controller.signal);
    const call = f.calls[0];
    expect(call?.args).toEqual([script, 'test/e2e/a.spec.ts']);
    expect(call?.options?.cwd).toBe(ownCheckout());
    expect(call?.options?.env).toMatchObject({
      PENMOSS_PROOF: '1',
      PENMOSS_VM: 'penmoss-test',
      PENMOSS_VM_ROOT: '/wt/2',
    });
    // The stop reaches the script's whole group, with time for it to stop the VM.
    expect(call?.options?.signal).toBe(controller.signal);
    expect(call?.options?.killGraceMs).toBe(MAC_KILL_GRACE_MS);
  });

  it("throws VmUnavailable when the VM couldn't take the run (exit 75)", async () => {
    const f = fakeExec({
      code: 75,
      stderr: '[vm] penmoss-test did not answer in 3 minutes; see tart-run.log\n',
    });
    const run = runMacProof(f.exec, config, '/wt/2', ['a.spec.ts']);
    await expect(run).rejects.toBeInstanceOf(VmUnavailable);
    await expect(run).rejects.toThrow('penmoss-test did not answer in 3 minutes');
  });

  it("leaves failing tests and a run stopped at its timeout to the report's verdict", async () => {
    await expect(
      runMacProof(fakeExec({ code: 1 }).exec, config, '/wt/2', ['a.spec.ts']),
    ).resolves.toBeUndefined();
    await expect(
      runMacProof(fakeExec({ code: 75, aborted: true }).exec, config, '/wt/2', ['a.spec.ts']),
    ).resolves.toBeUndefined();
  });
});
