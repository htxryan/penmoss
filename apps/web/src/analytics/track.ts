/**
 * What the page records by name (PEN-137): each command run, each screen, each tracked click
 * and each allowlisted setting. Everything goes through `record()`, which drops a name the
 * catalogue doesn't know; nothing here reads a note, a title, a path or anything typed.
 */
import {
  KEYS_PATTERN,
  SCREEN_NAMES,
  SETTING_NAMES,
  settingValueProps,
  themeForEvent,
  type PropValue,
} from '@penmoss/core/analytics';
import { CUSTOM_FONT_PREFIX } from '@penmoss/core/fonts';
import { installClickListener } from '@penmoss/ui/analytics/clicks';
import type { Route } from '../router';
import { record } from './record';

/** How a command came to run, as the catalogue names it. */
const COMMAND_SOURCES = ['key', 'palette', 'button', 'menu', 'tray', 'hotkey', 'editor'] as const;
export type CommandSource = (typeof COMMAND_SOURCES)[number];
const SOURCES: ReadonlySet<string> = new Set<CommandSource>(COMMAND_SOURCES);

/** The editor's key names where the event format spells them out ("Up" → "ArrowUp"). */
const ARROWS: Readonly<Record<string, string>> = {
  Up: 'ArrowUp',
  Down: 'ArrowDown',
  Left: 'ArrowLeft',
  Right: 'ArrowRight',
};

/** A normalised combination ("Mod+Alt+N") as the event format writes it, or null when it can't. */
export function keysForEvent(combo: string): string | null {
  const parts = combo.split(/\+(?!$)/);
  const key = parts.pop() ?? '';
  const written = [...parts, ARROWS[key] ?? key].join('+');
  return KEYS_PATTERN.test(written) ? written : null;
}

export interface CommandRun {
  readonly id: string;
  readonly source: string;
  readonly ran: boolean;
  /** The combination that ran it, for a key (or a menu shortcut). */
  readonly combo?: string | undefined;
  /** Whether that combination is the person's own binding. */
  readonly custom?: boolean | undefined;
}

/** Records one command run: its id, where it came from and whether it ran. */
export function recordCommand(run: CommandRun): void {
  const keys = run.combo === undefined ? null : keysForEvent(run.combo);
  record('command', run.id, {
    source: SOURCES.has(run.source) ? run.source : 'other',
    ran: run.ran,
    ...(keys === null ? {} : { keys, custom: run.custom ?? false }),
  });
}

const SCREENS: ReadonlySet<string> = new Set(SCREEN_NAMES);

/** What kind of screen a route shows: never the route itself, never an id. Null: not a screen. */
export function screenKindOf(route: Route): string | null {
  switch (route.name) {
    case 'home':
    case 'note':
    case 'graph':
    case 'trash':
    case 'tags':
    case 'time-machine':
      return route.name;
    case 'window':
      return 'note';
    case 'settings': {
      const section: string = route.section;
      const kind =
        route.item === undefined
          ? `settings.${section}`
          : section === 'git-notebooks'
            ? 'settings.git-notebook'
            : section === 'privacy' && route.item === 'data'
              ? 'settings.privacy-data'
              : `settings.${section}`;
      return SCREENS.has(kind) ? kind : 'settings';
    }
    case 'not-found':
      return null;
  }
}

let lastScreen: string | null = null;

/** Records a screen when the kind on show changes, with the one before it. */
export function recordScreen(kind: string | null): void {
  if (kind === null || kind === lastScreen) return;
  const from = lastScreen;
  lastScreen = kind;
  record('screen', kind, from === null ? {} : { from });
}

/** Forgets the screen on show (tests). */
export function resetScreens(): void {
  lastScreen = null;
}

/**
 * The tracked clicks (PEN-137): each use of a `[data-event]` control records `click <id>`, a
 * switch's or a checkbox's with which way it went (`state: on|off`), a select's or a slider's
 * once per change, never its value (PEN-175). The listener is @penmoss/ui's, which Android's
 * editor page installs too, so both record the same controls the same way.
 */
export function installClickTracking(doc: Document): () => void {
  return installClickListener(doc, (id, state) =>
    record('click', id, state === undefined ? {} : { state }),
  );
}

const SETTINGS: ReadonlySet<string> = new Set(SETTING_NAMES);
/** The keyboard shortcuts' settings (`keys.<command id>`): one name for all of them. */
const BINDING_PREFIX = 'keys.';
const FONT_KEYS: ReadonlySet<string> = new Set(['font.interface', 'font.note']);

/** Settings copied between notebooks (A1137) are the person's one change, recorded once. */
let quiet = 0;

/** Runs `write` without recording the settings it writes (a copy, not a person's change). */
export function withoutRecording<T>(write: () => T): T {
  quiet++;
  try {
    return write();
  } finally {
    quiet--;
  }
}

/** A text setting's value as an event may say it: a custom theme or font is `custom`. */
function settingWord(key: string, value: string): string {
  if (key === 'theme.id') return themeForEvent(value);
  if (FONT_KEYS.has(key) && value.startsWith(CUSTOM_FONT_PREFIX)) return 'custom';
  return value;
}

/**
 * What a setting's change records: its value when that is safe to send, else `changed`. Text is
 * sent only when it is one of the words core lists for that setting (SETTING_VALUES); any
 * other text (a time zone, a template, a font's family) records `changed: true`. Core's
 * `settingValueProps`, which the Mac's main process uses too, after a custom theme or font
 * becomes `custom`.
 */
export function settingProps(key: string, value: unknown): Record<string, PropValue> {
  return settingValueProps(key, typeof value === 'string' ? settingWord(key, value) : value);
}

/** Records a change to a setting the catalogue lists; any other setting records nothing. */
export function recordSetting(key: string, value: unknown): void {
  if (quiet > 0) return;
  const name = key.startsWith(BINDING_PREFIX) ? 'shortcuts.custom' : key;
  if (!SETTINGS.has(name)) return;
  record(
    'setting',
    name,
    name === 'shortcuts.custom' ? { changed: true } : settingProps(key, value),
  );
}
