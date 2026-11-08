import { defineConfig } from 'vitest/config';

// The relay's logic in Node (test/*.test.ts); the Worker itself in workerd is
// vitest.workers.config.ts (test/workers/).
export default defineConfig({
  test: {
    include: ['test/*.test.ts'],
    maxWorkers: 2,
  },
});
