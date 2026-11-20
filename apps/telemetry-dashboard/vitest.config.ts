import { defineConfig } from 'vitest/config';
import { sharedTest } from '../../scripts/vitest-shared.mjs';

// What reads the source in Node (test/*.node.test.ts), and the page's code in happy-dom (test/client): the Worker and the queries it runs are
// SELECTs only. The Worker itself, in workerd, is vitest.workers.config.ts (test/*.test.ts).
export default defineConfig({
  test: sharedTest({ include: ['test/*.node.test.ts', 'test/client/*.test.ts'] }),
});
