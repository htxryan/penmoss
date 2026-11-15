import { defineConfig } from 'vitest/config';
import { sharedTest } from '../../scripts/vitest-shared.mjs';

export default defineConfig({
  test: sharedTest({ include: ['test/**/*.test.ts'] }),
});
