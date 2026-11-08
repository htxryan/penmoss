import { defineConfig } from 'vitest/config';

// The search eval (T71, A1155): out of `task check`, as the server's was; a real model takes minutes.
export default defineConfig({
  test: {
    include: ['scripts/eval-search.ts'],
    testTimeout: 30 * 60_000,
  },
});
