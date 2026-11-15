/**
 * This Mac's own preferences (preferences.json beside the app's data): the capture hotkey (T30),
 * the windows' theme (T28), the compact title bar (T47) and the menu bar icon (T51). None is
 * synced: each is about this machine. Written whole, through a temp file, readable only by its
 * owner.
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { parseWindowTheme, type WindowTheme } from './theme';

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
