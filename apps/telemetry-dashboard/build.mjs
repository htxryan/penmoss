// The dashboard's page (PEN-137) into ./dist, which wrangler.jsonc serves as the Worker's
// assets: index.html, app.js (src/client, bundled by esbuild) and app.css. No CDN, nothing
// fetched at run time but the dashboard's own API.
//
//   node build.mjs            build into ./dist
//   node build.mjs <dir>      build into another folder (the Playwright spec's own)
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Builds the page into `out`.
 * @param {string} [out]
 */
export async function buildPage(out = join(here, 'dist')) {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const client = join(here, 'src', 'client');
  await build({
    entryPoints: [
      { in: join(client, 'main.ts'), out: 'app' },
      { in: join(client, 'styles.css'), out: 'app' },
    ],
    outdir: out,
    bundle: true,
    minify: true,
    format: 'esm',
    target: 'es2022',
    legalComments: 'none',
    logLevel: 'warning',
  });
  copyFileSync(join(client, 'index.html'), join(out, 'index.html'));
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  await buildPage(process.argv[2] ? resolve(process.argv[2]) : undefined);
}
