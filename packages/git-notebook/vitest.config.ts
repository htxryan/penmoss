import { defineConfig } from 'vitest/config';

// Wall-clock budgets (*.budget.test.ts) run alone, one file at a time, in `pnpm budgets`
// (`task budgets`), never in the unit run (A1244).
const budgets = process.env.PENMOSS_BUDGETS === '1';

// Node: the engine over the in-memory transport, and system git against local bare repos
// (isolated from the machine's git config, #147's CI risk).
export default defineConfig({
  test: {
    include: budgets ? ['test/**/*.budget.test.ts'] : ['test/**/*.test.ts'],
    exclude: budgets ? [] : ['test/**/*.budget.test.ts'],
    maxWorkers: budgets ? 1 : 2,
    // Real git on a shared Mac (W12): a timeout is for a hang, as in the other packages.
    testTimeout: 60_000,
    hookTimeout: 30_000,
  },
});
