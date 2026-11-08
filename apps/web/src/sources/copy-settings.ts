import { QUICK_ACCESS_SETTING } from '@penmoss/core/quick-access';

/**
 * Settings copied from one notebook to another (Quanta feedback 3, item 10; A1137): the
 * primary notebook's theme, display, shortcuts and the rest, written into another notebook so
 * it reads the same if it becomes the primary, or on a device where it is. Quick Access is not
 * copied: its pins are the primary notebook's own notes.
 */
export const NOT_COPIED: ReadonlySet<string> = new Set([QUICK_ACCESS_SETTING]);

export interface SettingsHolder {
  settings(): Record<string, unknown>;
  setSetting(key: string, value: unknown): void;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Makes `to`'s settings `from`'s: each one that differs is written, and each `from` does not
 * have is removed. Returns how many changed (0 when they already match, so nothing commits).
 */
export function copySettings(from: SettingsHolder, to: SettingsHolder): number {
  const source = from.settings();
  const target = to.settings();
  let changed = 0;
  for (const [key, value] of Object.entries(source)) {
    if (NOT_COPIED.has(key) || same(target[key], value)) continue;
    to.setSetting(key, value);
    changed += 1;
  }
  for (const key of Object.keys(target)) {
    if (NOT_COPIED.has(key) || key in source) continue;
    to.setSetting(key, undefined);
    changed += 1;
  }
  return changed;
}

/** This Mac's choice to keep every other notebook's settings in step with the primary's. */
export const IN_STEP_KEY = 'penmoss.settingsInStep';

export function readInStep(storage: Pick<Storage, 'getItem'> | null): boolean {
  try {
    return storage?.getItem(IN_STEP_KEY) === 'true';
  } catch {
    return false;
  }
}

export function writeInStep(storage: Pick<Storage, 'setItem' | 'removeItem'> | null, on: boolean) {
  try {
    if (on) storage?.setItem(IN_STEP_KEY, 'true');
    else storage?.removeItem(IN_STEP_KEY);
  } catch {
    // Private mode: the choice lasts this session only.
  }
}
