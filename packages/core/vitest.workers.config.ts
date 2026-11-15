import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';
import { sharedTest } from '../../scripts/vitest-shared.mjs';

// Runs the core suite inside workerd (no DOM, no Node file system) to prove the
// schema and markdown codec work in a Worker or Durable Object (A9).
export default defineConfig({
  plugins: [
    cloudflareTest({
      // Same compatibility date as apps/relay/wrangler.jsonc.
      miniflare: { compatibilityDate: '2026-10-19' },
    }),
  ],
  test: {
    // Node-only tests, and the wall-clock budgets: those run in Node, in `pnpm budgets`
    // (A1244), since workerd freezes timers during synchronous work.
    ...sharedTest({
      include: ['test/**/*.test.ts'],
      exclude: ['test/**/*.node.test.ts'],
      env: false,
    }),
    fsModuleCache: false,
  },
});
