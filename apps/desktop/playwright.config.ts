import { defineConfig } from '@playwright/test';
import { refuseOnMacHost } from './test/e2e/host-guard';

// Every run of this suite loads this file first, however it is started.
refuseOnMacHost('The Mac app’s Playwright suite');

import { desktopFakeGitHubPort } from '../../packages/core/test/support/checkout-ports';

const isCI = Boolean(process.env.CI);
/** Proof mode (`task proof:mac`, the software factory's F7): a JSON report the factory reads. */
const proof = process.env.PENMOSS_PROOF === '1';
// Reusing a server already on the port is opt-in: several worktrees share it (see apps/web).
const reuse = process.env.PW_REUSE_SERVERS === '1';
// This checkout's own port (A1177), so another worktree's run can't hold it.
const fakeGitHubPort = desktopFakeGitHubPort();

/**
 * The Mac app's Playwright suite (T29, T30, T59): Electron itself (`_electron`), run under xvfb on
 * Linux (`task desktop:test`). There is no Penmoss server: notes live in git notebooks on bare
 * repositories on this machine (support.ts). Needs `task desktop:build` first (the Taskfile does
 * it).
 */
export default defineConfig({
  testDir: './test/e2e',
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  workers: 1,
  timeout: 90_000,
  ...(proof ? { outputDir: 'test-results/proof' } : {}),
  reporter: proof
    ? [['list'], ['json', { outputFile: 'test-results/proof/report.json' }]]
    : isCI
      ? [['github'], ['html', { open: 'never' }]]
      : 'list',
  use: { trace: 'retain-on-failure' },
  webServer: [
    {
      // A fake GitHub for Send feedback (T49, T57): main files issues and uploads screenshots
      // there with the person's token (PENMOSS_TEST_GITHUB_API); a spec reads what it got from
      // /__fake/issues.
      command: `node test/e2e/fake-github.ts ${fakeGitHubPort} fake-local-token`,
      url: `http://127.0.0.1:${fakeGitHubPort}/__fake/calls`,
      reuseExistingServer: reuse,
      timeout: 30_000,
    },
  ],
});
