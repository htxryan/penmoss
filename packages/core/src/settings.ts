/**
 * Synced settings that belong to no feature module of their own (A827, A1014): the Journal's time
 * zone and templates, where Quick Capture starts, full-width notes and the note's title-bar
 * buttons, the empty window's dad jokes. Each key has its reader, which gives the value typed, or the default when it is unset
 * or unreadable. The other keys live beside what reads them: `fonts.ts`, `display.ts`,
 * `line-symbols.ts`, `quick-access.ts`, `sidebar-layout.ts`, `note-metadata.ts`, `tooltips.ts`,
 * `copy-to-notebook.ts`, and the theme's in `@penmoss/ui/theme`. Android's
 * `apps/android/contract/settings-v1.json` lists the keys a phone reads, with their defaults.
 *
 * Which settings are the notebook's own and which a device's is `isNotebookSetting`, here; where
 * each is kept is `@penmoss/model`'s (`NOTEBOOK_MAP`, `DEVICE_MAP`, `mergedSettings`).
 */
import { DISPLAY_SETTING_KEYS } from './display';
import { FONT_SETTING_KEYS } from './fonts';
import {
  DEFAULT_DAILY_TEMPLATE,
  DEFAULT_TIME_ZONE,
  DEFAULT_WEEKLY_TEMPLATE,
  isTimeZone,
  type PeriodKind,
} from './periodic';
import {
  HIDDEN_SECTIONS_SETTING,
  QUICK_ACCESS_NOTEBOOK_SETTING,
  RECENT_COUNT_SETTING,
  SECTION_ORDER_SETTING,
} from './sidebar-layout';

type Settings = Readonly<Record<string, unknown>>;

/** The Journal's time zone (A77): an IANA name. */
export const TIME_ZONE_SETTING = 'timeZone';
/** A period note's template (T19). */
export const templateSetting = (kind: PeriodKind): `template.${PeriodKind}` => `template.${kind}`;
/** Where Quick Capture's form starts (A947): `daily` or `inbox`. */
export const CAPTURE_DESTINATION_SETTING = 'capture.destination';
/** Full-width notes (T41, A501): `true`, or the theme's width. */
export const FULL_WIDTH_SETTING = 'note.fullWidth';
/** Whether a button shows in the note's title bar (`noteBar.<button>`). */
export const noteBarSetting = (button: string): string => `noteBar.${button}`;
/** A dad joke heads the empty window (A1576): `false` for Welcome to Penmoss instead. */
export const DAD_JOKES_SETTING = 'home.dadJokes';

/**
 * A git notebook's own settings (A827): the same in every client of the notebook, kept in its
 * notebook map. Its badge (PEN-140, A1504: `badge.color`, `badge.glyph`) is one: it names the
 * notebook on every Mac. Every other key is a device's.
 */
export function isNotebookSetting(key: string): boolean {
  return key === TIME_ZONE_SETTING || key.startsWith('template.') || key.startsWith('badge.');
}

/**
 * The platforms whose devices keep their own copy of the look and layout (PEN-156, A1605): every
 * Mac and browser is `desktop`, every Android phone `mobile`.
 */
export const SETTINGS_PLATFORMS = ['desktop', 'mobile'] as const;
export type SettingsPlatform = (typeof SETTINGS_PLATFORMS)[number];

/**
 * The per-platform keys with no prefix (PEN-156, A1605): the theme and its mode (`@penmoss/ui/theme`'s
 * `THEME_SETTING` and `MODE_SETTING`), the fonts and the note text's size, the sidebar's (Home's)
 * shortcut buttons, its sections' order and visibility, Recent Notes' length and Quick Access's
 * notebook names. Custom themes (`theme.custom.*`) stay shared, so a theme made on one is there
 * to pick on the other.
 */
export const PLATFORM_SETTING_KEYS: readonly string[] = [
  'theme.id',
  'theme.mode',
  ...FONT_SETTING_KEYS,
  ...DISPLAY_SETTING_KEYS,
  SECTION_ORDER_SETTING,
  HIDDEN_SECTIONS_SETTING,
  RECENT_COUNT_SETTING,
  QUICK_ACCESS_NOTEBOOK_SETTING,
];

/** The per-platform keys by prefix: the keyboard shortcuts (`@penmoss/editor/keys`' `keys.<command>`). */
export const PLATFORM_SETTING_PREFIXES: readonly string[] = ['keys.'];

/**
 * A device setting each platform keeps its own copy of (PEN-156, A1605): the Macs one, the phones
 * another, in the primary notebook beside the shared device map. While a platform has no copy of
 * one, the shared value shows. Every other device setting (Daily Notes, Quick Capture, Quick
 * Access pins, Symbols, …) stays shared by every device.
 */
export function isPlatformSetting(key: string): boolean {
  return (
    PLATFORM_SETTING_KEYS.includes(key) ||
    PLATFORM_SETTING_PREFIXES.some((prefix) => key.startsWith(prefix))
  );
}

/** The time zone setting, or the default when unset or unknown here. */
export function timeZoneOf(settings: Settings): string {
  const zone = settings[TIME_ZONE_SETTING];
  return typeof zone === 'string' && isTimeZone(zone) ? zone : DEFAULT_TIME_ZONE;
}

/** A period note's template, or the default when unset (an empty one is kept). */
export function templateOf(settings: Settings, kind: PeriodKind): string {
  const template = settings[templateSetting(kind)];
  if (typeof template === 'string') return template;
  return kind === 'daily' ? DEFAULT_DAILY_TEMPLATE : DEFAULT_WEEKLY_TEMPLATE;
}

export type CaptureDestination = 'daily' | 'inbox';

/** Where Quick Capture's form starts (A947): today's note while unset. */
export function captureDestinationOf(settings: Settings): CaptureDestination {
  return settings[CAPTURE_DESTINATION_SETTING] === 'inbox' ? 'inbox' : 'daily';
}

/** Whether the empty window's heading is a dad joke: on unless turned off (`false`). */
export function dadJokesOf(settings: Settings): boolean {
  return settings[DAD_JOKES_SETTING] !== false;
}

/** The full-width setting: true only for `true`; null while unset (the device's copy shows). */
export function fullWidthOf(settings: Settings): boolean | null {
  const value = settings[FULL_WIDTH_SETTING];
  return value === undefined ? null : value === true;
}
