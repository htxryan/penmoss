import { execFileSync } from 'node:child_process';
import { defineConfig, devices } from '@playwright/test';

/**
 * The Factory UI's page check (A1233): headless Chromium against a fake state folder, served by
 * the UI's own server on a free port. No daemon, no Linear, no window.
 *
 * Headless only on a Mac's own screen (W10, A1174), as in apps/web: a headed, UI or debug run
 * would open a browser on top of whatever Ryan is doing. Inside the test VM it may.
 */
function refuseWindowsOnMacHost(): void {
  if (process.platform !== 'darwin') return;
  const windowed =
    ['--headed', '--ui', '--debug'].some((flag) => process.argv.includes(flag)) ||
    Boolean(process.env['PWDEBUG']) ||
    process.env['HEADED'] === '1';
  if (!windowed) return;
  let vm: boolean;
  try {
    vm =
      execFileSync('sysctl', ['-n', 'kern.hv_vmm_present'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim() === '1';
  } catch {
    vm = false;
  }
  if (!vm)
    throw new Error(
      'A headed, UI or debug Playwright run opens windows, which on a Mac happens only in the test ' +
        'VM, never on this screen (W10). Run it headless; for a failure, open its trace ' +
        '(`pnpm exec playwright show-trace <trace.zip>`).',
    );
}
refuseWindowsOnMacHost();

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  outputDir: 'test-results/e2e',
  use: { headless: true, trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], headless: true } }],
});
