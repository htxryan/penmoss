import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // A timeout is for a hang, not a slow machine: on this shared Mac (W12) a run starved of CPU,
    // as a throttled background job is, runs 10–30× slower than alone, well past vitest's 5 s
    // and 10 s. Wall-clock budgets live in *.budget.test.ts (A1244).
    testTimeout: 30_000,
    hookTimeout: 30_000,
    include: ['test/unit/**/*.test.ts'],
    // The agent worker has 4 CPUs shared with other agents (W5).
    maxWorkers: 2,
  },
});
