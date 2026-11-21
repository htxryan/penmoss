// The dashboard's page (PEN-137) into ./dist, which wrangler.jsonc serves as the Worker's
// assets: index.html, app.js (src/client, bundled by esbuild) and app.css. No CDN, nothing
// fetched at run time but the dashboard's own API.
//
// Sessions' replay frame (PEN-178) too: player.html, player.js (src/client/replay/frame.ts) and
// player.css, the app's own stylesheets in the order the app loads them (appStylesheets() in
// scripts/design-system.mjs) and then the frame's few of its own. The app's icons and the note
// rail's tabs are made here, in Node (frame-data.ts), and handed to player.js as FRAME_DATA, so
// React never ships to the browser.
//
//   node build.mjs            build into ./dist
//   node build.mjs <dir>      build into another folder (the Playwright spec's own)
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
import { build } from 'esbuild';
import { appStylesheets } from '../../scripts/design-system.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');

/** The replay frame's build-time data (frame-data.ts), run in Node. */
async function frameData() {
  const cache = join(here, 'node_modules', '.cache', 'penmoss-replay');
  mkdirSync(cache, { recursive: true });
  const file = join(cache, 'frame-data.mjs');
  await build({
    entryPoints: [join(here, 'src', 'client', 'replay', 'frame-data.ts')],
    outfile: file,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    jsx: 'automatic',
    // React from the dashboard's own node_modules, beside the cache.
    external: ['react', 'react/*', 'react-dom', 'react-dom/*'],
    logLevel: 'warning',
  });
  const module = await import(`${pathToFileURL(file).href}?t=${Date.now()}`);
  return module.frameData();
}

/** The frame's stylesheet entry: the app's stylesheets in load order, then frame.css. */
function frameStylesheet() {
  const sheets = [
    // The Penmoss theme's first paint, before the frame's theme is set (main.tsx loads it first).
    'apps/web/src/theme/defaults.css',
    ...appStylesheets(),
  ].map((path) => join(repo, path));
  sheets.push(join(here, 'src', 'client', 'replay', 'frame.css'));
  const cache = join(here, 'node_modules', '.cache', 'penmoss-replay');
  mkdirSync(cache, { recursive: true });
  const entry = join(cache, 'player.css');
  writeFileSync(entry, sheets.map((path) => `@import ${JSON.stringify(path)};`).join('\n') + '\n');
  return entry;
}

/**
 * Builds the page into `out`.
 * @param {string} [out]
 */
export async function buildPage(out = join(here, 'dist')) {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const client = join(here, 'src', 'client');
  const shared = {
    outdir: out,
    bundle: true,
    minify: true,
    format: /** @type {const} */ ('esm'),
    target: 'es2022',
    legalComments: /** @type {const} */ ('none'),
    logLevel: /** @type {const} */ ('warning'),
  };
  await build({
    ...shared,
    entryPoints: [
      { in: join(client, 'main.ts'), out: 'app' },
      { in: join(client, 'styles.css'), out: 'app' },
    ],
  });
  await build({
    ...shared,
    entryPoints: [
      { in: join(client, 'replay', 'frame.ts'), out: 'player' },
      { in: frameStylesheet(), out: 'player' },
    ],
    define: { FRAME_DATA: JSON.stringify(await frameData()) },
    // The app's stylesheets' images (blocks.css's masks) are small data: URIs already.
    loader: { '.svg': 'dataurl', '.png': 'dataurl', '.woff2': 'dataurl' },
  });
  copyFileSync(join(client, 'index.html'), join(out, 'index.html'));
  copyFileSync(join(client, 'replay', 'player.html'), join(out, 'player.html'));
  // The Penmoss mark in the frame's sidebar, from the logo files the app draws it with.
  for (const mode of ['light', 'dark']) {
    copyFileSync(
      join(repo, 'packages', 'ui', 'src', 'icons', `brand-mark-${mode}.svg`),
      join(out, `brand-mark-${mode}.svg`),
    );
  }
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  await buildPage(process.argv[2] ? resolve(process.argv[2]) : undefined);
}
