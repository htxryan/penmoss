import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig, type Plugin } from 'vitest/config';
import { sharedTest } from '../../scripts/vitest-shared.mjs';

/** apps/telemetry's queries/*.sql as text, as wrangler's Text rule imports them in the Worker. */
const sqlAsText: Plugin = {
  name: 'sql-as-text',
  transform: (code, id) =>
    id.endsWith('.sql') ? { code: `export default ${JSON.stringify(code)};`, map: null } : null,
};

// The dashboard Worker in workerd (test/*.test.ts): Access, every view's JSON against the fixture
// D1 (apps/telemetry/test/fixture.ts), the filters, the small-numbers rule and the cache. Its
// assets are the page `node build.mjs` builds into ./dist first (`pnpm test`).
export default defineConfig(async () => ({
  plugins: [
    sqlAsText,
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      remoteBindings: false,
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations('../telemetry/migrations'),
          ACCESS_TEAM: 'penmoss-test',
          ACCESS_AUD: 'a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0',
        },
      },
    }),
  ],
  test: {
    ...sharedTest({ include: ['test/*.test.ts'], exclude: ['test/*.node.test.ts'], env: false }),
    setupFiles: ['./test/apply-migrations.ts'],
  },
}));
