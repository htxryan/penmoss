/**
 * Synced settings that belong to no feature module of their own (A827, A1014): the Journal's time
 * zone and templates, where Quick Capture starts, full-width notes and the note's title-bar
 * buttons. Each key has its reader, which gives the value typed, or the default when it is unset
 * or unreadable. The other keys live beside what reads them: `fonts.ts`, `display.ts`,
 * `line-symbols.ts`, `quick-access.ts`, `sidebar-layout.ts`, `note-metadata.ts`, `tooltips.ts`,
 * `copy-to-notebook.ts`, and the theme's in `@penmoss/ui/theme`. Android's
 * `apps/android/contract/settings-v1.json` lists the keys a phone reads, with their defaults.
 *
 * Which settings are the notebook's own and which a device's is `isNotebookSetting`, here; where
 * each is kept is `@penmoss/model`'s (`NOTEBOOK_MAP`, `DEVICE_MAP`, `mergedSettings`).
 */
import {
  DEFAULT_DAILY_TEMPLATE,
  DEFAULT_TIME_ZONE,
  DEFAULT_WEEKLY_TEMPLATE,
  isTimeZone,
  type PeriodKind,
} from './periodic';

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

/**
 * A git notebook's own settings (A827): the same in every client of the notebook, kept in its
 * notebook map. Its badge (PEN-140, A1504: `badge.color`, `badge.glyph`) is one: it names the
 * notebook on every Mac. Every other key is a device's.
 */
export function isNotebookSetting(key: string): boolean {
  return key === TIME_ZONE_SETTING || key.startsWith('template.') || key.startsWith('badge.');
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

/** The full-width setting: true only for `true`; null while unset (the device's copy shows). */
export function fullWidthOf(settings: Settings): boolean | null {
  const value = settings[FULL_WIDTH_SETTING];
  return value === undefined ? null : value === true;
}
