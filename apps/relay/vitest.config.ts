import { defineConfig } from 'vitest/config';
import { sharedTest } from '../../scripts/vitest-shared.mjs';

// The relay's logic in Node (test/*.test.ts); the Worker itself in workerd is
// vitest.workers.config.ts (test/workers/).
export default defineConfig({
  test: sharedTest({ include: ['test/*.test.ts'] }),
});
