import { defineConfig } from 'vitest/config';

// Wall-clock budgets (*.budget.test.ts) run alone, one file at a time, in `pnpm budgets`
// (`task budgets`), never in the unit run (A1244).
const budgets = process.env.PENMOSS_BUDGETS === '1';

export default defineConfig({
  test: {
    include: budgets ? ['test/**/*.budget.test.ts'] : ['test/**/*.test.ts'],
    exclude: budgets ? [] : ['test/**/*.budget.test.ts'],
    environment: 'happy-dom',
    setupFiles: ['test/support/intersection.ts'],
    // The agent worker has 4 CPUs shared with other agents (W5).
    maxWorkers: budgets ? 1 : 2,
  },
});
