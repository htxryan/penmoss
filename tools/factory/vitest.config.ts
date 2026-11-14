import { defineConfig } from 'vitest/config';

// The factory's unit tests: pure logic and gh calls through a fake exec, no network.
export default defineConfig({
  test: {
    // A timeout is for a hang, not a slow machine: on this shared Mac (W12) a run starved of CPU,
    // as a throttled background job is, runs 10–30× slower than alone, well past vitest's 5 s
    // and 10 s. Wall-clock budgets live in *.budget.test.ts (A1244).
    testTimeout: 30_000,
    hookTimeout: 30_000,
    include: ['test/**/*.test.ts'],
    // The run's temporary folders in one of its own, removed at the end (test/tmp-root.ts).
    globalSetup: ['test/tmp-root.ts'],
  },
});
