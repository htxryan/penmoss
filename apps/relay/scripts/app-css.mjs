/**
 * The app's own stylesheets for the relay's pages (PEN-193, R12): the tokens, the type roles,
 * buttons and Settings Groups, as the Mac and the web show them. A Worker can't import CSS, so
 * this writes them into `src/app-css.gen.ts`; `test/app-css.test.ts` fails when it is stale.
 *
 *   node scripts/app-css.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const web = join(here, '../../web/src');
export const SOURCES = [
  'shell/base.css',
  'shell/type.css',
  'shell/shell.css',
  'shell/controls.css',
  'theme/look-settings.css',
  'pages/settings.css',
];
export const OUT = join(here, '../src/app-css.gen.ts');

export function generate() {
  const css = SOURCES.map(
    (file) => `/* apps/web/src/${file} */\n${readFileSync(join(web, file), 'utf8')}`,
  ).join('\n');
  return `// Written by scripts/app-css.mjs from apps/web's stylesheets: don't edit it by hand.\nexport const APP_CSS = ${JSON.stringify(css)};\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(OUT, generate());
}
