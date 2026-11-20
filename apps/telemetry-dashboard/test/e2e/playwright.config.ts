import { execFileSync } from 'node:child_process';
import { defineConfig, devices } from '@playwright/test';
import { ports } from '../../../../scripts/ports.mjs';

/**
 * The usage dashboard in headless Chromium (PEN-137): `task dashboard:e2e`. The spec starts the
 * dashboard itself, in Miniflare on the port block's dashboard port (test/e2e/server.ts), so no
 * web server is configured here.
 *
 * Headless only on a Mac's own screen (W10, A1174), as apps/web's config: a headed, UI or debug
 * run opens windows, which happens only in the test VM.
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
  if (!vm) {
    throw new Error(
      'A headed, UI or debug Playwright run opens windows, which on a Mac happens only in the test ' +
        'VM, never on this screen (W10, docs/ci.md §8). Run it headless (`task dashboard:e2e`).',
    );
  }
}
refuseWindowsOnMacHost();

const port = ports().dashboard;
const isCI = Boolean(process.env['CI']);
/** Proof mode (the software factory's F5): video and a final screenshot, a JSON report. */
const proof = process.env['PENMOSS_PROOF'] === '1';

export default defineConfig({
  testDir: '.',
  outputDir: `../../test-results/${proof ? 'proof' : 'e2e'}-${port}`,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  // One dashboard on one port: the tests share it, one at a time.
  workers: 1,
  reporter: proof
    ? [['list'], ['json', { outputFile: `../../test-results/proof-${port}/report.json` }]]
    : isCI
      ? [['github'], ['list']]
      : 'list',
  use: proof ? { trace: 'off', video: 'on', screenshot: 'on' } : { trace: 'on-first-retry' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
