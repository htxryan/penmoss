import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'happy-dom',
    setupFiles: ['test/support/intersection.ts'],
    // The agent worker has 4 CPUs shared with other agents (W5).
    maxWorkers: 2,
  },
});
