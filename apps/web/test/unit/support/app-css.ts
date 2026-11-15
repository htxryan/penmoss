/**
 * The app's own stylesheet as the page gets it (web.md 2.8): `src/styles.css` lists the feature
 * files in cascade order, and this joins them in that order, for tests that read a rule.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '../../../src');

/** Every file `styles.css` imports, joined in order. */
export function appCss(): string {
  const index = readFileSync(join(SRC, 'styles.css'), 'utf8');
  const files = [...index.matchAll(/^@import '\.\/([^']+)';/gm)].map((match) => match[1]!);
  if (files.length === 0) throw new Error('styles.css imports no files');
  return files.map((file) => readFileSync(join(SRC, file), 'utf8')).join('\n');
}
