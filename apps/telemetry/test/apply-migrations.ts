import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';

// Each test file starts from the migrated, empty database.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
