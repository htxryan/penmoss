import { defineConfig } from 'vitest/config';

// The factory's unit tests: pure logic and gh calls through a fake exec, no network.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
  },
});
