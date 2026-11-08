/**
 * Themes in the per-user synced settings (T28, A17). One key per concern so
 * each merges on its own (two devices changing the mode and the theme both
 * win): `theme.id` the chosen theme, `theme.mode` light, dark or system, and
 * one `theme.custom.<id>` key per custom theme (editing one never touches
 * another). Everything is validated as it is read: an unknown theme id or
 * mode, or a custom theme that does not parse, falls back to Penmoss and the
 * system's mode; a deleted custom theme (its key holds `{ id, base, deleted }`)
 * falls back to the built-in it was based on.
 */
import { BUILT_IN_THEMES, PENMOSS } from './builtins';
import { builtInTheme, deletedThemeBase, isCustomThemeId, parseTheme } from './schema';
import { THEME_MODES, type Theme, type ThemeMode, type ThemeVariant } from './tokens';

export const THEME_SETTING = 'theme.id';
export const MODE_SETTING = 'theme.mode';
export const CUSTOM_THEME_PREFIX = 'theme.custom.';

export const customThemeKey = (id: string) => `${CUSTOM_THEME_PREFIX}${id}`;

export interface ThemeSettings {
  /** The theme in effect (Penmoss when the chosen one is unknown or gone). */
  readonly theme: Theme;
  readonly mode: ThemeMode;
  /** Custom themes, by name. */
  readonly custom: readonly Theme[];
  /** Every theme to choose from: the built-ins, then the custom themes. */
  readonly all: readonly Theme[];
}

export function parseMode(value: unknown): ThemeMode {
  return THEME_MODES.includes(value as ThemeMode) ? (value as ThemeMode) : 'system';
}

/** The custom themes stored in `settings`, valid ones only. */
export function customThemes(settings: Readonly<Record<string, unknown>>): Theme[] {
  const themes: Theme[] = [];
  for (const [key, value] of Object.entries(settings)) {
    if (!key.startsWith(CUSTOM_THEME_PREFIX)) continue;
    const id = key.slice(CUSTOM_THEME_PREFIX.length);
    const parsed = isCustomThemeId(id) ? parseTheme(value) : null;
    // A theme filed under another theme's key is not that theme.
    if (parsed && parsed.theme.id === id) themes.push(parsed.theme);
  }
  return themes.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

export function resolveThemeSettings(settings: Readonly<Record<string, unknown>>): ThemeSettings {
  const custom = customThemes(settings);
  const chosen = settings[THEME_SETTING];
  const theme =
    builtInTheme(chosen) ??
    custom.find((each) => each.id === chosen) ??
    // A deleted custom theme, still chosen where the deletion had not arrived: its base.
    (isCustomThemeId(chosen) ? deletedThemeBase(settings[customThemeKey(chosen)]) : undefined) ??
    PENMOSS;
  return {
    theme,
    mode: parseMode(settings[MODE_SETTING]),
    custom,
    all: [...BUILT_IN_THEMES, ...custom],
  };
}

/** The variant to show for `mode`, given whether the system prefers dark. */
export function resolveVariant(mode: ThemeMode, systemDark: boolean): ThemeVariant {
  if (mode === 'system') return systemDark ? 'dark' : 'light';
  return mode;
}
