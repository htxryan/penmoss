import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/**/*.workers.test.ts'],
    maxWorkers: 2,
    // The fixture corpus is bundled with import.meta.glob; the on-disk module
    // cache would keep serving the old file list after a fixture is added.
    fsModuleCache: false,
  },
});
