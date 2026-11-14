import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

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
    // A timeout is for a hang, not a slow machine: on this shared Mac (W12) a run starved of CPU,
    // as a throttled background job is, runs 10–30× slower than alone, well past vitest's 5 s
    // and 10 s. Wall-clock budgets live in *.budget.test.ts (A1244).
    testTimeout: 30_000,
    hookTimeout: 30_000,
    include: ['test/**/*.test.ts'],
    // Node-only tests, and the wall-clock budgets: those run in Node, in `pnpm budgets`
    // (A1244), since workerd freezes timers during synchronous work.
    exclude: ['test/**/*.node.test.ts', 'test/**/*.budget.test.ts'],
    maxWorkers: 2,
    fsModuleCache: false,
  },
});
