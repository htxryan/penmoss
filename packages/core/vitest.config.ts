import { defineConfig } from 'vitest/config';

// Wall-clock budgets (*.budget.test.ts) run alone, one file at a time, in `pnpm budgets`
// (`task budgets`), never in the unit run (A1244).
const budgets = process.env.PENMOSS_BUDGETS === '1';

export default defineConfig({
  test: {
    include: budgets ? ['test/**/*.budget.test.ts'] : ['test/**/*.test.ts'],
    exclude: ['test/**/*.workers.test.ts', ...(budgets ? [] : ['test/**/*.budget.test.ts'])],
    maxWorkers: budgets ? 1 : 2,
    // The fixture corpus is bundled with import.meta.glob; the on-disk module
    // cache would keep serving the old file list after a fixture is added.
    fsModuleCache: false,
  },
});
