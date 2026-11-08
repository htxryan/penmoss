/**
 * Key combinations (T20) as strings like `Mod+Shift+E`, the prototype's
 * format: modifiers in a fixed order (Mod, Ctrl, Alt, Shift), then one key.
 * `Mod` is ⌘ on Apple devices and Ctrl elsewhere; `Ctrl` is the Control key
 * on Apple devices only (elsewhere it is `Mod`). Letters are read from
 * `KeyboardEvent.code`, so ⌥ on macOS (which changes `key`) and keyboard
 * layouts do not change the combination.
 */

export const isApplePlatform = (): boolean =>
  typeof navigator !== 'undefined' &&
  /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

const MODIFIER_ORDER = ['Mod', 'Ctrl', 'Alt', 'Shift'] as const;
type Modifier = (typeof MODIFIER_ORDER)[number];

const CODE_KEYS: Readonly<Record<string, string>> = {
  Slash: '/',
  Period: '.',
  Comma: ',',
  Backslash: '\\',
  BracketLeft: '[',
  BracketRight: ']',
  Semicolon: ';',
  Quote: "'",
  Minus: '-',
  Equal: '=',
  Backquote: '`',
  Space: 'Space',
  Enter: 'Enter',
  NumpadEnter: 'Enter',
  Escape: 'Escape',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
};

const MODIFIER_KEYS = new Set(['Meta', 'Control', 'Alt', 'Shift', 'OS', 'AltGraph', 'CapsLock']);

export interface KeyLike {
  readonly key: string;
  readonly code: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
}

/** The key part of an event (`E`, `1`, `/`, `Up`, `F2`), or null for a lone modifier. */
function keyOf(event: KeyLike): string | null {
  if (MODIFIER_KEYS.has(event.key)) return null;
  if (/^Key[A-Z]$/.test(event.code)) return event.code.slice(3);
  if (/^Digit\d$/.test(event.code)) return event.code.slice(5);
  if (/^Numpad\d$/.test(event.code)) return event.code.slice(6);
  const named = CODE_KEYS[event.code];
  if (named) return named;
  if (/^F\d{1,2}$/.test(event.code)) return event.code;
  if (event.key.length === 1) return event.key === ' ' ? 'Space' : event.key.toUpperCase();
  return event.key || null;
}

/** The combination an event stands for, or null for a lone modifier. */
export function comboFromEvent(event: KeyLike, apple: boolean = isApplePlatform()): string | null {
  const key = keyOf(event);
  if (!key) return null;
  const parts: string[] = [];
  if (apple ? event.metaKey : event.ctrlKey) parts.push('Mod');
  if (apple && event.ctrlKey) parts.push('Ctrl');
  // A Windows or Super key elsewhere: never part of an app shortcut.
  if (!apple && event.metaKey) parts.push('Meta');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  parts.push(key);
  return parts.join('+');
}

/** Splits a combination into its modifiers and key (`+` may itself be the key: `Mod++`). */
export function parseCombo(combo: string): { modifiers: Modifier[]; key: string } {
  const parts = combo.split(/\+(?!$)/);
  const key = parts.pop() ?? '';
  const modifiers = parts
    .map((part) => MODIFIER_ORDER.find((name) => name.toLowerCase() === part.toLowerCase()))
    .filter((part): part is Modifier => part !== undefined);
  return { modifiers, key };
}

/** A combination in canonical form: known modifiers in order, letters upper-case. */
export function normaliseCombo(combo: string): string {
  const { modifiers, key } = parseCombo(combo.trim());
  const ordered = MODIFIER_ORDER.filter((modifier) => modifiers.includes(modifier));
  return [...ordered, key.length === 1 ? key.toUpperCase() : key].join('+');
}

/**
 * A ProseMirror/TipTap key name (`Mod-Shift-e`, `Alt-Shift-ArrowUp`) as a
 * combination. An upper-case letter there means the same key with Caps Lock
 * on (TipTap binds `Mod-b` and `Mod-B`), not an extra Shift.
 */
export function comboFromKeymapName(name: string): string {
  const parts = name.split(/-(?!$)/);
  const key = parts.pop() ?? '';
  const modifiers = parts.map((part) => {
    if (part === 'Cmd' || part === 'Meta' || part === 'm') return 'Mod';
    if (part === 'Control' || part === 'c') return 'Ctrl';
    if (part === 'a') return 'Alt';
    if (part === 's') return 'Shift';
    return part;
  });
  const named: Record<string, string> = {
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    ' ': 'Space',
  };
  return normaliseCombo([...modifiers, named[key] ?? key].join('+'));
}

const APPLE_GLYPHS: Readonly<Record<string, string>> = {
  Mod: '⌘',
  Ctrl: '⌃',
  Alt: '⌥',
  Shift: '⇧',
  Up: '↑',
  Down: '↓',
  Left: '←',
  Right: '→',
  Enter: '↵',
  Escape: 'Esc',
  Backspace: '⌫',
  Delete: '⌦',
};
const OTHER_NAMES: Readonly<Record<string, string>> = {
  Mod: 'Ctrl',
  Up: '↑',
  Down: '↓',
  Left: '←',
  Right: '→',
  Escape: 'Esc',
};

/** The parts of a combination as shown on keycaps: `['⌘', '⇧', 'E']` or `['Ctrl', 'Shift', 'E']`. */
export function comboParts(combo: string, apple: boolean = isApplePlatform()): string[] {
  const { modifiers, key } = parseCombo(combo);
  const names = apple ? APPLE_GLYPHS : OTHER_NAMES;
  return [...modifiers, key].map((part) => names[part] ?? part);
}

/** A combination as text: `⌘⇧E` on Apple devices, `Ctrl+Shift+E` elsewhere. */
export function formatCombo(combo: string, apple: boolean = isApplePlatform()): string {
  return comboParts(combo, apple).join(apple ? '' : '+');
}

/** `aria-keyshortcuts` for combinations: `Meta+Shift+E` on Apple devices, `Control+Shift+E` elsewhere. */
export function ariaKeyShortcuts(
  combos: readonly string[],
  apple: boolean = isApplePlatform(),
): string {
  return combos
    .map((combo) => {
      const { modifiers, key } = parseCombo(combo);
      const names: Record<string, string> = {
        Mod: apple ? 'Meta' : 'Control',
        Ctrl: 'Control',
        Up: 'ArrowUp',
        Down: 'ArrowDown',
        Left: 'ArrowLeft',
        Right: 'ArrowRight',
      };
      return [...modifiers, key].map((part) => names[part] ?? part).join('+');
    })
    .join(' ');
}

/**
 * Keys that copy, paste, undo, find or edit text: never a binding for another
 * command, wherever it comes from (Settings, or another device over sync), so
 * no binding can take typing or the clipboard away. A command whose own
 * default is one of them (Undo, Redo) keeps it. `Ctrl+…` is a Mac's Control
 * key: the Cocoa text keys (line start and end, kill, delete, …).
 */
export const RESERVED_COMBOS: ReadonlySet<string> = new Set([
  'Mod+C',
  'Mod+V',
  'Mod+X',
  'Mod+A',
  'Mod+Z',
  'Mod+Shift+Z',
  'Mod+Y',
  'Mod+F',
  'Mod+R',
  ...[...'AEKDHNPBF'].map((letter) => `Ctrl+${letter}`),
]);

/** Why a combination cannot be a binding on this platform. */
export type BindingProblem = 'types' | 'altgr' | 'reserved';

/** A key that types a character (a letter, digit, punctuation or Space). */
const printable = (key: string) => key.length === 1 || key === 'Space';

/**
 * Why a combination may not be bound on this platform, or null when it may.
 * It needs Mod or Ctrl, or Alt, or is a function key, so typing never
 * triggers a command (`types`); ⌥ with a printable key types on a Mac, so it
 * needs ⌘ or ⌃ there; Ctrl+Alt with a printable key is AltGr on Windows,
 * which types on many layouts (`altgr`: Polish ń is AltGr+N, German } is
 * AltGr+0); clipboard and editing keys stay theirs (`reserved`).
 */
export function bindingProblem(
  combo: string,
  apple: boolean = isApplePlatform(),
): BindingProblem | null {
  const normalised = normaliseCombo(combo);
  const { modifiers, key } = parseCombo(normalised);
  if (!key) return 'types';
  if (RESERVED_COMBOS.has(normalised)) return 'reserved';
  if (/^F\d{1,2}$/.test(key)) return null;
  const command = modifiers.includes('Mod') || modifiers.includes('Ctrl');
  const alt = modifiers.includes('Alt');
  if (!command && !alt) return 'types';
  if (!printable(key)) return null;
  if (apple && alt && !command) return 'types';
  if (!apple && alt && modifiers.includes('Mod')) return 'altgr';
  return null;
}

/** Whether a combination may be bound on this platform (see `bindingProblem`). */
export function bindable(combo: string, apple: boolean = isApplePlatform()): boolean {
  return bindingProblem(combo, apple) === null;
}

/**
 * Whether a key event was typed with AltGr (Windows reports it as Ctrl+Alt):
 * it types a character, so it is never a shortcut.
 */
export function isAltGraph(event: {
  readonly getModifierState?: (key: string) => boolean;
}): boolean {
  try {
    return event.getModifierState?.('AltGraph') === true;
  } catch {
    return false;
  }
}

/** `apple` on Apple platforms, else `other` (per-platform default keys). */
export const applePlatformOr = <T>(apple: T, other: T): T => (isApplePlatform() ? apple : other);

/**
 * Combinations the browser keeps for itself on the web build: binding them
 * would never fire. (Mod+Shift+W, the plan's "this week", closes the window
 * in Chrome too; it stays a default for the Mac app, beside Mod+Alt+W.)
 */
export const BROWSER_RESERVED: ReadonlySet<string> = new Set([
  'Mod+T',
  'Mod+W',
  'Mod+N',
  'Mod+Q',
  'Mod+Shift+T',
  'Mod+Shift+N',
  'Mod+Tab',
  'Mod+Shift+Tab',
]);

/** Synced settings hold each command's bindings under this prefix: `keys.<command id>` (A70). */
export const BINDING_PREFIX = 'keys.';

/**
 * The bindings this device can use (A90), shared by the web, the Mac app and the Android
 * editor page (T40 P9, A490): combinations are normalised, and one that would type, take the
 * clipboard or an editing key, or is AltGr here is dropped, unless it is the command's own
 * default. Bindings arrive by sync from other devices and agents, so they are checked whenever
 * they are read, not only in Settings. A command left with none of its combinations keeps its
 * defaults; `[]` (no shortcut, by choice) stays.
 */
export function usableBindings(
  raw: Readonly<Record<string, unknown>>,
  defaultsOf: (id: string) => readonly string[] | undefined,
  apple: boolean = isApplePlatform(),
): Record<string, readonly string[]> {
  const out: Record<string, readonly string[]> = {};
  for (const [id, value] of Object.entries(raw)) {
    if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) continue;
    const defaults = defaultsOf(id) ?? [];
    const kept = [...new Set(value.map((combo) => normaliseCombo(combo)))].filter(
      (combo) => defaults.includes(combo) || bindable(combo, apple),
    );
    if (value.length > 0 && kept.length === 0) continue;
    out[id] = kept;
  }
  return out;
}

/** The `keys.<id>` entries of a user's settings, by command id (unchecked: see `usableBindings`). */
export function rawBindings(settings: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const raw: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(settings)) {
    if (key.startsWith(BINDING_PREFIX)) raw[key.slice(BINDING_PREFIX.length)] = value;
  }
  return raw;
}

/** A command id as `keys.<id>` may name one (`app.palette`, `editor.insert.callout-tip`, `copy-markdown`). */
export const COMMAND_ID_PATTERN = /^[A-Za-z][A-Za-z0-9-]*(\.[A-Za-z0-9-]+)*$/;

/** At most this many combinations for one command, and characters for one combination (A491). */
export const MAX_COMBOS_PER_COMMAND = 4;
export const MAX_COMBO_CHARS = 40;

/** The keys a combination may end in: what `comboFromEvent` reports for a real key. */
const NAMED_KEYS: ReadonlySet<string> = new Set(Object.values(CODE_KEYS));
const isComboKey = (key: string) =>
  /^[A-Z0-9]$/.test(key) ||
  /^F([1-9]|1\d|2[0-4])$/.test(key) ||
  NAMED_KEYS.has(key) ||
  (key.length === 1 && key.trim() === key);

/**
 * Why `value` cannot be stored as a command's bindings, or null when it can (T40 P9, A491): a
 * list of at most four combinations, each in canonical form (`normaliseCombo`) with a key a
 * keyboard reports. It is the shape only, the same on every platform, because a binding made
 * on a Mac (⌘⌥N) is stored for the Mac and only dropped where it cannot be used (A90). Each
 * device still checks what it reads (`usableBindings`). `[]` (no shortcut) is a binding.
 */
export function bindingValueProblem(value: unknown): string | null {
  if (!Array.isArray(value)) return 'must be a list of key combinations';
  if (value.length > MAX_COMBOS_PER_COMMAND)
    return `must have at most ${MAX_COMBOS_PER_COMMAND} combinations`;
  const seen = new Set<string>();
  for (const combo of value as unknown[]) {
    if (typeof combo !== 'string' || combo.length === 0 || combo.length > MAX_COMBO_CHARS)
      return `must be combinations of at most ${MAX_COMBO_CHARS} characters`;
    const { modifiers, key } = parseCombo(combo);
    if (combo.split(/\+(?!$)/).length !== modifiers.length + 1 || normaliseCombo(combo) !== combo)
      return `${combo} is not a combination like Mod+Shift+E`;
    if (!isComboKey(key)) return `${combo} does not end in a key`;
    if (seen.has(combo)) return `${combo} is listed twice`;
    seen.add(combo);
  }
  return null;
}
