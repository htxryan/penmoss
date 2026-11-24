import { defineConfig, devices } from '@playwright/test';

import { sitePort } from '../scripts/checkout-ports.mjs';

/**
 * The built site under `wrangler dev`, with the real `_headers` (T80.15): run by `task site:test`,
 * which builds it first. The port is this checkout's (A1177), so worktrees run it side by side, or
 * the port block's `site` (scripts/ports.mjs), or `PENMOSS_SITE_PORT`.
 */
const port = sitePort();
const isCI = Boolean(process.env['CI']);

export default defineConfig({
  testDir: './test',
  // Recorded through apps/web's config (`task proof:web`), which builds and serves the site itself.
  testIgnore: 'proof/**',
  outputDir: `test-results/site-${port}`,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  reporter: isCI ? [['github'], ['list']] : 'list',
  use: { baseURL: `http://localhost:${port}`, trace: 'on-first-retry' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `pnpm exec wrangler dev --local --port ${port} --ip 127.0.0.1`,
    url: `http://localhost:${port}/`,
    reuseExistingServer: process.env['PW_REUSE_SERVERS'] === '1',
    timeout: 60_000,
  },
});
