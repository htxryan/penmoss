import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';
import { sharedTest } from '../../scripts/vitest-shared.mjs';

// Inside workerd (no DOM, no Node file system), only what the runtime provides differently (A9,
// A1514): the codec with no DOM, Web Crypto (ids, sha256Hex, chunk keys), DigestStream
// (gitBlobSha) and Intl's time zones (periodic notes). The rest of core is the same JavaScript on
// the same V8, proved once in Node; the relay's own workerd test loads the real bundle, so a
// Node-only import anywhere in it still fails there.
export default defineConfig({
  plugins: [
    cloudflareTest({
      // Same compatibility date as apps/relay/wrangler.jsonc.
      miniflare: { compatibilityDate: '2026-10-19' },
    }),
  ],
  test: {
    ...sharedTest({
      include: [
        'test/workers/**/*.test.ts',
        'test/attachments.test.ts',
        'test/ids.test.ts',
        'test/periodic.test.ts',
        'test/search-semantic.test.ts',
      ],
      env: false,
    }),
    fsModuleCache: false,
  },
});
