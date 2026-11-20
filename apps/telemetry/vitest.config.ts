import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig, type Plugin } from 'vitest/config';
import { sharedTest } from '../../scripts/vitest-shared.mjs';

/** queries/*.sql as text, as wrangler's Text rule imports them in the Worker. */
const sqlAsText: Plugin = {
  name: 'sql-as-text',
  transform: (code, id) =>
    id.endsWith('.sql') ? { code: `export default ${JSON.stringify(code)};`, map: null } : null,
};

// The ingest Worker in workerd with a local D1 the migration is applied to before each file
// (test/apply-migrations.ts): batches, forgets, limits, the nightly cron and the named queries.
export default defineConfig(async () => ({
  plugins: [
    sqlAsText,
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      remoteBindings: false,
      miniflare: {
        bindings: { TEST_MIGRATIONS: await readD1Migrations('./migrations') },
      },
    }),
  ],
  test: {
    ...sharedTest({ include: ['test/**/*.test.ts'], env: false }),
    setupFiles: ['./test/apply-migrations.ts'],
  },
}));
