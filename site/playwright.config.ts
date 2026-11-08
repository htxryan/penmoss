import { defineConfig, devices } from '@playwright/test';

/**
 * The built site under `wrangler dev`, with the real `_headers` (T80.15): run by `task site:test`,
 * which builds it first. `PENMOSS_SITE_PORT` picks another port when several worktrees run it.
 */
const port = Number(process.env['PENMOSS_SITE_PORT'] ?? 8788);
const isCI = Boolean(process.env['CI']);

export default defineConfig({
  testDir: './test',
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
