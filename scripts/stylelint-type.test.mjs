// `penmoss/type-tokens` (A1561): a raw font size, weight, line height or `font` shorthand fails
// everywhere but type.css; a role, a step, calc() over them and the allowed keywords pass.
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import stylelint from 'stylelint';
import { isTokenValue, ruleName } from './stylelint-type.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The repository's own config, as `task lint` runs it, on `code` as if it were `file`. */
async function lint(code, file = 'apps/web/src/example.css') {
  const { results } = await stylelint.lint({
    code,
    codeFilename: join(root, file),
    configBasedir: root,
    configFile: join(root, 'stylelint.config.js'),
  });
  return results[0].warnings.filter((warning) => warning.rule === ruleName);
}

test('a role, a step, calc() over tokens and the keywords pass', async () => {
  const warnings = await lint(`
    .a { font-size: var(--pm-text-help); font-weight: var(--pm-weight-help); line-height: var(--pm-leading-help); }
    .b { font-size: var(--pm-text-sm); font-weight: var(--pm-weight-semibold); }
    .c { font-size: calc(var(--nb-badge-size, 1rem) * var(--pm-badge-glyph-ratio)); }
    .d { font: inherit; font-size: inherit; line-height: normal; }
    .e { line-height: 0; font-family: var(--pm-mono); }
  `);
  assert.deepEqual(warnings, []);
});

test('a raw size, weight or line height fails, with the property named', async () => {
  const warnings = await lint(`
    .a { font-size: 0.8rem; }
    .b { font-size: 13px; }
    .c { font-size: small; }
    .d { font-weight: 600; }
    .e { font-weight: bold; }
    .f { line-height: 1.45; }
    .g { font-size: calc(var(--pm-text-sm) * 1.1); }
    .h { font-size: var(--pm-text-sm, 0.85rem) ; font-size: 1em; }
  `);
  assert.deepEqual(
    warnings.map((warning) => warning.text.split('"')[1]),
    [
      'font-size: 0.8rem',
      'font-size: 13px',
      'font-size: small',
      'font-weight: 600',
      'font-weight: bold',
      'line-height: 1.45',
      'font-size: calc(var(--pm-text-sm) * 1.1)',
      'font-size: 1em',
    ],
  );
  assert.match(warnings[0].text, /apps\/web\/src\/shell\/type\.css/);
});

test('a font shorthand with a size fails; write the longhands', async () => {
  const warnings = await lint('.a { font: 600 0.72rem/1.2 var(--pm-font); }');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].text, /^"font: 600 0\.72rem\/1\.2 var\(--pm-font\)" sets a size/);
});

test('type.css, where the values are written, and the site are left alone', async () => {
  assert.deepEqual(
    await lint(':root { --x: 1rem; } .t { font-size: 0.72rem; }', 'apps/web/src/shell/type.css'),
    [],
  );
  assert.deepEqual(await lint('h1 { font-size: 2rem; }', 'site/src/styles/site.css'), []);
  assert.equal(
    (await lint('h1 { font-size: 2rem; }', 'apps/web/src/pages/settings.css')).length,
    1,
  );
  assert.equal((await lint('h1 { font-size: 2rem; }', 'apps/android/editor/src/x.css')).length, 1);
});

test('isTokenValue reads past var() fallbacks and calc()', () => {
  assert.equal(isTokenValue('font-size', 'var(--pm-text-sm, 0.85rem)'), true);
  assert.equal(isTokenValue('font-size', 'calc(var(--a) * var(--b, 2))'), true);
  assert.equal(isTokenValue('font-size', 'calc(var(--a) * 2)'), false);
  assert.equal(isTokenValue('line-height', '0'), true);
  assert.equal(isTokenValue('font-size', '0'), false);
  assert.equal(isTokenValue('font-weight', 'normal'), false);
});
