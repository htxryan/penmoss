// Bundles the Mac app's main process and preload (T29) into dist/boot.cjs and
// dist/preload.cjs: everything but Electron itself is inlined, so the packaged
// app needs no node_modules (electron-builder packs dist/ and package.json).
// The web app is built into dist/web by `task desktop:build`.
import { cpSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { build } from 'esbuild';

const root = new URL('.', import.meta.url).pathname;
const common = {
  absWorkingDir: root,
  outdir: 'dist',
  outExtension: { '.js': '.cjs' },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
  sourcemap: 'linked',
  legalComments: 'none',
  logLevel: 'warning',
};
await build({
  ...common,
  // boot.cjs, the package's main, starts the app (main.ts) or, with --penmoss-cli, the CLI
  // (cli-mode.ts, A992); both are inlined into it.
  // embed-worker.cjs: search by meaning's worker thread for `penmoss mcp` (T75, A1152), and
  // embed-utility.cjs, the app's embedding service in a utilityProcess (T76).
  entryPoints: {
    boot: 'src/boot.ts',
    'embed-worker': '../../packages/embed/src/embed-worker.ts',
    'embed-utility': 'src/embed-utility.ts',
  },
  // onnxruntime-web's Node build finds its WASM from import.meta.url, which a CommonJS bundle
  // lacks (T70): each bundle gets its own file's URL.
  define: { 'import.meta.url': '__penmossImportMetaUrl' },
  banner: {
    js: "const __penmossImportMetaUrl = require('node:url').pathToFileURL(__filename).href;",
  },
});
// The preload runs sandboxed, where only `electron` can be required: no banner (T76 review).
await build({ ...common, entryPoints: { preload: 'src/preload.ts' } });

// Search by meaning's runtime (T75, A1152): onnxruntime-web's threaded WASM beside boot.cjs, in
// app.asar. The model itself is downloaded to ~/.penmoss/models, never bundled (A1151).
const ort = dirname(
  createRequire(new URL('../../packages/embed/package.json', import.meta.url)).resolve(
    'onnxruntime-web',
  ),
);
for (const file of ['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']) {
  cpSync(join(ort, file), new URL(`dist/ort/${file}`, import.meta.url));
}

// The menu bar icon's template image, 1x and 2x (T51, A945), beside boot.cjs: main loads
// dist/tray/trayTemplate.png and macOS picks the @2x file itself.
cpSync(new URL('resources/tray', import.meta.url), new URL('dist/tray', import.meta.url), {
  recursive: true,
  filter: (source) => !source.endsWith('.svg'),
});

// On a Mac, the owner check too (T41, A504), so `task desktop:dev` asks Touch ID or the
// password like the packaged app. Without Xcode's tools the dev app refuses admin changes.
if (process.platform === 'darwin') {
  const { buildAuthHelper } = await import('./scripts/build-auth-helper.mjs');
  try {
    buildAuthHelper();
  } catch (error) {
    console.warn(
      `[penmoss] the owner check was not built, admin changes will be refused: ${error}`,
    );
  }
}
