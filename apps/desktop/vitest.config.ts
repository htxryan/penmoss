import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.ts'],
    // The agent worker has 4 CPUs shared with other agents (W5).
    maxWorkers: 2,
  },
});
