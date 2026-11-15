import { defineConfig } from 'vitest/config';
import { sharedTest } from '../../scripts/vitest-shared.mjs';

// The factory's unit tests: pure logic and gh calls through a fake exec, no network.
export default defineConfig({
  test: {
    ...sharedTest({ include: ['test/**/*.test.ts'] }),
    // The run's temporary folders in one of its own, removed at the end (test/tmp-root.ts).
    globalSetup: ['test/tmp-root.ts'],
  },
});
