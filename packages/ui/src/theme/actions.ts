/**
 * Changing themes through the synced settings (T28): any store of per-user
 * settings (the web app's Workspace, the Mac app's).
 */
import {
  builtInTheme,
  deletedTheme,
  duplicateTheme,
  newCustomThemeId,
  parseTheme,
  storedTheme,
} from './schema';
import { customThemeKey, MODE_SETTING, THEME_SETTING } from './settings';
import type { Theme, ThemeMode, ThemeVariant } from './tokens';

export interface ThemeSettingsStore {
  settings(): Record<string, unknown>;
  setSetting(key: string, value: unknown): void;
}

export function chooseTheme(store: ThemeSettingsStore, id: string): void {
  store.setSetting(THEME_SETTING, id);
}

export function setThemeMode(store: ThemeSettingsStore, mode: ThemeMode): void {
  store.setSetting(MODE_SETTING, mode);
}

/** Dark when `shown` is light, light when it is dark (leaving System). */
export function toggleDarkMode(store: ThemeSettingsStore, shown: ThemeVariant): void {
  setThemeMode(store, shown === 'dark' ? 'light' : 'dark');
}

/**
 * Saves a custom theme as a merge onto what is stored now (A250): only what
 * changed since `start` (the theme when the edit began) is written, so other
 * devices' edits and fields a newer build stored are kept (A20). Returns the
 * theme as saved, or null when it was deleted since the edit began (an edit
 * never brings a deleted theme back).
 */
export function saveCustomTheme(
  store: ThemeSettingsStore,
  theme: Theme,
  start?: Theme,
): Theme | null {
  if (builtInTheme(theme.id)) throw new Error('Built-in themes cannot be changed');
  const key = customThemeKey(theme.id);
  const previous = store.settings()[key];
  if (start && !parseTheme(previous)) return null;
  const stored = storedTheme(theme, previous, start);
  store.setSetting(key, stored);
  return parseTheme(stored)?.theme ?? null;
}

/** A new custom theme copied from `source`, saved and chosen. */
export function duplicateAndChoose(
  store: ThemeSettingsStore,
  source: Theme,
  existingNames: readonly string[] = [],
): Theme {
  let name = `${source.name} copy`;
  for (let n = 2; existingNames.includes(name); n++) name = `${source.name} copy ${n}`;
  const theme = duplicateTheme(source, newCustomThemeId(), name);
  saveCustomTheme(store, theme);
  chooseTheme(store, theme.id);
  return theme;
}

/**
 * Deletes a custom theme; if it was chosen, its base built-in is chosen
 * instead. The key keeps `{ id, base, deleted }`, so a device that still
 * chooses it shows its base, and a pending edit knows it is gone.
 */
export function deleteCustomTheme(store: ThemeSettingsStore, theme: Theme): void {
  const chosen = store.settings()[THEME_SETTING] === theme.id;
  store.setSetting(customThemeKey(theme.id), deletedTheme(theme));
  if (chosen) chooseTheme(store, theme.base ?? 'penmoss');
}
