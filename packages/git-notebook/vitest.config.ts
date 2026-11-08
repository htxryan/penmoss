import { defineConfig } from 'vitest/config';

// Node: the engine over the in-memory transport, and system git against local bare repos
// (isolated from the machine's git config, #147's CI risk).
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    maxWorkers: 2,
    testTimeout: 60_000,
  },
});
