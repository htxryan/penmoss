import { defineConfig } from 'vitest/config';
import { sharedTest } from '../../scripts/vitest-shared.mjs';

// Unit tests in Node, and git notebooks end to end with real git (notebook-*.test.ts).
export default defineConfig({
  test: sharedTest({ include: ['test/**/*.test.ts'] }),
});
