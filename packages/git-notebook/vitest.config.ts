import { defineConfig } from 'vitest/config';
import { sharedTest } from '../../scripts/vitest-shared.mjs';

// Node: the engine over the in-memory transport, and system git against local bare repos
// (isolated from the machine's git config, #147's CI risk).
export default defineConfig({
  test: {
    ...sharedTest({ include: ['test/**/*.test.ts'] }),
    // Real git on a shared Mac (W12): a timeout is for a hang, as in the other packages.
    testTimeout: 60_000,
  },
});
