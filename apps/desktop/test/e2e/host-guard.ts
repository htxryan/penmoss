import { execFileSync } from 'node:child_process';

/**
 * True inside a virtual machine: macOS sets `kern.hv_vmm_present` to 1 in a guest (the Tart VM,
 * docs/ci.md §8) and 0 on real hardware. Read from the kernel, so no environment variable can
 * claim it.
 */
export function inVirtualMachine(): boolean {
  try {
    return (
      execFileSync('sysctl', ['-n', 'kern.hv_vmm_present'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim() === '1'
    );
  } catch {
    return false;
  }
}

/**
 * The Mac app's suite opens real windows, and on a Mac those take over Ryan's screen. So on a Mac
 * it runs only in the test VM (W10, A1174): `task desktop:test` sends it there. Linux (xvfb, CI)
 * has no screen to take over and runs it anywhere.
 */
export function refuseOnMacHost(what: string): void {
  if (process.platform !== 'darwin' || inVirtualMachine()) return;
  throw new Error(
    `${what} opens windows, so on a Mac it runs only in the test VM, never on this screen ` +
      '(W10, docs/ci.md §8). Run `task desktop:test` (it runs in the VM) or ' +
      '`task desktop:test:vm`, with Playwright arguments after `--`.',
  );
}
