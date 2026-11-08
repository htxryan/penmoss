/**
 * The capture window's system-wide hotkey (T30, A226). The default is
 * ⌃⌥⌘N on a Mac: macOS and the common Mac apps leave ⌃⌥⌘ combinations
 * alone (⌘⇧Space is 1Password's, ⌥Space Raycast's and Alfred's, ⌃⌥Space
 * switches input sources), and N is for note. It can be changed in Settings →
 * Keyboard shortcuts; the choice is this Mac's own (preferences.json), not a
 * synced setting, since a hotkey free on one machine may be taken on another.
 *
 * A system-wide hotkey takes its keys from every app, so it passes A90's
 * checks as well as needing two modifiers: never the clipboard, undo, find or
 * a Mac's Control-key text editing, and never Ctrl+Alt with a printable key
 * off a Mac (AltGr types there). Only the Settings page may change it, after
 * a key press or click there, a few times a minute (`HotkeyChangeGate`).
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { bindingProblem } from '@penmoss/editor/keys';
import { parseWindowTheme, type WindowTheme } from './theme';

export function defaultCaptureHotkey(platform: NodeJS.Platform): string {
  // Off a Mac (the tests' Linux), Ctrl+Alt+letter is AltGr (A90): Ctrl+Shift+Space instead.
  return platform === 'darwin' ? 'Control+Alt+Command+N' : 'Control+Shift+Space';
}

/**
 * Whether a successful `globalShortcut.register` means the keys are ours. On
 * macOS it can succeed while the system or another app still takes the keys
 * first, so Settings says the hotkey may be in use elsewhere.
 */
export function registrationCertain(platform: NodeJS.Platform): boolean {
  return platform !== 'darwin';
}

const MODIFIERS = new Map([
  ['command', 'Command'],
  ['cmd', 'Command'],
  ['commandorcontrol', 'CommandOrControl'],
  ['cmdorctrl', 'CommandOrControl'],
  ['control', 'Control'],
  ['ctrl', 'Control'],
  ['alt', 'Alt'],
  ['option', 'Alt'],
  ['shift', 'Shift'],
  ['super', 'Super'],
] as const);
const KEYS =
  /^(?:[A-Z0-9]|F(?:[1-9]|1\d|2[0-4])|Space|Return|Enter|Up|Down|Left|Right|Plus|[/,.;'`\-=[\]\\])$/;

/** An accelerator as a registry combination (`Mod+Alt+N`, @penmoss/editor/keys) on `platform`. */
function asCombo(modifiers: readonly string[], key: string, apple: boolean): string {
  const names = modifiers.map((name) => {
    if (name === 'Control') return apple ? 'Ctrl' : 'Mod';
    if (name === 'Alt' || name === 'Shift') return name;
    return 'Mod'; // Command, CommandOrControl, Super: the platform's command key
  });
  const KEY_NAMES: Record<string, string> = { Return: 'Enter', Plus: '+' };
  return [...new Set(names), KEY_NAMES[key] ?? key].join('+');
}

/**
 * A hotkey in canonical form (`Control+Alt+Command+N`), or an error. It must
 * have two modifiers or more, not only Shift and Alt (those type characters),
 * so it can never take ordinary typing in other apps, and pass A90's checks
 * on `platform` (`bindingProblem`).
 */
export function normaliseHotkey(
  input: string,
  platform: NodeJS.Platform,
): { accelerator: string } | { error: string } {
  const parts = input
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean);
  const key = parts.pop();
  if (!key) return { error: 'Type a shortcut such as Control+Alt+Command+N' };
  const modifiers: string[] = [];
  for (const part of parts) {
    const name = MODIFIERS.get(part.toLowerCase() as never);
    if (!name) return { error: `${part} is not a modifier (Command, Control, Alt, Shift)` };
    if (!modifiers.includes(name)) modifiers.push(name);
  }
  const keyName = key.length === 1 ? key.toUpperCase() : key[0]!.toUpperCase() + key.slice(1);
  if (!KEYS.test(keyName)) return { error: `${key} is not a key a shortcut can use` };
  const strong = modifiers.filter((name) => name !== 'Shift' && name !== 'Alt');
  if (modifiers.length < 2 || strong.length === 0) {
    return { error: 'Use at least two modifiers, one of them Command or Control' };
  }
  const order = ['CommandOrControl', 'Command', 'Control', 'Super', 'Alt', 'Shift'];
  modifiers.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const accelerator = [...modifiers, keyName].join('+');
  const problem = bindingProblem(
    asCombo(modifiers, keyName, platform === 'darwin'),
    platform === 'darwin',
  );
  if (problem === 'reserved') {
    return { error: `${accelerator} copies, pastes, undoes or edits text: Penmoss keeps it free` };
  }
  if (problem === 'altgr') {
    return { error: `${accelerator} is AltGr on many keyboards and types a character` };
  }
  if (problem) return { error: `${accelerator} would take typing` };
  return { accelerator };
}

/**
 * Who may change the hotkey (T29 review): the Settings page (Keyboard
 * shortcuts), just after a key press or click there, at most PER_MINUTE
 * times a minute, so a script in the page cannot quietly take a shortcut.
 */
export class HotkeyChangeGate {
  static readonly PER_MINUTE = 5;
  private readonly recent: number[] = [];

  /** Null when the change may go ahead (and counts it), else why not. */
  check(request: {
    readonly url: string;
    readonly gesture: boolean;
    readonly now: number;
  }): string | null {
    if (!/^app:\/\/penmoss\/settings(?:[/?#]|$)/.test(request.url) || !request.gesture) {
      return 'Change the capture shortcut in Settings → Keyboard Shortcuts';
    }
    while (this.recent.length > 0 && request.now - this.recent[0]! >= 60_000) this.recent.shift();
    if (this.recent.length >= HotkeyChangeGate.PER_MINUTE) {
      return 'Too many changes at once; try again in a minute';
    }
    this.recent.push(request.now);
    return null;
  }
}

export interface Preferences {
  readonly captureHotkey?: string;
  /** The page's theme, for the windows' background (T28). */
  readonly windowTheme?: WindowTheme;
  /**
   * The compact title bar (T47, A724): this Mac's own choice, never synced. Absent is on, the
   * default; only `false` turns it off.
   */
  readonly compactTitleBar?: boolean;
  /**
   * The menu bar icon (T51 item 17, A945): this Mac's own choice, never synced. Absent is on,
   * the default since T53 (item 6, A976); only `false` hides it.
   */
  readonly menuBarIcon?: boolean;
}

export function loadPreferences(file: string): Preferences {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    const windowTheme = parseWindowTheme(raw['windowTheme']);
    return {
      ...(typeof raw['captureHotkey'] === 'string' ? { captureHotkey: raw['captureHotkey'] } : {}),
      ...(windowTheme ? { windowTheme } : {}),
      ...(typeof raw['compactTitleBar'] === 'boolean'
        ? { compactTitleBar: raw['compactTitleBar'] }
        : {}),
      ...(typeof raw['menuBarIcon'] === 'boolean' ? { menuBarIcon: raw['menuBarIcon'] } : {}),
    };
  } catch {
    return {};
  }
}

export function savePreferences(file: string, preferences: Preferences): void {
  const temp = `${file}.tmp`;
  writeFileSync(temp, JSON.stringify(preferences), { mode: 0o600 });
  renameSync(temp, file);
}

/**
 * Where focus goes when the capture window closes (T30; T39 pass 3 review, A904). On a Mac the
 * app hides, so focus goes back to the app the hotkey was pressed in, unless a Penmoss window had
 * it. A capture opened while the app was starting is the exception: when Ryan opened Penmoss
 * himself, hiding the app would hide the main window he had just opened, so it gets the focus
 * instead; when it started on its own (at login), it hides again as before.
 */
export function afterCapture(state: {
  readonly mac: boolean;
  readonly focusedBefore: boolean;
  readonly openedWhileStarting: boolean;
  readonly startedOnItsOwn: boolean;
}): 'hide-app' | 'focus-before' | 'focus-main' | 'nothing' {
  if (!state.mac) return 'nothing';
  if (state.focusedBefore) return 'focus-before';
  if (state.openedWhileStarting && !state.startedOnItsOwn) return 'focus-main';
  return 'hide-app';
}

/** Launches kept in the launch log (A904). */
const LAUNCHES_KEPT = 20;

/**
 * The launch log with this launch added (A904): how macOS says the app started, from
 * `app.getLoginItemSettings()` (its plain values only), so a Mac run can check that
 * `wasOpenedAtLogin` is reliable. A debug log in the app's logs folder; the last 20 launches.
 */
export function launchLog(previous: string, settings: object, at: Date): string {
  const values = Object.entries(settings)
    .filter(([, value]) => ['boolean', 'string', 'number'].includes(typeof value))
    .map(([key, value]) => `${key}=${String(value)}`);
  const line = `${at.toISOString()} launch: ${values.join(' ')} (A904)`;
  const lines = [...previous.split('\n').filter((one) => one !== ''), line];
  return `${lines.slice(-LAUNCHES_KEPT).join('\n')}\n`;
}

/** Adds this launch to the launch log file (A904); a log that cannot be written is skipped. */
export function writeLaunchLog(file: string, settings: object, at: Date): void {
  let previous = '';
  try {
    previous = readFileSync(file, 'utf8');
  } catch {
    // The first launch with the log.
  }
  const temp = `${file}.tmp`;
  writeFileSync(temp, launchLog(previous, settings, at), { mode: 0o600 });
  renameSync(temp, file);
}
