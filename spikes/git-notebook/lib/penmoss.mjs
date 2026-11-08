// Loads today's Penmoss code (src/penmoss-entry.ts) as one ES module, bundling it with the
// repo's esbuild on first use or when a source changed. Nothing here ships (spikes/ is outside
// the pnpm workspace, ESLint, Prettier and every build).
import { createRequire } from 'node:module';
import { existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const spike = dirname(here);
const repo = join(spike, '..', '..');
const out = join(spike, '.build', 'penmoss.mjs');
const entry = join(spike, 'src', 'penmoss-entry.ts');

const stale = () => {
  if (!existsSync(out)) return true;
  const built = statSync(out).mtimeMs;
  return [entry, here + '/penmoss.mjs'].some((file) => statSync(file).mtimeMs > built);
};

if (stale()) {
  const require = createRequire(join(repo, 'apps', 'desktop', 'package.json'));
  const esbuild = require('esbuild');
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node24',
    outfile: out,
    logLevel: 'warning',
    // CommonJS dependencies (yaml) call require() for Node built-ins.
    banner: { js: "import { createRequire as __spikeRequire } from 'node:module'; const require = __spikeRequire(import.meta.url);" },
    // One copy of each module (Yjs above all: two copies break `instanceof`).
    absWorkingDir: repo,
    // The spike is outside the workspace: resolve packages as the server and editor do.
    nodePaths: [join(repo, 'apps', 'server', 'node_modules'), join(repo, 'packages', 'editor', 'node_modules'), join(repo, 'packages', 'core', 'node_modules')],
  });
}

export const P = await import(pathToFileURL(out).href);
