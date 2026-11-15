/**
 * Notebook badges (PEN-140, Ryan 14 Nov 2026): each notebook has a colour and a glyph (one
 * letter, a number from 0 to 99, or an icon, any of Lucide's since A1568), shown at the start of its row in the
 * sidebar, on its notes' tabs and in Settings. The badge is the notebook's own synced setting
 * (its WorkspaceDoc's `notebook` settings map, as the time zone is, A827): every Mac sees the
 * same one. Until it is changed nothing is written, and the default is derived: a preset picked
 * from the notebook's id (it looks random, and is the same on every device) and the first
 * letter or digit of its name. Duplicates are expected (Personal and Penmoss are both P).
 * Copying settings between notebooks (A1137) skips both keys.
 */
import { NOTEBOOK_BADGE_COLOURS, NOTEBOOK_BADGE_INK } from '@penmoss/ui/theme';
import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { LUCIDE_PREFIX, lucideName } from '../shell/lucide';
import type { Source } from './registry';

/** The badge's colour: a preset's name (`moss`) or `#rrggbb`. */
export const BADGE_COLOR_SETTING = 'badge.color';
/** The badge's glyph: `{ kind: 'letter' | 'number' | 'icon', value }`. */
export const BADGE_GLYPH_SETTING = 'badge.glyph';
export const BADGE_SETTINGS: readonly string[] = [BADGE_COLOR_SETTING, BADGE_GLYPH_SETTING];

export interface BadgePreset {
  /** Stored as the colour (`badge.color`). */
  readonly id: string;
  /** Its name in the picker (Title Case, A938). */
  readonly label: string;
  readonly hex: string;
}

/**
 * The ten presets (their colours in the built-in palette file, A244), each at least 4.5:1 with a
 * white glyph (notebook-badge.test.ts). A badge's colour is the same in light and dark: it names
 * the notebook, it is not the theme's.
 */
export const BADGE_PRESETS: readonly BadgePreset[] = [
  { id: 'moss', label: 'Moss', hex: NOTEBOOK_BADGE_COLOURS.moss },
  { id: 'teal', label: 'Teal', hex: NOTEBOOK_BADGE_COLOURS.teal },
  { id: 'blue', label: 'Blue', hex: NOTEBOOK_BADGE_COLOURS.blue },
  { id: 'indigo', label: 'Indigo', hex: NOTEBOOK_BADGE_COLOURS.indigo },
  { id: 'violet', label: 'Violet', hex: NOTEBOOK_BADGE_COLOURS.violet },
  { id: 'rose', label: 'Rose', hex: NOTEBOOK_BADGE_COLOURS.rose },
  { id: 'red', label: 'Red', hex: NOTEBOOK_BADGE_COLOURS.red },
  { id: 'orange', label: 'Orange', hex: NOTEBOOK_BADGE_COLOURS.orange },
  { id: 'ochre', label: 'Ochre', hex: NOTEBOOK_BADGE_COLOURS.ochre },
  { id: 'slate', label: 'Slate', hex: NOTEBOOK_BADGE_COLOURS.slate },
];

/**
 * The 24 icons a badge could show before Lucide (PEN-140), once from the app's own set. A badge
 * that has one keeps the value (nothing is migrated) and is drawn with its Lucide twin
 * (APP_ICON_IN_LUCIDE), so every badge icon is Lucide's (A1568).
 */
export const BADGE_ICONS = [
  'notebook',
  'journal',
  'calendar',
  'inbox',
  'folder',
  'file',
  'star',
  'pin',
  'globe',
  'code',
  'terminal',
  'branch',
  'brush',
  'palette',
  'pencil',
  'checklist',
  'comment',
  'graph',
  'key',
  'laptop',
  'phone',
  'sun',
  'moon',
  'pulse',
] as const;
export type BadgeIcon = (typeof BADGE_ICONS)[number];

/** Each icon from before Lucide as the Lucide icon that draws it (A1568). */
export const APP_ICON_IN_LUCIDE: Readonly<Record<BadgeIcon, string>> = {
  notebook: 'notebook',
  journal: 'book-text',
  calendar: 'calendar',
  inbox: 'inbox',
  folder: 'folder',
  file: 'file',
  star: 'star',
  pin: 'pin',
  globe: 'globe',
  code: 'code',
  terminal: 'terminal',
  branch: 'git-branch',
  brush: 'brush',
  palette: 'palette',
  pencil: 'pencil',
  checklist: 'list-checks',
  comment: 'message-square',
  graph: 'waypoints',
  key: 'key',
  laptop: 'laptop',
  phone: 'smartphone',
  sun: 'sun',
  moon: 'moon',
  pulse: 'activity',
};

/** The icon a new Icon badge starts with: Lucide's notebook. */
export const FIRST_BADGE_ICON = `${LUCIDE_PREFIX}notebook`;

const isOldIcon = (value: string): value is BadgeIcon =>
  (BADGE_ICONS as readonly string[]).includes(value);

/**
 * The Lucide icon an icon badge's value draws (`lucide:star` is `star`, the old `branch` is
 * `git-branch`), or null when it is neither.
 */
export function badgeIconInLucide(value: string): string | null {
  return isOldIcon(value) ? APP_ICON_IN_LUCIDE[value] : lucideName(value);
}

export type BadgeGlyphKind = 'letter' | 'number' | 'icon';

export interface BadgeGlyph {
  readonly kind: BadgeGlyphKind;
  /** One character, `0`–`99`, or an icon: `lucide:<name>`, or one of BADGE_ICONS. */
  readonly value: string;
}

export interface NotebookBadgeValue {
  /** The colour as `#rrggbb`. */
  readonly color: string;
  /** The preset it is (its id), or null for a custom colour. */
  readonly preset: string | null;
  readonly glyph: BadgeGlyph;
  /** Something was chosen (the colour or the glyph): Reset to Default has work to do. */
  readonly custom: boolean;
}

/** The glyph on a badge: white, or near-black on a light colour. */
export const INK_LIGHT: string = NOTEBOOK_BADGE_INK.light;
export const INK_DARK: string = NOTEBOOK_BADGE_INK.dark;

/** A stable 32-bit hash of the notebook's id (FNV-1a): the same on every device. */
export function idHash(id: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < id.length; index++) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** The default colour's preset: the one at hash(id) mod 10. */
export function defaultPreset(id: string): BadgePreset {
  return BADGE_PRESETS[idHash(id) % BADGE_PRESETS.length]!;
}

const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
const DIGIT = /\p{Nd}/u;

/**
 * The default glyph: the first letter or digit of the name, upper-cased ("personal" is P,
 * "2026 Plans" is 2); "#" when the name has neither.
 */
export function defaultGlyph(name: string): BadgeGlyph {
  for (const char of name) {
    if (!LETTER_OR_DIGIT.test(char)) continue;
    if (DIGIT.test(char)) return { kind: 'number', value: char };
    return { kind: 'letter', value: char.toLocaleUpperCase() };
  }
  return { kind: 'letter', value: '#' };
}

/** The badge a notebook has with nothing chosen. */
export function defaultBadge(id: string, name: string): NotebookBadgeValue {
  const preset = defaultPreset(id);
  return { color: preset.hex, preset: preset.id, glyph: defaultGlyph(name), custom: false };
}

const HEX = /^#[0-9a-f]{6}$/;

/** A stored colour as `{ hex, preset }`, or null when it is not one (a bad value reads as unset). */
export function parseBadgeColor(value: unknown): { hex: string; preset: string | null } | null {
  if (typeof value !== 'string') return null;
  const preset = BADGE_PRESETS.find((each) => each.id === value);
  if (preset) return { hex: preset.hex, preset: preset.id };
  const hex = value.toLowerCase();
  if (!HEX.test(hex)) return null;
  // A custom colour that is a preset's is that preset.
  const same = BADGE_PRESETS.find((each) => each.hex === hex);
  return { hex, preset: same?.id ?? null };
}

/** Whether `value` is one visible character (a letter, digit or symbol, never a space). */
function oneCharacter(value: string): boolean {
  const chars = [...value];
  return chars.length === 1 && /\S/u.test(value) && !/\p{C}/u.test(value);
}

/**
 * A stored glyph, checked; null when it is not one (two letters, an icon that is neither the
 * app's nor a Lucide name, 100). A Lucide name this build has no icon for still parses: the
 * badge then shows its letter (BadgeView), as a build from before A1568 does for any.
 */
export function parseBadgeGlyph(value: unknown): BadgeGlyph | null {
  if (!value || typeof value !== 'object') return null;
  const { kind, value: text } = value as { kind?: unknown; value?: unknown };
  if (typeof text !== 'string') return null;
  if (kind === 'letter') return oneCharacter(text) ? { kind, value: text } : null;
  if (kind === 'number') {
    return /^(0|[1-9][0-9]?)$/.test(text) ? { kind, value: text } : null;
  }
  if (kind === 'icon') {
    return badgeIconInLucide(text) !== null ? { kind, value: text } : null;
  }
  return null;
}

/** The notebook's badge from its settings: each part chosen and valid, else its default. */
export function badgeOf(
  id: string,
  name: string,
  settings: Readonly<Record<string, unknown>>,
): NotebookBadgeValue {
  const fallback = defaultBadge(id, name);
  const color = parseBadgeColor(settings[BADGE_COLOR_SETTING]);
  const glyph = parseBadgeGlyph(settings[BADGE_GLYPH_SETTING]);
  return {
    color: color?.hex ?? fallback.color,
    preset: color ? color.preset : fallback.preset,
    glyph: glyph ?? fallback.glyph,
    custom: color !== null || glyph !== null,
  };
}

/** WCAG relative luminance of `#rrggbb`. */
function luminance(hex: string): number {
  const channel = (at: number) => {
    const c = Number.parseInt(hex.slice(at, at + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** The WCAG contrast ratio of two `#rrggbb` colours. */
export function contrastRatio(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

/** A notebook's badge now, from its synced settings and its name (not a hook: read it again). */
export function badgeOfSource(source: Source): NotebookBadgeValue {
  return badgeOf(source.id, source.name, source.workspace.settings());
}

/** The glyph's colour on `hex`: white when it reaches 4.5:1, else whichever is clearer. */
export function glyphInk(hex: string): string {
  const white = contrastRatio(hex, INK_LIGHT);
  if (white >= 4.5) return INK_LIGHT;
  return contrastRatio(hex, INK_DARK) > white ? INK_DARK : INK_LIGHT;
}

/** What a badge change writes: a part set to null goes back to its default. */
export interface BadgeChange {
  readonly color?: string | null;
  readonly glyph?: BadgeGlyph | null;
}

/** Writes a badge change into the notebook's settings (undefined removes a key, A827). */
export function setNotebookBadge(source: Source, change: BadgeChange): void {
  const { workspace } = source;
  if ('color' in change) {
    const color = change.color === null ? null : parseBadgeColor(change.color);
    workspace.setSetting(
      BADGE_COLOR_SETTING,
      color === null ? undefined : (color.preset ?? color.hex),
    );
  }
  if ('glyph' in change) {
    const glyph = change.glyph === null ? null : parseBadgeGlyph(change.glyph);
    workspace.setSetting(BADGE_GLYPH_SETTING, glyph === null ? undefined : { ...glyph });
  }
}

/** A notebook's badge as it changes (its settings, its name); null without a notebook. */
export function useNotebookBadge(source: Source | null): NotebookBadgeValue | null {
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!source) return () => undefined;
      const offWorkspace = source.workspace.subscribe(listener);
      const offInfo = source.onInfo(listener);
      return () => {
        offWorkspace();
        offInfo();
      };
    },
    [source],
  );
  // A string key, so the snapshot is stable between changes that leave the badge as it is.
  const read = () => {
    if (!source) return '';
    const settings = source.workspace.settings();
    return JSON.stringify([
      source.id,
      source.name,
      settings[BADGE_COLOR_SETTING] ?? null,
      settings[BADGE_GLYPH_SETTING] ?? null,
    ]);
  };
  const key = useSyncExternalStore(subscribe, read, read);
  return useMemo(() => {
    if (!key) return null;
    const [id, name, color, glyph] = JSON.parse(key) as [string, string, unknown, unknown];
    return badgeOf(id, name, {
      [BADGE_COLOR_SETTING]: color ?? undefined,
      [BADGE_GLYPH_SETTING]: glyph ?? undefined,
    });
  }, [key]);
}
