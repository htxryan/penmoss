import { defineConfig } from 'vitest/config';

// Performance measurements, not part of `task check`: `pnpm --filter @penmoss/sync-client perf`.
export default defineConfig({
  test: {
    include: ['perf/**/*.perf.ts'],
    environment: 'node',
    maxWorkers: 1,
    testTimeout: 120_000,
  },
});
