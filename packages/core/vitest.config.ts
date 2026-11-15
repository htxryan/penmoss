import { defineConfig } from 'vitest/config';
import { sharedTest } from '../../scripts/vitest-shared.mjs';

export default defineConfig({
  test: {
    ...sharedTest({ include: ['test/**/*.test.ts'], exclude: ['test/**/*.workers.test.ts'] }),
    // The fixture corpus is bundled with import.meta.glob; the on-disk module
    // cache would keep serving the old file list after a fixture is added.
    fsModuleCache: false,
  },
});
