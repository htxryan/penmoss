import { defineConfig } from '@playwright/test';

import { checkoutPortBase } from '../../packages/core/test/support/checkout-ports';

/**
 * penmoss.app's screenshots (T80.9, A1210), run by `node scripts/screenshots.mjs` (`task
 * site:screenshots`): the web app under Vite, as the Mac app's page through the web suite's
 * stand-in for the Mac (apps/web/test/e2e/fixtures.ts), in headless Chromium only (W10). A
 * window of 1440×900 at 2x, in Chicago's time zone and US English, so every run draws the same
 * pixels. The port is this checkout's (A1177), past the web suite's own, or
 * `PENMOSS_SCREENSHOTS_PORT`.
 */
const port = Number(process.env['PENMOSS_SCREENSHOTS_PORT']) || checkoutPortBase() + 5;

export default defineConfig({
  testDir: '.',
  testMatch: 'screenshots.spec.ts',
  outputDir: `../test-results/screenshots-${port}`,
  // One test, one browser: the shots are taken in order on one stand-in Mac.
  workers: 1,
  retries: 0,
  timeout: 300_000,
  reporter: 'list',
  use: {
    baseURL: `http://localhost:${port}`,
    headless: true,
    browserName: 'chromium',
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    locale: 'en-US',
    timezoneId: 'America/Chicago',
    reducedMotion: 'reduce',
  },
  // Each scheme on a stand-in Mac and a browser profile of its own, so light and dark show the
  // same app in the same state.
  projects: [
    { name: 'light', use: { colorScheme: 'light' } },
    { name: 'dark', use: { colorScheme: 'dark' } },
  ],
  webServer: {
    command: `pnpm exec vite --port ${port} --strictPort`,
    cwd: '../../apps/web',
    url: `http://localhost:${port}`,
    reuseExistingServer: false,
  },
});
