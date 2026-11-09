// Bundles the CLI for Node 22+ (A174): dist/penmoss-cli.js, the whole CLI, and
// dist/penmoss.js, the package's bin, a few lines any Node can parse that check
// the version first and only then load the bundle, so an older Node prints which
// version it needs instead of a syntax error. `node build.js <dir>` builds elsewhere.
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const outdir = resolve(process.argv[2] ?? fileURLToPath(new URL('./dist', import.meta.url)));
await mkdir(outdir, { recursive: true });
await build({
  entryPoints: [fileURLToPath(new URL('./src/bin.ts', import.meta.url))],
  outfile: join(outdir, 'penmoss-cli.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  logLevel: 'warning',
  // Git notebooks (T50) bundle CommonJS packages (yaml) that require Node's modules: an ES
  // module has no `require` of its own, so it gets one.
  banner: {
    js: "import { createRequire as __penmossRequire } from 'node:module'; const require = __penmossRequire(import.meta.url);",
  },
});
const shim = `#!/usr/bin/env node
// penmoss: checks the Node version, then loads the CLI (penmoss-cli.js), which older Node cannot parse.
var version = process.versions.node;
if (Number(version.split('.')[0]) < 22) {
  process.stderr.write('penmoss needs Node 22 or later (this is ' + version + ').\\n');
  process.exit(1);
}
import('./penmoss-cli.js');
`;
const bin = join(outdir, 'penmoss.js');
await writeFile(bin, shim);
await chmod(bin, 0o755);
