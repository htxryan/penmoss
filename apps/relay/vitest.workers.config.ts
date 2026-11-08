import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// The Worker in workerd (T55): OAuth in front of /mcp, the sign-in pages, and the Durable
// Object's SQLite storage. Never GitHub: no test here reaches the notebook's sync.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      remoteBindings: false,
      miniflare: {
        bindings: {
          RELAY_ORIGIN: 'https://mcp.penmoss.test',
          NOTES_REPOSITORY: 'ryan/notes',
          NOTES_DIR: '',
          ALLOWED_GITHUB_LOGIN: 'htxryan',
          GITHUB_TOKEN: 'fake-token',
          GITHUB_CLIENT_ID: 'Iv1.fakeclient',
          GITHUB_CLIENT_SECRET: 'fake-secret',
          GITHUB_API: 'https://api.github.test',
          GITHUB_WEB: 'https://github.test',
        },
      },
    }),
  ],
  test: {
    include: ['test/workers/**/*.test.ts'],
    maxWorkers: 2,
  },
});
