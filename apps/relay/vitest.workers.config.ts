import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';
import { sharedTest } from '../../scripts/vitest-shared.mjs';

// The Worker in workerd (T55): OAuth in front of /mcp, the sign-in pages, and the Durable
// Object's SQLite storage, with two notebooks in one object (PEN-192). Never GitHub: a test that
// syncs gives the relay in-memory remotes.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      remoteBindings: false,
      miniflare: {
        bindings: {
          RELAY_ORIGIN: 'https://mcp.penmoss.test',
          OWNER_GITHUB_LOGIN: 'htxryan',
          GITHUB_API: 'https://api.github.test',
          GITHUB_WEB: 'https://github.test',
        },
      },
    }),
  ],
  test: sharedTest({ include: ['test/workers/**/*.test.ts'], env: false }),
});
