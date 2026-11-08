import { build } from '/Users/redhale/src/penmoss/node_modules/.pnpm/esbuild@0.28.2/node_modules/esbuild/lib/main.js';
import { existsSync } from 'node:fs';
const W = '/Users/redhale/src/penmoss-wt/t70-search-by-meaning/packages/core/src';
await build({
  entryPoints: ['/private/tmp/claude-501/-Users-redhale-src-penmoss/8a4aebc4-18de-51ea-afe7-2d23f7783bbf/scratchpad/bench/bench.ts'], bundle: true, platform: 'node', format: 'esm', target: 'node24',
  outfile: '/private/tmp/claude-501/-Users-redhale-src-penmoss/8a4aebc4-18de-51ea-afe7-2d23f7783bbf/scratchpad/deps/bench.mjs', external: ['@huggingface/transformers'],
  nodePaths: ['/Users/redhale/src/penmoss/node_modules/.pnpm/node_modules'],
  plugins: [{ name: 'core', setup(b) { b.onResolve({ filter: /^@penmoss\/core(\/.*)?$/ }, (a) => {
    const sub = a.path.slice('@penmoss/core'.length) || '/index';
    for (const p of [W + sub + '.ts', W + sub + '/index.ts']) if (existsSync(p)) return { path: p };
  }); } }],
  logLevel: 'warning', banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
