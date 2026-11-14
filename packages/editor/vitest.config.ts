import { defineConfig } from 'vitest/config';

// Wall-clock budgets (*.budget.test.ts) run alone, one file at a time, in `pnpm budgets`
// (`task budgets`), never in the unit run (A1244).
const budgets = process.env.PENMOSS_BUDGETS === '1';

export default defineConfig({
  test: {
    // A timeout is for a hang, not a slow machine: on this shared Mac (W12) a run starved of CPU,
    // as a throttled background job is, runs 10–30× slower than alone, well past vitest's 5 s
    // and 10 s. Wall-clock budgets live in *.budget.test.ts (A1244).
    testTimeout: 30_000,
    hookTimeout: 30_000,
    include: budgets ? ['test/**/*.budget.test.ts'] : ['test/**/*.test.ts'],
    exclude: budgets ? [] : ['test/**/*.budget.test.ts'],
    environment: 'happy-dom',
    setupFiles: ['test/support/intersection.ts'],
    // The agent worker has 4 CPUs shared with other agents (W5).
    maxWorkers: budgets ? 1 : 2,
  },
});
