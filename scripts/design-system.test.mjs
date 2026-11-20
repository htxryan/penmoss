// The design system's files (PEN-138): every token the app's and the site's stylesheets declare
// reaches tokens.json or the bundle's stylesheet, so a token added in the CSS can't be left out.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  appStylesheets,
  buildBundleCss,
  buildThemesMd,
  buildTokens,
  customProperties,
  evaluateColourMix,
  rootProperties,
  scopeSiteCss,
  siteName,
  SOURCES,
} from './design-system.mjs';

const root = join(import.meta.dirname, '..');
const read = (path) => readFileSync(join(root, path), 'utf8');

const tokens = buildTokens();
const bundle = buildBundleCss(tokens);
const tokenNames = new Set(
  Object.values(tokens).flatMap((family) => (family?.tokens ?? []).map((t) => `--${t.name}`)),
);
const bundleDeclares = (name) => new RegExp(`^\\s*${name}\\s*:`, 'm').test(bundle);

test("every app :root token is in tokens.json or the bundle's stylesheet", () => {
  const missing = [];
  for (const path of [SOURCES.appBase, SOURCES.appType]) {
    for (const name of rootProperties(read(path))) {
      if (!tokenNames.has(name) && !bundleDeclares(name)) missing.push(`${path}: ${name}`);
    }
  }
  assert.deepEqual(missing, []);
});

test("base.css's colours, shadows and lengths are tokens, and leave the stylesheet", () => {
  for (const name of rootProperties(read(SOURCES.appBase))) {
    if (name === '--pm-font') continue;
    assert.ok(tokenNames.has(name), `${name} is a token`);
    assert.ok(!bundleDeclares(name), `${name} is not declared again in bundle.css`);
  }
});

test("every site token is a site-* token, and the site's styles read it", () => {
  const css = read(SOURCES.siteTokens);
  const names = rootProperties(css);
  assert.ok(names.length > 30);
  for (const name of names) assert.ok(tokenNames.has(`--${siteName(name)}`), name);
  const dark = customProperties(css.split(":root[data-theme='dark']")[1]);
  const byName = new Map(tokens.color.tokens.map((t) => [t.name, t.value]));
  for (const [name, value] of dark) {
    assert.equal(byName.get(siteName(name)).dark, value, `${name}'s dark value`);
  }
  assert.ok(!/var\(--pm-(paper|ink|accent)\b/.test(bundle.split('.pm-site {')[1] ?? ''));
});

test('every theme colour token is in tokens.json, with the Penmoss theme’s values', async () => {
  const { COLOUR_TOKENS } = await import('../packages/ui/src/theme/tokens.ts');
  for (const info of COLOUR_TOKENS) {
    for (const name of info.css) assert.ok(tokenNames.has(name), name);
  }
  const bg = tokens.color.tokens.find((t) => t.name === 'pm-bg');
  assert.deepEqual(bg.value, { light: '#fbfaf7', dark: '#161a17' });
});

test("every stylesheet the page loads is in the bundle, in the page's order", () => {
  const sheets = appStylesheets();
  assert.ok(sheets.includes('apps/web/src/shell/controls.css'));
  assert.ok(!sheets.some((s) => s.endsWith('theme/defaults.css')));
  let at = -1;
  for (const path of sheets) {
    const where = bundle.indexOf(`/* ${path} */`);
    assert.ok(where > at, `${path} after the one before`);
    at = where;
  }
  assert.ok(
    !/(:root|html)(\[|:not\(\[)data-mode/.test(bundle),
    "dark rules read the system's data-theme",
  );
});

test('the type roles are styles, with their sizes from the scale', () => {
  const roles = tokens.type.groups.find((g) => g.name === 'App roles').styles;
  const help = roles.find((s) => s.name === 't-help');
  assert.equal(help.fontSize, '11.52px');
  assert.ok(roles.find((s) => s.name === 't-page-title').fontWeight === 700);
});

test('the logo colours come from the script that draws the mark', () => {
  const tile = tokens.color.tokens.find((t) => t.name === 'brand-light-tile');
  assert.equal(tile.value, '#f3eedf');
  assert.ok(tokens.color.tokens.some((t) => t.name === 'brand-dark-fence'));
});

test('token names are unique and readable by the design system page', () => {
  const seen = new Set();
  for (const family of Object.values(tokens)) {
    for (const t of family?.tokens ?? []) {
      assert.match(t.name, /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/);
      assert.ok(!seen.has(t.name), `${t.name} once`);
      seen.add(t.name);
      assert.ok(t.usage, `${t.name} has a usage note`);
      const values = typeof t.value === 'string' ? [t.value] : Object.values(t.value);
      for (const v of values) assert.ok(!/var\(|color-mix\(/.test(v), `${t.name}: ${v}`);
    }
  }
});

test('color-mix works out as the browser does', () => {
  const vars = { '--a': '#3c7a4b', '--b': '#1f2421', '--c': '#ffffff' };
  assert.equal(
    evaluateColourMix('color-mix(in oklab, var(--a) 14%, transparent)', vars),
    '#3c7a4b24',
  );
  assert.equal(evaluateColourMix('color-mix(in oklab, var(--c), var(--c) 40%)', vars), '#ffffff');
  assert.equal(
    evaluateColourMix('color-mix(in oklab, var(--missing) 10%, transparent)', vars),
    null,
  );
});

test("the site's stylesheet nests under .pm-site", () => {
  const css = scopeSiteCss(
    'html { color: red; }\nbody, .x { color: var(--pm-ink); }\n@keyframes k { to { opacity: 1; } }',
    new Set(['--pm-ink']),
  );
  assert.match(css, /^@keyframes k/);
  assert.match(css, /\.pm-site \{\n {2}& \{/);
  assert.match(css, /&,\n {2}\.x \{ color: var\(--site-ink\); \}/);
});

test('the themes section lists every built-in theme', () => {
  const md = buildThemesMd();
  for (const name of ['Penmoss', 'Paper', 'Nord', 'High Contrast'])
    assert.match(md, new RegExp(`## ${name}`));
});
