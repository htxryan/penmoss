import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    // Playwright specs live in test/e2e and run through `task e2e`.
    include: ['test/unit/**/*.test.{ts,tsx}'],
    setupFiles: ['test/unit/support/platform.ts'],
    // The agent worker has 4 CPUs shared with other agents (W5).
    maxWorkers: 2,
  },
});
