import { defineConfig } from 'vitest/config';

// The relay's logic in Node (test/*.test.ts); the Worker itself in workerd is
// vitest.workers.config.ts (test/workers/).
export default defineConfig({
  test: {
    // A timeout is for a hang, not a slow machine: on this shared Mac (W12) a run starved of CPU,
    // as a throttled background job is, runs 10–30× slower than alone, well past vitest's 5 s
    // and 10 s. Wall-clock budgets live in *.budget.test.ts (A1244).
    testTimeout: 30_000,
    hookTimeout: 30_000,
    include: ['test/*.test.ts'],
    maxWorkers: 2,
  },
});
