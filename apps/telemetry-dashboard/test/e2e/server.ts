/**
 * The dashboard for its Playwright spec (PEN-137): the Worker bundled as wrangler bundles it, its
 * page built, both run in Miniflare (workerd) on the port block's dashboard port, over a D1 with
 * the fixture's five weeks of usage, behind a stand-in for Cloudflare Access (test/signer.ts):
 * the team's certs come from the signer, through Miniflare's outbound service, never the network.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { ports } from '../../../../scripts/ports.mjs';
import { TEST_AUD, TEST_TEAM, createSigner } from '../signer';

const here = dirname(fileURLToPath(import.meta.url));
const app = join(here, '..', '..');

export interface Dashboard {
  readonly url: string;
  /** A valid Access token for the test application. */
  readonly token: string;
  stop(): Promise<void>;
}

/** apps/telemetry's migration, one statement at a time. */
function migration(): string[] {
  const text = readFileSync(join(app, '..', 'telemetry', 'migrations', '0001_events.sql'), 'utf8');
  return text
    .replace(/--.*$/gm, '')
    .split(/;\s*$/m)
    .map((statement) => statement.trim())
    .filter(Boolean);
}

export async function startDashboard(): Promise<Dashboard> {
  const folder = mkdtempSync(join(process.env['TMPDIR'] ?? tmpdir(), 'penmoss-dashboard-'));
  const assets = join(folder, 'dist');
  execFileSync('node', [join(app, 'build.mjs'), assets], { stdio: 'inherit' });
  const bundle = await build({
    entryPoints: [join(app, 'src', 'index.ts')],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    conditions: ['workerd', 'worker', 'browser'],
    mainFields: ['module', 'main'],
    loader: { '.sql': 'text' },
    external: ['cloudflare:*', 'node:*'],
    logLevel: 'warning',
  });
  const signer = await createSigner();
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      name: 'penmoss-telemetry-dashboard',
      modules: [{ type: 'ESModule', path: 'index.js', contents: bundle.outputFiles[0]!.text }],
      compatibilityDate: '2026-10-19',
      compatibilityFlags: ['nodejs_compat'],
      d1Databases: { DB: 'penmoss-telemetry-e2e' },
      assets: {
        directory: assets,
        binding: 'ASSETS',
        run_worker_first: true,
        routerConfig: { has_user_worker: true, invoke_user_worker_ahead_of_assets: true },
      },
      bindings: { ACCESS_TEAM: TEST_TEAM, ACCESS_AUD: TEST_AUD },
      // The only request the Worker makes: Access's certs, answered by the test signer.
      outboundService: async (request) => {
        const url = new URL(request.url);
        if (url.pathname === '/cdn-cgi/access/certs') {
          const certs = await signer.fetchCerts(url.toString()).catch(() => null);
          if (certs) return Response.json(certs) as never;
        }
        return new Response('Not here.', { status: 404 }) as never;
      },
      resourcePersistencePath: join(folder, 'state'),
      host: '127.0.0.1',
      port: ports().dashboard,
    }),
  );
  const ready = await mf.ready;
  const db = await mf.getD1Database('DB');
  await db.batch(migration().map((statement) => db.prepare(statement)));
  // The fixture is apps/telemetry's, typed for workerd; loaded by path, it stays out of this
  // Node project's types (Playwright compiles it all the same).
  const fixture = join(app, '..', 'telemetry', 'test', 'fixture.ts');
  const { seedFixture } = (await import(fixture)) as {
    seedFixture: (database: typeof db, now: number) => Promise<void>;
  };
  await seedFixture(db, Date.now());
  return {
    url: ready.toString().replace(/\/$/, ''),
    token: await signer.sign({ exp: Math.floor(Date.now() / 1000) + 4 * 3600 }),
    async stop() {
      await mf.dispose();
      rmSync(folder, { recursive: true, force: true });
    },
  };
}
