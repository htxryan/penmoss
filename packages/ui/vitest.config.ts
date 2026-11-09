import { defineConfig } from 'vitest/config';

// Wall-clock budgets (*.budget.test.ts) run alone, one file at a time, in `pnpm budgets`
// (`task budgets`), never in the unit run (A1244).
const budgets = process.env.PENMOSS_BUDGETS === '1';

export default defineConfig({
  test: {
    include: budgets ? ['test/**/*.budget.test.{ts,tsx}'] : ['test/**/*.test.{ts,tsx}'],
    exclude: budgets ? [] : ['test/**/*.budget.test.{ts,tsx}'],
    maxWorkers: budgets ? 1 : 2,
  },
});
