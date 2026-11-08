import { execFileSync } from 'node:child_process';
import { defineConfig, devices } from '@playwright/test';

import { webE2ePort, webPreviewPort } from '../../packages/core/test/support/checkout-ports';

/**
 * The web suite runs the page as the Mac app's (T59, D48, D49): Vite serves it, and each test
 * gives it a stand-in `window.penmossDesktop` whose git notebooks are real ones over system git
 * and `file://` remotes (test/e2e/fixtures.ts). No server.
 *
 * Each checkout has its own ports, from a hash of its path (A1177), so worktrees run side by
 * side; `PENMOSS_E2E_PORT` and `PENMOSS_E2E_PREVIEW_PORT` pick others (test/e2e/fixtures.ts reads
 * them too).
 */
/**
 * Headless only on a Mac's own screen (W10, A1174): a headed, UI or debug run opens browser windows
 * on top of whatever Ryan is doing. Inside the test VM (`kern.hv_vmm_present` is 1) or on Linux they
 * may open.
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
        'VM, never on this screen (W10, docs/ci.md §8). Run it headless (`task e2e`); for a look at ' +
        'a failure, open its trace (`pnpm exec playwright show-trace <trace.zip>`).',
    );
  }
}
refuseWindowsOnMacHost();

const port = webE2ePort();
const baseURL = `http://localhost:${port}`;
/** A production build served by `vite preview`: the CSP specs and the performance budgets. */
const previewPort = webPreviewPort();
const isCI = Boolean(process.env['CI']);
/**
 * Proof mode (`task proof:web`, the software factory's F5): every test is recorded on video
 * with a final screenshot, one at a time, and a JSON report maps each test to its files.
 */
const proof = process.env['PENMOSS_PROOF'] === '1';
/**
 * Several tests at once (A1139): every test has its own git repositories in a temp folder
 * (test/e2e/support/git-host.ts) and its own browser context, so they share nothing but the
 * dev server. Four, here and on CI's runners: several sessions' suites share this Mac (A1175),
 * and half its cores each made timing tests fail under load. `PENMOSS_E2E_WORKERS` picks another
 * number.
 */
const workers = Number(process.env['PENMOSS_E2E_WORKERS']) || 4;
/** The specs that time things: alone, after the rest, so other tests' load never skews them. */
const timed = /@perf|@budget/;
// Reusing a server already on the port is opt-in: several worktrees share these
// ports, and a silent reuse tests whichever checkout started it.
const reuse = process.env['PW_REUSE_SERVERS'] === '1';

export default defineConfig({
  testDir: './test/e2e',
  // Its own per port: two runs in one checkout keep each other's results.
  outputDir: proof ? `test-results/proof-${port}` : `test-results/e2e-${port}`,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  workers: proof ? 1 : workers,
  // Tests, not only files, spread over the workers: a long file no longer sets the run's length.
  fullyParallel: true,
  reporter: proof
    ? [['list'], ['json', { outputFile: `test-results/proof-${port}/report.json` }]]
    : isCI
      ? [['github'], ['html', { open: 'never' }]]
      : 'list',
  use: proof
    ? { baseURL, trace: 'off', video: 'on', screenshot: 'on' }
    : { baseURL, trace: 'on-first-retry' },
  projects: [
    { name: 'chromium', grepInvert: timed, use: { ...devices['Desktop Chrome'] } },
    {
      name: 'timed',
      grep: timed,
      // One at a time; `task e2e` runs this project after the other, never beside it.
      workers: 1,
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: [
    {
      command: `pnpm exec vite --port ${port} --strictPort`,
      url: baseURL,
      reuseExistingServer: reuse,
    },
    {
      command: `pnpm exec vite build --outDir dist/e2e-${previewPort} --emptyOutDir --logLevel warn && pnpm exec vite preview --outDir dist/e2e-${previewPort} --port ${previewPort} --strictPort`,
      url: `http://localhost:${previewPort}`,
      reuseExistingServer: reuse,
      timeout: 180_000,
    },
  ],
});
