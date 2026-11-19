import type { D1Migration } from 'cloudflare:test';

declare global {
  namespace Cloudflare {
    interface Env {
      /** The migrations, read by vitest.config.ts; test/apply-migrations.ts applies them. */
      readonly TEST_MIGRATIONS: D1Migration[];
    }
  }
}
