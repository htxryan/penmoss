/**
 * The relay's Add Notebook script (PEN-194, A1701): the app's own Add Notebook screens
 * (apps/web/src/relay/main.tsx, and the FirstRun*.tsx it mounts), bundled with React into one
 * file the relay serves at /notebooks/add/flow.js. A Worker can't run a bundler, so this writes
 * it into `src/add-flow.gen.ts`; `test/add-flow.test.ts` fails when it is stale.
 *
 *   node scripts/add-flow.mjs
 */
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const web = join(here, '../../web');
export const ENTRY = join(web, 'src/relay/main.tsx');
export const OUT = join(here, '../src/add-flow.gen.ts');

/** Vite and React's plugin as apps/web has them, so the screens build as the app's do. */
async function tools() {
  const require = createRequire(join(web, 'package.json'));
  const load = (name) => import(pathToFileURL(require.resolve(name)).href);
  const [vite, react] = await Promise.all([load('vite'), load('@vitejs/plugin-react')]);
  return { build: vite.build, react: react.default };
}

export async function generate() {
  const { build, react } = await tools();
  // React's packages and Vite pick their builds by NODE_ENV: production, whoever runs this (the
  // test runner sets `test`).
  const was = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  const result = await build({
    configFile: false,
    root: web,
    // The brand mark's `new URL(…, import.meta.url)` is inlined as data: a warning, not a fault.
    logLevel: 'error',
    mode: 'production',
    plugins: [react()],
    define: {
      'process.env.NODE_ENV': '"production"',
      // One classic script has no import.meta: assets (the brand mark) resolve against the page.
      'import.meta.url': 'document.baseURI',
    },
    build: {
      write: false,
      minify: true,
      sourcemap: false,
      target: 'es2022',
      cssCodeSplit: false,
      lib: { entry: ENTRY, formats: ['iife'], name: 'PenmossRelayAdd', fileName: () => 'flow.js' },
    },
  }).finally(() => {
    if (was === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = was;
  });
  const outputs = (Array.isArray(result) ? result : [result]).flatMap((each) => each.output);
  const chunk = outputs.find((each) => each.type === 'chunk');
  if (!chunk) throw new Error('vite built no script');
  return `// Written by scripts/add-flow.mjs from apps/web/src/relay: don't edit it by hand.\nexport const ADD_FLOW_JS = ${JSON.stringify(chunk.code)};\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(OUT, await generate());
}
