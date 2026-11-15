import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
import { sharedTest } from '../../scripts/vitest-shared.mjs';

export default defineConfig({
  plugins: [react()],
  test: {
    // Playwright specs live in test/e2e and run through `task e2e`.
    ...sharedTest({ include: ['test/unit/**/*.test.{ts,tsx}'] }),
    setupFiles: ['test/unit/support/platform.ts'],
  },
});
