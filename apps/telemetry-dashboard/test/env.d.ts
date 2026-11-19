import type { D1Migration } from 'cloudflare:test';

declare global {
  namespace Cloudflare {
    interface Env {
      /** apps/telemetry's migrations, read by vitest.workers.config.ts. */
      readonly TEST_MIGRATIONS: D1Migration[];
    }
  }
}
