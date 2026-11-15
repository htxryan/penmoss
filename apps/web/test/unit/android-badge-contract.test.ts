/**
 * Notebook badges on Android (A1579): apps/android/contract/badge-v1.json is the web's badge
 * model (`src/sources/badge.ts`) and its Lucide, so the Kotlin `NotebookBadges` and `LucideIcons`
 * are held to what the Mac shows rather than to tests copied from it: the presets and inks, the
 * defaults a notebook's id and name give, what stored values read as (a bad one as the default),
 * which icon a stored value draws (an old name its twin, an alias its icon, a name this build
 * lacks nothing, so the badge shows its letter), Lucide's names and aliases, some icons' shapes
 * as the badge draws them, and what the picker's search finds. The Kotlin `NotebookBadgesTest`
 * reads the same file, and checks the icons the phone ships against it.
 *
 * After changing the badge model or Lucide, write the file again:
 * `PENMOSS_WRITE_CONTRACTS=1 pnpm --filter @penmoss/web test android-badge-contract`.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { lucideDynamicIconImports } from '@lucide/icons/dynamic';
import { findGlyphs } from '@penmoss/core/glyph-search';
import { describe, expect, it } from 'vitest';
import { ICONS } from '../../src/shell/lucide-catalog';
import {
  APP_ICON_IN_LUCIDE,
  BADGE_COLOR_SETTING,
  BADGE_GLYPH_SETTING,
  BADGE_PRESETS,
  FIRST_BADGE_ICON,
  INK_DARK,
  INK_LIGHT,
  badgeIconInLucide,
  badgeOf,
  defaultBadge,
  glyphInk,
  parseBadgeGlyph,
} from '../../src/sources/badge';
import { LUCIDE_PREFIX } from '../../src/shell/lucide';

const FILE = fileURLToPath(new URL('../../../android/contract/badge-v1.json', import.meta.url));
const WEB = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'),
) as { dependencies: Record<string, string> };

type Loaded = { default: { name: string; node: ReadonlyArray<[string, Record<string, unknown>]> } };
const IMPORTS = lucideDynamicIconImports as unknown as Readonly<
  Record<string, () => Promise<Loaded>>
>;

/** Notebooks whose defaults the phone must match: ids of each kind, names with and without letters. */
const NOTEBOOKS: ReadonlyArray<readonly [string, string]> = [
  ['01JD0000000000000000000001', 'Personal'],
  ['01JD0000000000000000000002', 'penmoss'],
  ['01JD0000000000000000000003', '2026 Plans'],
  ['01JD0000000000000000000004', '  — notes'],
  ['01JD0000000000000000000005', '!!!'],
  ['notebook-1', 'Work'],
  ['ab', 'éclair'],
  ['ab', 'ßtraße'],
  ['', 'Ωmega'],
  ['1f9b6d2c-0e1a-4c55-9a3b-7d1c2e3f4a5b', '日本語'],
  ['x', '١٢ Arabic digits'],
  ['y', '½ half'],
];

/** Stored settings and what they read as, for one notebook. */
const STORED: ReadonlyArray<Readonly<Record<string, unknown>>> = [
  {},
  { [BADGE_COLOR_SETTING]: 'teal' },
  { [BADGE_COLOR_SETTING]: '#1F7A7A' },
  { [BADGE_COLOR_SETTING]: '#123456' },
  { [BADGE_COLOR_SETTING]: '#12345' },
  { [BADGE_COLOR_SETTING]: 'plum' },
  { [BADGE_COLOR_SETTING]: 7 },
  { [BADGE_GLYPH_SETTING]: { kind: 'letter', value: 'Q' } },
  { [BADGE_GLYPH_SETTING]: { kind: 'letter', value: 'QR' } },
  { [BADGE_GLYPH_SETTING]: { kind: 'letter', value: ' ' } },
  { [BADGE_GLYPH_SETTING]: { kind: 'letter', value: '★' } },
  { [BADGE_GLYPH_SETTING]: { kind: 'letter', value: '🦊' } },
  { [BADGE_GLYPH_SETTING]: { kind: 'letter', value: '​' } },
  { [BADGE_GLYPH_SETTING]: { kind: 'number', value: '7' } },
  { [BADGE_GLYPH_SETTING]: { kind: 'number', value: '99' } },
  { [BADGE_GLYPH_SETTING]: { kind: 'number', value: '100' } },
  { [BADGE_GLYPH_SETTING]: { kind: 'number', value: '07' } },
  { [BADGE_GLYPH_SETTING]: { kind: 'icon', value: 'lucide:rocket' } },
  { [BADGE_GLYPH_SETTING]: { kind: 'icon', value: 'star' } },
  { [BADGE_GLYPH_SETTING]: { kind: 'icon', value: 'rocket' } },
  { [BADGE_GLYPH_SETTING]: { kind: 'icon', value: 'lucide:Rocket' } },
  { [BADGE_GLYPH_SETTING]: { kind: 'icon', value: 'lucide:from-a-later-lucide' } },
  { [BADGE_GLYPH_SETTING]: { kind: 'emoji', value: '🦊' } },
  { [BADGE_GLYPH_SETTING]: 'P' },
  { [BADGE_COLOR_SETTING]: 'red', [BADGE_GLYPH_SETTING]: { kind: 'icon', value: 'branch' } },
];

/** Stored icon values, and what the badge draws for each. */
const ICON_VALUES = [
  ...Object.keys(APP_ICON_IN_LUCIDE),
  'lucide:rocket',
  'lucide:notebook-pen',
  'lucide:alarm-check',
  'lucide:from-a-later-lucide',
  'lucide:',
  'lucide:-star',
  'rocket',
];

/** Icons whose shapes the phone must draw as the web does: every shape kind, filled ones too. */
const SHAPED = [
  ...Object.values(APP_ICON_IN_LUCIDE),
  'rocket',
  'alarm-clock-check',
  'badge-info',
  'brain-circuit',
  'clipboard-check',
  'arrow-down-0-1',
  'spray-can',
  'cylinder',
  'mailbox',
  'navigation',
];

/** Queries whose results the phone's picker must give, in order. */
const QUERIES = ['', 'star', 'book', 'git branch', 'arrow right', 'favourite', 'note', 'zzqqxx'];
const FIRST = 8;

/** The shapes as the badge draws them, without Lucide's React keys, attributes as text. */
function shapes(node: ReadonlyArray<[string, Record<string, unknown>]>) {
  return node.map(([element, attributes]) => [
    element,
    Object.fromEntries(
      Object.entries(attributes)
        .filter(([name]) => name !== 'key')
        .map(([name, value]) => [name, String(value)]),
    ),
  ]);
}

/** The icon a name draws, and its shapes, through @lucide/icons as the badge loads it. */
async function resolve(name: string): Promise<Loaded['default'] | null> {
  if (!Object.hasOwn(IMPORTS, name)) return null;
  return (await IMPORTS[name]!()).default;
}

async function expected() {
  const names = ICONS.map((icon) => icon.name);
  const catalogue = new Set(names);
  const aliases: Record<string, string> = {};
  for (const alias of Object.keys(IMPORTS).sort()) {
    if (catalogue.has(alias)) continue;
    aliases[alias] = (await resolve(alias))!.name;
  }
  const draws = [];
  for (const value of ICON_VALUES) {
    const glyph = parseBadgeGlyph({ kind: 'icon', value });
    const lucide = glyph ? badgeIconInLucide(value) : null;
    const icon = lucide ? await resolve(lucide) : null;
    draws.push({ value, valid: glyph !== null, icon: icon?.name ?? null });
  }
  const shaped: Record<string, unknown> = {};
  for (const name of SHAPED) shaped[name] = shapes((await resolve(name))!.node);
  const [id, name] = NOTEBOOKS[0]!;
  return {
    $comment:
      "The web's notebook badges (apps/web/src/sources/badge.ts) and Lucide, for the phone's (A1579). Written by apps/web/test/unit/android-badge-contract.test.ts; read by the Kotlin NotebookBadgesTest.",
    version: 1,
    keys: { color: BADGE_COLOR_SETTING, glyph: BADGE_GLYPH_SETTING },
    lucidePrefix: LUCIDE_PREFIX,
    firstIcon: FIRST_BADGE_ICON,
    ink: { light: INK_LIGHT, dark: INK_DARK },
    presets: BADGE_PRESETS.map(({ id: preset, label, hex }) => ({ id: preset, label, hex })),
    oldIcons: APP_ICON_IN_LUCIDE,
    defaults: NOTEBOOKS.map(([each, called]) => ({
      id: each,
      name: called,
      ...defaultBadge(each, called),
    })),
    stored: {
      id,
      name,
      cases: STORED.map((settings) => ({ settings, badge: badgeOf(id, name, settings) })),
    },
    inks: [
      ...BADGE_PRESETS.map((preset) => preset.hex),
      '#ffffff',
      '#000000',
      '#f5d76e',
      '#777777',
      '#7a7a7a',
      '#808080',
    ].map((hex) => ({ hex, ink: glyphInk(hex) })),
    draws,
    lucide: {
      version: WEB.dependencies['lucide-static'],
      icons: names.length,
      namesSha256: createHash('sha256').update(names.join('\n')).digest('hex'),
      aliases,
      shapes: shaped,
    },
    search: QUERIES.map((query) => {
      const found = findGlyphs(ICONS, query);
      return { query, count: found.length, first: found.slice(0, FIRST).map((icon) => icon.name) };
    }),
  };
}

describe('badge contract v1', () => {
  it('is the web’s badge model and Lucide, as the phone must show them', async () => {
    const now = await expected();
    if (process.env['PENMOSS_WRITE_CONTRACTS'])
      writeFileSync(FILE, `${JSON.stringify(now, null, 2)}\n`);
    const written = JSON.parse(readFileSync(FILE, 'utf8')) as unknown;
    expect(written).toEqual(now);
  });

  it('uses one Lucide, the same version of both its packages', () => {
    expect(WEB.dependencies['@lucide/icons']).toBe(WEB.dependencies['lucide-static']);
  });
});
