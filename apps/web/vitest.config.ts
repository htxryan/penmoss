import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Wall-clock budgets (*.budget.test.ts) run alone, one file at a time, in `pnpm budgets`
// (`task budgets`), never in the unit run (A1244).
const budgets = process.env.PENMOSS_BUDGETS === '1';

export default defineConfig({
  plugins: [react()],
  test: {
    // Playwright specs live in test/e2e and run through `task e2e`.
    include: budgets ? ['test/unit/**/*.budget.test.{ts,tsx}'] : ['test/unit/**/*.test.{ts,tsx}'],
    exclude: budgets ? [] : ['test/unit/**/*.budget.test.{ts,tsx}'],
    setupFiles: ['test/unit/support/platform.ts'],
    // The agent worker has 4 CPUs shared with other agents (W5).
    maxWorkers: budgets ? 1 : 2,
  },
});
