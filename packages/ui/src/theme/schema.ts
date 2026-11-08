/**
 * Custom themes as stored in the synced settings (T28, A17), validated
 * whenever they are read: they arrive from other devices, from older and
 * newer builds (A20), and from agent tokens, so nothing in them is trusted.
 *
 * - Data that is not a theme (no custom id, no name) is ignored.
 * - A colour that is not `#rrggbb`, a font stack with anything but names,
 *   commas and quotes, or an editor width out of range falls back to the
 *   value of the built-in it was duplicated from, and is reported.
 * - Fields this build does not know are ignored on read and kept on write,
 *   so an older build editing a newer theme does not strip it.
 */
import { BUILT_IN_THEMES, PENMOSS } from './builtins';
import { isHexColour } from './colour';
import {
  COLOUR_KEYS,
  EDITOR_WIDTH,
  type Theme,
  type ThemeColours,
  type ThemeFonts,
} from './tokens';

/** `custom-` and up to 32 lowercase letters or digits. Never a built-in's id. */
const CUSTOM_ID = /^custom-[a-z0-9]{1,32}$/;
/** Font family names, commas, spaces, hyphens, dots and quotes: no `;`, braces, `url(`. */
const FONT_STACK = /^[\p{L}\p{N} ,'".-]{1,200}$/u;
const NAME_MAX = 60;
const FONT_KEYS = ['ui', 'body', 'mono'] as const;

export interface StoredTheme {
  /** 1 for this build; a newer build's higher version is kept when an older one writes. */
  readonly version: number;
  readonly id: string;
  readonly name: string;
  readonly base: string;
  readonly fonts: ThemeFonts;
  readonly editorWidth: number;
  readonly light: Readonly<Record<string, string>>;
  readonly dark: Readonly<Record<string, string>>;
  readonly [unknown: string]: unknown;
}

export interface ParsedTheme {
  readonly theme: Theme;
  /** Fields that were missing or invalid and fell back to the base theme's value. */
  readonly problems: readonly string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const isCustomThemeId = (id: unknown): id is string =>
  typeof id === 'string' && CUSTOM_ID.test(id);

export function isSafeFontStack(value: unknown): value is string {
  if (typeof value !== 'string' || !FONT_STACK.test(value)) return false;
  // Quotes must pair up, or the stack would swallow what follows it.
  return (value.match(/'/g) ?? []).length % 2 === 0 && (value.match(/"/g) ?? []).length % 2 === 0;
}

export function builtInTheme(id: unknown): Theme | undefined {
  return BUILT_IN_THEMES.find((theme) => theme.id === id);
}

const describeCustom = (base: Theme) => `Based on ${base.name}`;

/** Reads a stored custom theme, or null when the data is not a theme. */
export function parseTheme(raw: unknown): ParsedTheme | null {
  if (!isRecord(raw) || !isCustomThemeId(raw['id']) || raw['deleted'] === true) return null;
  if (typeof raw['name'] !== 'string') return null;
  const problems: string[] = [];
  let base = builtInTheme(raw['base']);
  if (!base) {
    problems.push('base');
    base = PENMOSS;
  }
  let name = raw['name'].trim().slice(0, NAME_MAX);
  if (!name) {
    problems.push('name');
    name = 'Untitled theme';
  }
  const colours = (variant: 'light' | 'dark'): ThemeColours => {
    const source = isRecord(raw[variant]) ? raw[variant] : {};
    const out: Record<string, string> = {};
    for (const key of COLOUR_KEYS) {
      const value = source[key];
      if (isHexColour(value)) out[key] = value.toLowerCase();
      else {
        problems.push(`${variant}.${key}`);
        out[key] = base[variant][key];
      }
    }
    return out as ThemeColours;
  };
  const light = colours('light');
  const dark = colours('dark');
  const fontsRaw = isRecord(raw['fonts']) ? raw['fonts'] : {};
  const fonts = { ...base.fonts };
  for (const key of FONT_KEYS) {
    const value = fontsRaw[key];
    if (isSafeFontStack(value)) fonts[key] = value;
    else problems.push(`fonts.${key}`);
  }
  const width = raw['editorWidth'];
  let editorWidth = base.editorWidth;
  if (
    typeof width === 'number' &&
    Number.isFinite(width) &&
    width >= EDITOR_WIDTH.min &&
    width <= EDITOR_WIDTH.max
  ) {
    editorWidth = width;
  } else {
    problems.push('editorWidth');
  }
  return {
    theme: {
      id: raw['id'],
      name,
      description: describeCustom(base),
      base: base.id,
      fonts,
      editorWidth,
      light,
      dark,
    },
    problems,
  };
}

/** A copy of `source` to edit: a built-in, or another custom theme (keeping its base). */
export function duplicateTheme(source: Theme, id: string, name: string): Theme {
  const base = builtInTheme(source.base) ?? builtInTheme(source.id) ?? PENMOSS;
  return {
    ...source,
    id,
    name: name.trim().slice(0, NAME_MAX) || 'Untitled theme',
    description: describeCustom(base),
    base: base.id,
  };
}

/**
 * The JSON to store for `theme`, written over `previous` (the value stored
 * now) as a three-way merge from `start`, the theme as it was when the edit
 * began (by default, `previous` as this build reads it):
 *
 * - only fields that differ from `start` are written, so another device's
 *   edits to other fields since then are kept (concurrent edits merge);
 * - every other field keeps its stored value exactly, including values this
 *   build could not read (a newer build's format, A20) and fields it does not
 *   know at all, in the theme, its fonts and its colours.
 *
 * With nothing stored (a new theme), every field is written.
 */
export function storedTheme(theme: Theme, previous?: unknown, start?: Theme): StoredTheme {
  const old = isRecord(previous) ? previous : {};
  const from = start ?? (isRecord(previous) ? parseTheme(previous)?.theme : undefined);
  const version = typeof old['version'] === 'number' && old['version'] > 1 ? old['version'] : 1;
  const record = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});
  /** The stored record with the fields `theme` changed since `start` written over it. */
  const merged = <K extends string>(
    stored: unknown,
    keys: readonly K[],
    mine: Readonly<Record<K, unknown>>,
    began: Readonly<Record<K, unknown>> | undefined,
  ) => {
    const out: Record<string, unknown> = { ...record(stored) };
    for (const key of keys) if (!began || mine[key] !== began[key]) out[key] = mine[key];
    return out;
  };
  const top = merged(
    old,
    ['name', 'base', 'editorWidth'] as const,
    { name: theme.name, base: theme.base ?? theme.id, editorWidth: theme.editorWidth },
    from && { name: from.name, base: from.base ?? from.id, editorWidth: from.editorWidth },
  );
  return {
    ...top,
    version,
    id: theme.id,
    name: top['name'] as string,
    base: top['base'] as string,
    editorWidth: top['editorWidth'] as number,
    fonts: merged(old['fonts'], FONT_KEYS, theme.fonts, from?.fonts) as unknown as ThemeFonts,
    light: merged(old['light'], COLOUR_KEYS, theme.light, from?.light) as Record<string, string>,
    dark: merged(old['dark'], COLOUR_KEYS, theme.dark, from?.dark) as Record<string, string>,
  };
}

/** What a deleted custom theme leaves: its base, for devices that still choose it. */
export interface DeletedTheme {
  readonly id: string;
  readonly base: string;
  readonly deleted: true;
}

export function deletedTheme(theme: Theme): DeletedTheme {
  return { id: theme.id, base: builtInTheme(theme.base)?.id ?? 'penmoss', deleted: true };
}

/** The built-in a deleted theme was based on, or undefined when `raw` is not a deletion. */
export function deletedThemeBase(raw: unknown): Theme | undefined {
  if (!isRecord(raw) || raw['deleted'] !== true || !isCustomThemeId(raw['id'])) return undefined;
  return builtInTheme(raw['base']) ?? PENMOSS;
}

/** A new custom theme id. */
export function newCustomThemeId(random: () => number = Math.random): string {
  let id = '';
  while (id.length < 12) id += Math.floor(random() * 36).toString(36);
  return `custom-${id}`;
}
