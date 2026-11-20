// Penmoss's design system in Claude (PEN-138, docs/brand.md): the files of the Design System
// artifact that come from the code, written from the real sources so they never drift from them.
//
//   node scripts/design-system.mjs [outDir]      (task design-system; default dist/design-system)
//
// It writes, under <outDir>/project/:
//   - tokens.json: the app's colours from the Penmoss theme (packages/ui/src/theme/builtins.ts),
//     light and dark, with the stylesheet's derived colours (base.css's color-mix) worked out for
//     each; the site's colours (site/src/styles/tokens.css) as `site-*`; the logo's own colours;
//     the type scale and roles (apps/web/src/shell/type.css); the font stacks; sizes, radii,
//     shadows and timings from base.css and site.css.
//   - components/bundle.css: the app's real stylesheets in the order the page loads them, then
//     the site's, nested under `.pm-site` with its tokens renamed `--site-*`, so a preview built
//     from the app's or the site's markup looks as the real thing does.
//   - themes.md: every built-in theme's colours, light and dark.
// The brand book, the component previews and the logo files are kept in the artifact itself;
// docs/brand.md says how to publish these files to it.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = join(import.meta.dirname, '..');
/** @typedef {{ name: string, value: string | Record<string, string | null>, usage: string }} Token */
/** @typedef {{ name: string, fontSize: string, fontWeight: number, lineHeight?: number, usage: string, family?: string }} TypeStyle */
/** @typedef {{ tokens?: Token[] }} Family */

/** @param {string} path */
const read = (path) => readFileSync(join(root, path), 'utf8');

// packages/ui is TypeScript with extensionless relative imports: let Node find the `.ts` file.
registerHooks({
  resolve(specifier, context, next) {
    if (/^\.\.?\//.test(specifier) && !/\.[cm]?[jt]s$/.test(specifier)) {
      try {
        return next(`${specifier}.ts`, context);
      } catch {
        /* not a .ts file: resolve as written */
      }
    }
    return next(specifier, context);
  },
});
const themeDir = join(root, 'packages/ui/src/theme');
const { BUILT_IN_THEMES, PENMOSS, NOTEBOOK_BADGE_COLOURS, NOTEBOOK_BADGE_INK } = await import(
  pathToFileURL(join(themeDir, 'builtins.ts')).href
);
const { COLOUR_TOKENS, FONT_STACKS, COLOUR_GROUPS } = await import(
  pathToFileURL(join(themeDir, 'tokens.ts')).href
);
const { mix } = await import(pathToFileURL(join(themeDir, 'colour.ts')).href);
const { themeVariables } = await import(pathToFileURL(join(themeDir, 'css.ts')).href);

/** The sources, relative to the repository, for meta.paths and the test. */
export const SOURCES = {
  appBase: 'apps/web/src/shell/base.css',
  appType: 'apps/web/src/shell/type.css',
  appEntry: 'apps/web/src/main.tsx',
  siteTokens: 'site/src/styles/tokens.css',
  siteStyles: ['site/src/styles/site.css', 'site/src/styles/docs.css'],
  brand: 'scripts/brand-assets.mjs',
  themes: 'packages/ui/src/theme/builtins.ts',
};

const SITE_CSS = 'site/src/styles/site.css';
const VARIANTS = /** @type {const} */ (['light', 'dark']);
const REM = 16;

// ---------------------------------------------------------------------------------------------
// CSS reading

/** @param {string} css */
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * The body of every top-level block whose selector is exactly `selector`, joined.
 * @param {string} css @param {string} selector
 */
function blocks(css, selector) {
  const text = stripComments(css);
  const out = [];
  let at = 0;
  for (;;) {
    const start = text.indexOf(`${selector} {`, at);
    if (start < 0) break;
    if (start > 0 && !/\n\s*$/.test(text.slice(0, start))) {
      at = start + 1;
      continue;
    }
    let depth = 0;
    let i = text.indexOf('{', start);
    const open = i;
    for (; i < text.length; i += 1) {
      if (text[i] === '{') depth += 1;
      else if (text[i] === '}' && --depth === 0) break;
    }
    out.push(text.slice(open + 1, i));
    at = i + 1;
  }
  return out.join('\n');
}

/**
 * `--name: value;` declarations in a block body, in order, as [name, value].
 * @param {string} body
 * @returns {[string, string][]}
 */
export function customProperties(body) {
  /** @type {[string, string][]} */
  const out = [];
  for (const match of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    out.push([String(match[1]), String(match[2]).replace(/\s+/g, ' ').trim()]);
  }
  return out;
}

/**
 * Every custom property a stylesheet declares on `:root` (any media), for the test.
 * @param {string} css
 */
export function rootProperties(css) {
  return customProperties(blocks(css, ':root')).map(([name]) => name);
}

/**
 * The comment just above each `--name:` line, as that token's usage.
 * @param {string} css
 */
function propertyComments(css) {
  /** @type {Map<string, string>} */
  const notes = new Map();
  let pending = '';
  for (const line of css.split('\n')) {
    const comment = /^\s*\/\*\s*(.*?)\s*\*\/\s*$/.exec(line);
    if (comment) {
      pending = comment[1] ?? '';
      continue;
    }
    const decl = /^\s*(--[\w-]+)\s*:[^;]*;\s*(?:\/\*\s*(.*?)\s*\*\/)?/.exec(line);
    if (decl) {
      const note = decl[2] ?? pending;
      if (note) notes.set(String(decl[1]), note);
      pending = '';
      continue;
    }
    if (line.trim() === '' || /[{}]/.test(line)) pending = '';
  }
  return notes;
}

// ---------------------------------------------------------------------------------------------
// Values

/** @param {string} value */
const toPx = (value) => {
  const rem = /^(-?[\d.]+)rem$/.exec(value);
  if (rem) return `${+(Number(rem[1]) * REM).toFixed(2)}px`;
  return value;
};

/** @param {string} hex @param {number} alpha */
const hexAlpha = (hex, alpha) =>
  `${hex.slice(0, 7)}${Math.round(alpha * 255)
    .toString(16)
    .padStart(2, '0')}`;

/**
 * `color-mix(in oklab, …)` as the browser works it out for the stylesheet's two forms: a colour
 * with transparent (the colour at that alpha) and two opaque colours (an OKLab mix, colour.ts).
 * `vars` resolves `var(--x)`.
 * @param {string} expression @param {Record<string, string>} vars
 * @returns {string | null}
 */
export function evaluateColourMix(expression, vars) {
  const inner = /^color-mix\(in oklab,\s*(.*)\)$/.exec(expression.trim());
  if (!inner) return null;
  const parts = splitTop(inner[1] ?? '').map((part) => {
    const m = /^(.*?)(?:\s+([\d.]+)%)?$/.exec(part.trim());
    return {
      colour: (m?.[1] ?? '').trim(),
      weight: m?.[2] === undefined ? null : Number(m[2]) / 100,
    };
  });
  const [pa, pb] = parts;
  if (parts.length !== 2 || !pa || !pb) return null;
  /** @param {string} colour */
  const resolve = (colour) => {
    if (colour === 'transparent') return 'transparent';
    const v = /^var\((--[\w-]+)\)$/.exec(colour);
    const value = v ? vars[String(v[1])] : colour;
    return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : null;
  };
  const [a, b] = [resolve(pa.colour), resolve(pb.colour)];
  if (a === null || b === null) return null;
  const [wa, wb] = [pa.weight, pb.weight];
  const weightB = wb ?? (wa === null ? 0.5 : 1 - wa);
  if (b === 'transparent') return hexAlpha(a, 1 - weightB);
  if (a === 'transparent') return hexAlpha(b, weightB);
  return mix(a, b, weightB);
}

/**
 * Splits on commas outside parentheses.
 * @param {string} text
 */
function splitTop(text) {
  /** @type {string[]} */
  const out = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '(') depth += 1;
    else if (text[i] === ')') depth -= 1;
    else if (text[i] === ',' && depth === 0) {
      out.push(text.slice(from, i));
      from = i + 1;
    }
  }
  out.push(text.slice(from));
  return out;
}

/**
 * Every `color-mix(…)` inside a value (a shadow) worked out.
 * @param {string} value @param {Record<string, string>} vars
 */
function evaluateInside(value, vars) {
  let out = '';
  let at = 0;
  for (;;) {
    const start = value.indexOf('color-mix(', at);
    if (start < 0) return out + value.slice(at);
    let depth = 0;
    let i = start;
    for (; i < value.length; i += 1) {
      if (value[i] === '(') depth += 1;
      else if (value[i] === ')' && --depth === 0) break;
    }
    const colour = evaluateColourMix(value.slice(start, i + 1), vars);
    if (colour === null) return null;
    out += value.slice(at, start) + colour;
    at = i + 1;
  }
}

// ---------------------------------------------------------------------------------------------
// The tokens

/** @param {string} cssName */
const tokenName = (cssName) => cssName.replace(/^--/, '');
/** @param {string} id @returns {string} */
const groupLabel = (id) =>
  COLOUR_GROUPS.find((/** @type {{ id: string }} */ g) => g.id === id)?.label ?? id;

/**
 * Where the app uses its main colours, beyond the theme editor's label.
 * @type {Record<string, string>}
 */
const COLOUR_USAGE = {
  '--pm-bg': 'The page and the note.',
  '--pm-sidebar': 'The sidebar and the rail.',
  '--pm-raised': 'Menus, cards, dialogs, buttons and fields.',
  '--pm-border': 'Hairlines around fields, buttons, menus and dialogs.',
  '--pm-fg': 'Text and icons on pm-bg, pm-sidebar and pm-raised.',
  '--pm-muted': 'Help text, meta, list heads and quiet icons, on pm-bg, pm-sidebar and pm-raised.',
  '--pm-link': 'Links in a note and in the chrome.',
  '--pm-accent':
    'The primary button, the selection in a list, toggles that are on, the focus colour.',
  '--pm-on-accent': 'Text and icons on pm-accent.',
  '--pm-danger': 'Destructive buttons and errors.',
  '--pm-success': 'Done, saved and synced states.',
  '--pm-warn-bg': 'A warning banner, under pm-fg.',
  '--pm-agent': "An agent's edits in a note, apart from the person's own.",
  '--pm-highlight-bg': '==Highlighted== text in a note.',
  '--pm-search-match': 'Search matches in a note.',
  '--pm-shadow-color': 'The tint every shadow and the scrim are mixed from.',
};

/** @type {Record<string, string>} */
const DERIVED_USAGE = {
  '--pm-hover': 'The hover fill of a row, a menu item or a bar control.',
  '--pm-code-bg': 'Code blocks and inline code.',
  '--pm-focus': 'The keyboard focus ring.',
  '--pm-active': 'A pressed control; the open note in the sidebar.',
  '--pm-drop': 'A drop target while dragging.',
  '--pm-scrim': 'The scrim behind a dialog or sheet.',
  '--pm-accent-soft': 'A selected row, a chosen chip.',
  '--pm-accent-line': 'An accent hairline: a selected card, a callout of the accent.',
  '--pm-agent-soft': "The fill behind an agent's edit.",
  '--pm-border-strong': 'A field or control border that must read (3:1 on its ground).',
  '--pm-border-soft': 'Dividers inside a group: list rows, bar groups.',
  '--pm-danger-soft': 'The fill of a danger banner or a destructive row on hover.',
  '--pm-accent-softer': 'A quiet accent panel, such as a one-time secret.',
};

/** @returns {Token[]} */
function appColours() {
  /** @type {Token[]} */
  const tokens = [];
  for (const info of COLOUR_TOKENS) {
    const [main, ...aliases] = info.css;
    tokens.push({
      name: tokenName(main),
      value: { light: PENMOSS.light[info.key], dark: PENMOSS.dark[info.key] },
      usage: `App, ${groupLabel(info.group)}: ${info.label}.${COLOUR_USAGE[main] ? ` ${COLOUR_USAGE[main]}` : ''} The Penmoss theme's value; each theme sets its own.`,
    });
    for (const alias of aliases) {
      tokens.push({
        name: tokenName(alias),
        value: `{${tokenName(main)}}`,
        usage: `App: the same colour as ${tokenName(main)} (${info.label}).`,
      });
    }
  }
  return tokens;
}

/** base.css's derived colours and shadows, worked out for each variant of the Penmoss theme. */
function appDerived() {
  const css = read(SOURCES.appBase);
  const notes = propertyComments(css);
  const decls = customProperties(blocks(css, ':root'));
  const dark = Object.fromEntries(customProperties(blocks(css, ":root[data-mode='dark']")));
  /** @type {Record<string, Record<string, string>>} */
  const vars = Object.fromEntries(VARIANTS.map((v) => [v, themeVariables(PENMOSS, v)]));
  /** @type {Token[]} */ const colours = [];
  /** @type {Token[]} */ const shadows = [];
  /** @type {Token[]} */ const lengths = [];
  /** @type {Token[]} */ const radii = [];
  /** @type {Token[]} */ const timing = [];
  /** @type {string[]} */ const other = [];
  for (const [name, value] of decls) {
    const note = notes.get(name);
    if (value.startsWith('color-mix(')) {
      const v = Object.fromEntries(
        VARIANTS.map((variant) => [variant, evaluateColourMix(value, vars[variant] ?? {})]),
      );
      if (v.light === null) throw new Error(`base.css: cannot work out ${name}: ${value}`);
      colours.push({
        name: tokenName(name),
        value: v,
        usage: `App: ${DERIVED_USAGE[name] ?? note ?? 'derived'} Derived: ${value}.`,
      });
    } else if (value.includes('color-mix(')) {
      const v = Object.fromEntries(
        VARIANTS.map((variant) => [
          variant,
          evaluateInside((variant === 'dark' && dark[name]) || value, vars[variant] ?? {}),
        ]),
      );
      if (v.light === null) throw new Error(`base.css: cannot work out ${name}: ${value}`);
      shadows.push({
        name: tokenName(name),
        value: v,
        usage: `App: ${SHADOW_USAGE[name] ?? note ?? 'a shadow'} Derived: ${value}.`,
      });
    } else if (/^--pm-radius/.test(name)) {
      radii.push({ name: tokenName(name), value: toPx(value), usage: radiusUsage(name, note) });
    } else if (/^-?[\d.]+(rem|px|em)$/.test(value)) {
      lengths.push({ name: tokenName(name), value: toPx(value), usage: lengthUsage(name, note) });
    } else if (/^[\d.]+ms$|^cubic-bezier\(/.test(value)) {
      timing.push({ name: tokenName(name), value, usage: timingUsage(name) ?? 'App: timing.' });
    } else {
      other.push(name);
    }
  }
  if (other.length) throw new Error(`base.css: no family for ${other.join(', ')}`);
  return { colours, shadows, lengths, radii, timing };
}

/** @type {Record<string, string>} */
const SHADOW_USAGE = {
  '--pm-shadow': 'The palette and the other overlays that float over the page.',
  '--pm-ring': "A focused field's ring (quick capture).",
  '--pm-shadow-1': 'A button (.btn) at rest; heavier in dark.',
};

/** @param {string} name @param {string | undefined} note */
function radiusUsage(name, note) {
  /** @type {string | undefined} */
  const where = /** @type {Record<string, string>} */ ({
    '--pm-radius': 'Every control and surface in the app',
    '--pm-radius-sm': 'Small controls',
    '--pm-radius-lg': 'Cards and menus',
    '--pm-radius-xl': 'Dialogs',
    '--pm-radius-sheet': "The phone's sheets",
  })[name];
  return `App: ${where ?? note ?? 'a corner'}. The app is square-cornered: every radius is 0.`;
}

/** @param {string} name @param {string | undefined} note */
function lengthUsage(name, note) {
  /** @type {string | undefined} */
  const where = /** @type {Record<string, string>} */ ({
    '--status-bar-height': "The note's status bar; toasts float above it (A505).",
    '--pm-control': 'The height of a button or field.',
    '--pm-control-sm': 'The height of a small button or field.',
    '--pm-hit': 'The touch size on phones: 44 px (A183).',
    '--pm-bar': 'The height of a bar: the app bar, a pinned title bar.',
  })[name];
  return `App: ${where ?? note ?? 'a length'}`;
}

/** @param {string} name @returns {string | undefined} */
function timingUsage(name) {
  return /** @type {Record<string, string>} */ ({
    '--pm-ease': 'App: the easing for every transition.',
    '--pm-fast': 'App: a hover, a press, a tooltip.',
    '--pm-medium': 'App: a panel or a sheet opening.',
  })[name];
}

/** type.css: the scale's steps, weights and leadings as tokens, the roles as type styles. */
function appType() {
  const css = read(SOURCES.appType);
  const decls = customProperties(blocks(css, ':root').split('@media')[0] ?? '');
  const all = Object.fromEntries(decls);
  const notes = propertyComments(css);
  /** @type {Token[]} */ const scale = [];
  /** @type {Token[]} */ const weights = [];
  /** @type {Token[]} */ const leadings = [];
  for (const [name, value] of decls) {
    if (/^--pm-text-\w+$/.test(name) && /^[\d.]+rem$/.test(value)) {
      scale.push({ name: tokenName(name), value: toPx(value), usage: scaleUsage(name, decls) });
    } else if (/^--pm-weight-(regular|medium|semibold|bold)$/.test(name)) {
      weights.push({ name: tokenName(name), value, usage: `App: the ${name.slice(12)} weight.` });
    } else if (/^--pm-leading-(none|tight|snug|relaxed)$/.test(name)) {
      leadings.push({
        name: tokenName(name),
        value,
        usage: `App: a ${name.slice(13)} line height.`,
      });
    }
  }
  /** @param {string | undefined} value */
  const resolve = (value) => {
    for (let i = 0; i < 8; i += 1) {
      const v = /^var\((--[\w-]+)\)$/.exec(value ?? '');
      if (!v) break;
      value = all[String(v[1])];
    }
    return value;
  };
  // The roles, in type.css's order: `--pm-text-<role>` names a role when it is a var() alias.
  /** @type {TypeStyle[]} */
  const roles = [];
  for (const [name, value] of decls) {
    const role = /^--pm-text-([\w-]+)$/.exec(name)?.[1];
    if (!role || !value.startsWith('var(')) continue;
    const size = resolve(value);
    if (!size || !/^[\d.]+rem$/.test(size)) continue;
    const weight = resolve(all[`--pm-weight-${role}`]) ?? '400';
    const leading = resolve(all[`--pm-leading-${role}`]);
    /** @type {TypeStyle} */
    const style = {
      name: `t-${role}`,
      fontSize: toPx(size),
      fontWeight: Number(weight),
      usage: (notes.get(name) ?? '').replace(/\.$/, '') + `. var(--pm-text-${role}) or .t-${role}.`,
    };
    if (leading && leading !== 'normal') style.lineHeight = Number(leading);
    roles.push(style);
  }
  return { scale, weights, leadings, roles };
}

/** @param {string} name @param {[string, string][]} decls */
function scaleUsage(name, decls) {
  const users = decls
    .filter(([, value]) => value === `var(${name})`)
    .map(([role]) => role.replace(/^--pm-text-/, ''));
  return `App: a step of the type scale.${users.length ? ` Roles: ${users.join(', ')}.` : ''}`;
}

/** The site's tokens, renamed `site-*`: light from :root, dark from the docs' dark theme. */
function siteTokens() {
  const css = read(SOURCES.siteTokens);
  const notes = sectionNotes(css);
  const light = customProperties(blocks(css, ':root'));
  const dark = Object.fromEntries(customProperties(blocks(css, ":root[data-theme='dark']")));
  /** @type {Token[]} */ const colours = [];
  /** @type {Token[]} */ const filters = [];
  for (const [name, value] of light) {
    const site = siteName(name);
    if (/^#[0-9a-f]{3,8}$/i.test(value)) {
      colours.push({
        name: site,
        value: dark[name] ? { light: value, dark: dark[name] } : value,
        usage: `Site, ${notes.get(name) ?? 'colour'}: ${name} in site/src/styles. Dark is the docs' dark theme; the brochure pages are light only.`,
      });
    } else {
      filters.push({ name: site, value, usage: `Site: ${notes.get(name) ?? name}.` });
    }
  }
  return { colours, filters };
}

/**
 * The `/* Heading *\/` above each group of declarations in tokens.css.
 * @param {string} css
 */
function sectionNotes(css) {
  /** @type {Map<string, string>} */
  const notes = new Map();
  let heading = '';
  for (const line of css.split('\n')) {
    const h = /^\s*\/\*\s*(.*?)\s*\*\/\s*$/.exec(line);
    if (h) heading = (h[1] ?? '').toLowerCase();
    const decl = /^\s*(--[\w-]+)\s*:/.exec(line);
    if (decl?.[1] && !notes.has(decl[1])) notes.set(decl[1], heading);
  }
  return notes;
}

/** @param {string} cssName */
export const siteName = (cssName) => cssName.replace(/^--pm-/, 'site-').replace(/^--/, 'site-');

/** The site's corner radii: each literal radius in site.css, with the selectors that use it. */
function siteRadii() {
  const css = stripComments(read(SITE_CSS));
  /** @type {Map<string, string[]>} */
  const uses = new Map();
  for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = String(rule[1]).trim().replace(/\s+/g, ' ');
    const radius = /border-radius:\s*([^;]+);/.exec(String(rule[2]))?.[1]?.trim();
    if (!radius || radius.includes('var(')) continue;
    uses.set(radius, [...(uses.get(radius) ?? []), selector]);
  }
  /** @type {Token[]} */
  const tokens = [];
  for (const [value, selectors] of [...uses].sort((a, b) => parseFloat(a[0]) - parseFloat(b[0]))) {
    if (!/^[\d.]+(px|%)$/.test(value)) continue;
    tokens.push({
      name: `site-radius-${value.replace('%', 'pc')}`,
      value,
      usage: `Site: ${selectors.slice(0, 6).join('; ')}${selectors.length > 6 ? '…' : ''}.`.slice(
        0,
        1000,
      ),
    });
  }
  return tokens;
}

/** The logo's own colours (A402), read from the script that draws it. */
function brandColours() {
  const src = read(SOURCES.brand);
  /** @type {Token[]} */
  const tokens = [];
  for (const m of src.matchAll(
    /^\s*(light|dark|mono|inverse): \{ tile: '(#\w+)', fence: '(#\w+)', moss: '(#\w+)' \}/gm,
  )) {
    const [, variant, tile, fence, moss] = m;
    for (const [part, value] of [
      ['tile', tile],
      ['fence', fence],
      ['moss', moss],
    ]) {
      tokens.push({
        name: `brand-${variant}-${part}`,
        value: String(value).toLowerCase(),
        usage: `The Moss Pen mark, ${variant} version: its ${part}. The logo's own colour: it never follows the theme (A402).`,
      });
    }
  }
  if (tokens.length === 0) throw new Error(`${SOURCES.brand}: found no palette`);
  return tokens;
}

/** @returns {Token[]} */
function badgeColours() {
  return [
    ...Object.entries(/** @type {Record<string, string>} */ (NOTEBOOK_BADGE_COLOURS)).map(
      ([name, value]) => ({
        name: `badge-${name}`,
        value,
        usage: `A notebook badge's colour (${name}), the same in every theme and mode; white ink on it.`,
      }),
    ),
    ...Object.entries(/** @type {Record<string, string>} */ (NOTEBOOK_BADGE_INK)).map(
      ([name, value]) => ({
        name: `badge-ink-${name}`,
        value,
        usage: `A notebook badge's glyph: ${name === 'light' ? 'white, on the presets' : 'near-black, on a light custom colour'}.`,
      }),
    ),
  ];
}

function gitRef() {
  try {
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root })
      .toString()
      .trim();
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root })
      .toString()
      .trim();
    return `${branch}@${sha}`;
  } catch {
    return 'unknown';
  }
}

export function buildTokens() {
  const derived = appDerived();
  const type = appType();
  const site = siteTokens();
  const siteCss = stripComments(read(SITE_CSS));
  const siteBody = /body\s*\{[^}]*font-family:\s*([^;]+);/.exec(siteCss)?.[1];
  const siteMono = /font-family:\s*(ui-monospace[^;]+);/.exec(siteCss)?.[1];
  if (!siteBody || !siteMono) throw new Error(`${SITE_CSS}: no font families`);
  /** @param {string} stack */
  const family = (stack) => stack.replace(/\s+/g, ' ').trim();
  return {
    name: 'Penmoss',
    version: 1,
    color: {
      themes: [
        { id: 'light', name: 'Light' },
        { id: 'dark', name: 'Dark' },
      ],
      tokens: [
        ...appColours(),
        ...derived.colours,
        ...site.colours,
        ...brandColours(),
        ...badgeColours(),
      ],
    },
    type: {
      fonts: [],
      families: {
        sans: family(FONT_STACKS.sans),
        serif: family(FONT_STACKS.serif),
        humanist: family(FONT_STACKS.humanist),
        mono: family(FONT_STACKS.mono),
        site: family(siteBody),
        'site-mono': family(siteMono),
      },
      groups: [
        {
          name: 'App roles',
          family: 'sans',
          styles: type.roles,
        },
        {
          name: 'App scale',
          family: 'sans',
          styles: type.scale.map((t) => ({
            name: t.name,
            fontSize: String(t.value),
            fontWeight: 400,
            usage: t.usage,
          })),
        },
      ],
    },
    spacing: {
      note: 'The app sizes controls and bars from these; other spacing is written in rem beside each component (apps/web/src). The site writes its spacing in px per component (site.css).',
      tokens: [
        ...derived.lengths,
        {
          name: 'pm-editor-width',
          value: toPx(themeVariables(PENMOSS, 'light')['--pm-editor-width']),
          usage:
            "App: the note column's width in the Penmoss theme (52 rem, A500); 32–72 rem in a theme.",
        },
      ],
    },
    radius: {
      note: 'The app is square: every app radius is 0. The site is rounded, 4 to 20 px.',
      tokens: [...derived.radii, ...siteRadii()],
    },
    shadow: { tokens: derived.shadows },
    textSize: { tokens: type.scale },
    fontWeight: { tokens: type.weights },
    lineHeight: { tokens: type.leadings },
    timing: { tokens: derived.timing },
    filter: { tokens: site.filters },
    meta: {
      source: 'github',
      repo: 'htxryan/penmoss',
      ref: gitRef(),
      paths: {
        tokens: [SOURCES.themes, SOURCES.appBase, SOURCES.appType, SOURCES.siteTokens],
        styles: [SOURCES.appEntry, ...SOURCES.siteStyles],
        brand: [SOURCES.brand, 'docs/brand.md'],
      },
      generator: 'scripts/design-system.mjs (task design-system)',
    },
  };
}

/**
 * Every token in every family but type, in order.
 * @param {ReturnType<typeof buildTokens>} tokens
 * @returns {Token[]}
 */
export function familyTokens(tokens) {
  return Object.entries(tokens).flatMap(([key, value]) => {
    if (key === 'type' || key === 'meta') return [];
    const family = /** @type {Family} */ (value);
    return family.tokens ?? [];
  });
}

// ---------------------------------------------------------------------------------------------
// The stylesheet

/**
 * The app's stylesheets in the order the page loads them: main.tsx's imports (styles.css's
 * own in its order), then those a screen's module imports when it loads (Settings' pages, the
 * sidebar's notebooks, AI Descriptions…), by path. A package's stylesheet (Excalidraw's) is
 * not the app's.
 */
export function appStylesheets() {
  /** @type {string[]} */
  const out = [];
  /** @param {string} path */
  const add = (path) => {
    if (path.endsWith('theme/defaults.css')) return; // The Penmoss theme's colours: tokens.json.
    if (path.endsWith('/styles.css')) {
      for (const i of read(path).matchAll(/^@import '\.\/([\w/.-]+\.css)';/gm))
        add(join(dirname(path), String(i[1])));
    } else if (!out.includes(path)) out.push(path);
  };
  for (const m of read(SOURCES.appEntry).matchAll(/^import '(\.\.?\/[\w/.-]+\.css)';/gm)) {
    add(join(dirname(SOURCES.appEntry), String(m[1])));
  }
  const later = [];
  for (const file of sourceFiles('apps/web/src')) {
    for (const m of read(file).matchAll(/^import '(\.\.?\/[\w/.-]+\.css)';/gm)) {
      later.push(join(dirname(file), String(m[1])));
    }
  }
  for (const path of [...new Set(later)].sort()) add(path);
  return out;
}

/**
 * The app's TypeScript sources under `dir`, tests aside, relative to the repository.
 * @param {string} dir
 * @returns {string[]}
 */
function sourceFiles(dir) {
  /** @type {string[]} */
  const out = [];
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(path);
  }
  return out.sort();
}

/**
 * Drops the declarations tokens.json now holds, so a value edited on the page wins.
 * @param {string} css @param {Set<string>} names
 */
function withoutTokens(css, names) {
  return css.replace(/^\s*(--[\w-]+)\s*:[^;]*;[^\n]*\n/gm, (line, name) =>
    names.has(name) ? '' : line,
  );
}

/**
 * The app's dark selectors, keyed on the page's mode, read the system's theme instead.
 * @param {string} css
 */
const appThemeSelectors = (css) =>
  css
    .replace(/(:root|html)\[data-mode=(['"]?)(dark|light)\2\]/g, "$1[data-theme='$3']")
    .replace(/(:root|html):not\(\[data-mode\]\)/g, '$1:not([data-theme])');

/**
 * A site stylesheet nested under `.pm-site`: `html`, `body` and `:root` rules become the wrapper's
 * own, keyframes stay at the top level, and `--pm-*` reads `--site-*`.
 * @param {string} css @param {Set<string>} siteNames
 */
export function scopeSiteCss(css, siteNames) {
  const renamed = css.replace(/var\((--pm-[\w-]+)/g, (all, name) =>
    siteNames.has(name) ? `var(--${siteName(name)}` : all,
  );
  /** @type {string[]} */
  const keyframes = [];
  let body = '';
  let at = 0;
  const text = stripComments(renamed);
  // Walk the top-level rules.
  while (at < text.length) {
    const open = text.indexOf('{', at);
    if (open < 0) break;
    const selector = text.slice(at, open).trim();
    let depth = 0;
    let i = open;
    for (; i < text.length; i += 1) {
      if (text[i] === '{') depth += 1;
      else if (text[i] === '}' && --depth === 0) break;
    }
    const block = text.slice(open, i + 1);
    if (selector.startsWith('@keyframes')) keyframes.push(`${selector} ${block}`);
    else {
      const scoped = selector
        .split(',')
        .map((s) => s.trim().replace(/^(html|body|:root)(?=$|[\s:[.])/, '&'))
        .join(',\n  ');
      body += `  ${scoped} ${block}\n`;
    }
    at = i + 1;
  }
  return `${keyframes.join('\n')}\n.pm-site {\n${body}}\n`;
}

/** @param {ReturnType<typeof buildTokens>} tokens */
export function buildBundleCss(tokens) {
  const tokenNames = new Set(familyTokens(tokens).map((t) => `--${t.name}`));
  const fonts = [
    `  --pm-font: var(--font-sans);`,
    `  --pm-font-body: var(--font-sans);`,
    `  --pm-mono: var(--font-mono);`,
  ].join('\n');
  const parts = [
    `/* Penmoss — the app's and the site's stylesheets, written by scripts/design-system.mjs from ${tokens.meta.ref}. Colours, sizes and radii come from tokens.json; edit them there. */`,
    `/* The Penmoss theme's fonts (packages/ui/src/theme/builtins.ts). */\n:root {\n${fonts}\n}`,
  ];
  for (const path of appStylesheets()) {
    let css = read(path);
    css = withoutTokens(css, tokenNames);
    css = appThemeSelectors(css).replace(/^@import .*$/gm, '');
    parts.push(`/* ${path} */\n${css.trim()}`);
  }
  const siteNames = new Set(
    customProperties(blocks(read(SOURCES.siteTokens), ':root')).map(([n]) => n),
  );
  for (const path of SOURCES.siteStyles) {
    parts.push(`/* ${path}, under .pm-site */\n${scopeSiteCss(read(path), siteNames).trim()}`);
  }
  return `${parts.join('\n\n')}\n`;
}

// ---------------------------------------------------------------------------------------------
// tokens.css, laid out as the Design System page compiles it, for the first publish (the page
// writes it again whenever someone saves an edit there)

/** @param {ReturnType<typeof buildTokens>} tokens */
export function buildTokensCss(tokens) {
  const [first, ...others] = tokens.color.themes.map((t) => t.id);
  /** @param {string} value */
  const css = (value) => (/^\{([\w.-]+)\}$/.test(value) ? `var(--${value.slice(1, -1)})` : value);
  /** @param {Token} t @param {string | undefined} theme @returns {string | null} */
  const valueFor = (t, theme) =>
    typeof t.value === 'string'
      ? theme === first
        ? t.value
        : null
      : (t.value[theme ?? ''] ?? null);
  /** @type {Token[]} */
  const themed = [...tokens.color.tokens, ...tokens.shadow.tokens];
  const lines = [`/* ${tokens.name} — generated from tokens.json */`];
  lines.push(`:root, [data-theme="${first}"] {`);
  for (const t of themed) lines.push(`  --${t.name}: ${css(valueFor(t, first) ?? '')};`);
  lines.push('}');
  for (const theme of others) {
    lines.push(`[data-theme="${theme}"] {`);
    for (const t of themed) {
      const v = valueFor(t, theme);
      if (v !== null) lines.push(`  --${t.name}: ${css(v)};`);
      else if (typeof t.value === 'string' && /^\{/.test(t.value))
        lines.push(`  --${t.name}: ${css(t.value)};`);
    }
    lines.push('}');
  }
  lines.push(':root {');
  for (const [key, family] of Object.entries(tokens)) {
    if (['color', 'shadow', 'type', 'meta'].includes(key)) continue;
    for (const t of /** @type {Family} */ (family).tokens ?? [])
      lines.push(`  --${t.name}: ${t.value};`);
  }
  for (const [key, stack] of Object.entries(tokens.type.families))
    lines.push(`  --font-${key}: ${stack};`);
  lines.push('}');
  for (const group of tokens.type.groups) {
    for (const style of /** @type {TypeStyle[]} */ (group.styles)) {
      const decl = [
        `font-family: var(--font-${style.family ?? group.family})`,
        `font-size: ${style.fontSize}`,
      ];
      if (style.fontWeight) decl.push(`font-weight: ${style.fontWeight}`);
      if (style.lineHeight) decl.push(`line-height: ${style.lineHeight}`);
      lines.push(`.${style.name} { ${decl.join('; ')}; }`);
    }
  }
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------------------------
// The built-in themes, as a section of the brand book

export function buildThemesMd() {
  const lines = [
    '# Built-in Themes',
    '',
    'The app ships eight themes, each with a light and a dark variant (Settings → Appearance; A241). Penmoss is the default and is the one `tokens.json` holds. Designs show Penmoss unless they are about themes. Every theme sets the same tokens, so a design built on the `pm-*` tokens works in all of them. This section is written by `scripts/design-system.mjs` from `packages/ui/src/theme/builtins.ts`.',
    '',
  ];
  /** @type {{ key: string, css: string[], label: string, group: string }[]} */
  const keys = COLOUR_TOKENS.filter((/** @type {{ group: string }} */ t) =>
    ['surfaces', 'text', 'states'].includes(t.group),
  );
  for (const theme of BUILT_IN_THEMES) {
    lines.push(
      `## ${theme.name}`,
      '',
      `${theme.description}. Note column ${theme.editorWidth} rem.`,
      '',
    );
    lines.push('| Token | Light | Dark |', '| --- | --- | --- |');
    for (const t of keys) {
      lines.push(
        `| \`${tokenName(t.css[0] ?? '')}\` (${t.label}) | \`${theme.light[t.key]}\` | \`${theme.dark[t.key]}\` |`,
      );
    }
    lines.push('');
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------

/** @param {string} outDir */
export function build(outDir) {
  const tokens = buildTokens();
  const files = {
    'project/tokens.json': `${JSON.stringify(tokens, null, 2)}\n`,
    'project/tokens.css': buildTokensCss(tokens),
    'project/components/bundle.css': buildBundleCss(tokens),
    'project/themes.md': `${buildThemesMd()}\n`,
  };
  for (const [path, text] of Object.entries(files)) {
    const file = join(outDir, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  return { tokens, files };
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  const outDir = process.argv[2] ?? join(root, 'dist/design-system');
  const { tokens, files } = build(outDir);
  const count = familyTokens(tokens).length;
  console.log(
    `Wrote ${Object.keys(files).length} files to ${relative(process.cwd(), outDir) || '.'}: ${count} tokens, ${tokens.type.groups.reduce((n, g) => n + g.styles.length, 0)} type styles.`,
  );
}
