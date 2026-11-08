import { defineConfig } from 'vitest/config';

// Unit tests in Node, and git notebooks end to end with real git (notebook.test.ts).
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    maxWorkers: 2,
  },
});
