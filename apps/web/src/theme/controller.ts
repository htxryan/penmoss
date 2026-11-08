/**
 * Shows the theme (T28). The chosen theme and mode are the user's synced
 * settings (A17); this device also remembers the last theme it showed, so the
 * page starts in it before the workspace has been read, while signed out, and
 * offline. A preview (the theme editor, the theme picker) shows a theme
 * without choosing it.
 *
 * The font settings (T51 item 16, A944) lay the person's interface font, note
 * font and note size over the theme's fonts, shown and remembered with it.
 *
 * Every time the page's theme changes, `onApplied` reports the colours a
 * native shell needs: the browser build updates `<meta name="theme-color">`
 * and dispatches a `penmoss:theme` event on window, which the Mac app (T29)
 * can use for its window background and title bar.
 */
import { FONT_SETTING_KEYS } from '@penmoss/core/fonts';
import {
  applyThemeTo,
  builtInTheme,
  fontVariables,
  customThemeKey,
  isCustomThemeId,
  MODE_SETTING,
  parseMode,
  parseTheme,
  PENMOSS,
  resolveThemeSettings,
  resolveVariant,
  storedTheme,
  THEME_SETTING,
  themeVariables,
  type Theme,
  type ThemeMode,
  type ThemeTarget,
  type ThemeVariant,
} from '@penmoss/ui/theme';
import type { KeyValueStore } from '../shell/key-value';

/** The localStorage key for the last theme shown on this device. */
export const THEME_CACHE_KEY = 'penmoss.theme';
/** The window event fired whenever the theme shown changes. */
export const THEME_EVENT = 'penmoss:theme';

/** What a native shell needs to match the page (T29): fired as `penmoss:theme`. */
export interface ThemeApplied {
  readonly id: string;
  readonly name: string;
  readonly variant: ThemeVariant;
  /** The page background, `#rrggbb`. */
  readonly background: string;
  /** The sidebar, where a Mac title bar sits. */
  readonly sidebar: string;
  readonly foreground: string;
}

export interface SystemScheme {
  readonly matches: boolean;
  subscribe(listener: () => void): () => void;
}

export interface ThemeEnvironment {
  readonly root: ThemeTarget;
  readonly storage: KeyValueStore | null;
  /** Whether the system prefers dark. */
  readonly systemDark: SystemScheme;
  readonly onApplied?: (detail: ThemeApplied) => void;
}

export interface ThemeState {
  /** The chosen theme (not a preview). */
  readonly theme: Theme;
  readonly mode: ThemeMode;
  /** The variant on screen. */
  readonly variant: ThemeVariant;
  /** The theme on screen: the preview while there is one. */
  readonly shown: Theme;
}

interface Choice {
  readonly theme: Theme;
  readonly mode: ThemeMode;
  /** The font settings' variables, over the theme's (A944). */
  readonly fonts: Readonly<Record<string, string>>;
}

/** A remembered font variable: one of `fontVariables`', a plain value. */
const FONT_VARIABLE = /^--pm-(?:font|font-body|note-size)$/;

export class ThemeController {
  private choice: Choice = { theme: PENMOSS, mode: 'system', fonts: fontVariables({}) };
  /** Previews by owner (the editor, the picker), the latest last: it is the one shown. */
  private previews: Array<{ readonly owner: object; readonly theme: Theme }> = [];
  private state: ThemeState;
  private readonly listeners = new Set<() => void>();
  private stopSystem: (() => void) | null = null;
  /** What was last applied, to skip repeating identical work. */
  private appliedKey = '';
  private stateKey = '';
  /** The theme settings last read, to skip parsing and remembering them again. */
  private settingsKey = '';
  /** What was last remembered on this device. */
  private cacheKey = '';

  constructor(private readonly env: ThemeEnvironment) {
    this.state = this.compute();
  }

  /** Shows the remembered theme and follows the system's scheme. */
  start(): void {
    this.choice = this.readCache() ?? this.choice;
    this.stopSystem ??= this.env.systemDark.subscribe(() => this.refresh());
    this.refresh();
  }

  stop(): void {
    this.stopSystem?.();
    this.stopSystem = null;
  }

  /**
   * The signed-in user's settings, or null while they are unknown (signed
   * out, or the workspace not read yet): then the remembered theme stays.
   */
  setSettings(settings: Readonly<Record<string, unknown>> | null): void {
    if (!settings) return;
    // Settings are read again on every workspace change: only the theme's own matter.
    const chosen = settings[THEME_SETTING];
    const key = JSON.stringify([
      chosen,
      settings[MODE_SETTING],
      isCustomThemeId(chosen) ? (settings[customThemeKey(chosen)] ?? null) : null,
      ...FONT_SETTING_KEYS.map((each) => settings[each] ?? null),
    ]);
    if (key === this.settingsKey) return;
    this.settingsKey = key;
    const resolved = resolveThemeSettings(settings);
    this.choice = { theme: resolved.theme, mode: resolved.mode, fonts: fontVariables(settings) };
    this.writeCache();
    this.refresh();
  }

  /**
   * Shows `theme` (in the current mode) until `preview(null)` from the same
   * owner. Nothing is saved. Each owner has one preview and the latest is
   * shown, so the picker closing goes back to the editor's draft.
   */
  preview(theme: Theme | null, owner: object = ThemeController): void {
    this.previews = this.previews.filter((each) => each.owner !== owner);
    if (theme) this.previews.push({ owner, theme });
    this.refresh();
  }

  getState = (): ThemeState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private compute(): ThemeState {
    const { theme, mode } = this.choice;
    return {
      theme,
      mode,
      variant: resolveVariant(mode, this.env.systemDark.matches),
      shown: this.previews.at(-1)?.theme ?? theme,
    };
  }

  private refresh(): void {
    const next = this.compute();
    const key = JSON.stringify([next.shown, next.variant, this.choice.fonts]);
    if (key !== this.appliedKey) {
      this.appliedKey = key;
      applyThemeTo(this.env.root, next.shown, next.variant);
      // The font settings win over the theme's fonts, a preview's too (A944).
      for (const [name, value] of Object.entries(this.choice.fonts)) {
        this.env.root.style.setProperty(name, value);
      }
      const colours = next.shown[next.variant];
      this.env.onApplied?.({
        id: next.shown.id,
        name: next.shown.name,
        variant: next.variant,
        background: colours.bg,
        sidebar: colours.sidebar,
        foreground: colours.fg,
      });
    }
    // Settings are read again on every workspace change: tell subscribers only of real changes.
    const stateKey = JSON.stringify([next.theme, next.mode, next.variant, next.shown]);
    if (stateKey === this.stateKey) return;
    this.stateKey = stateKey;
    this.state = next;
    for (const listener of this.listeners) listener();
  }

  private readCache(): Choice | null {
    try {
      const raw = this.env.storage?.getItem(THEME_CACHE_KEY);
      if (!raw) return null;
      const cached = JSON.parse(raw) as {
        mode?: unknown;
        id?: unknown;
        theme?: unknown;
        fonts?: unknown;
      };
      const theme = builtInTheme(cached.id) ?? parseTheme(cached.theme)?.theme ?? PENMOSS;
      return { theme, mode: parseMode(cached.mode), fonts: readFonts(cached.fonts) };
    } catch {
      return null;
    }
  }

  /**
   * Remembers the theme for the next start: its id (a custom theme's JSON
   * too), the mode, and both variants' variables, which public/theme-boot.js
   * applies from <head> before the app's bundle has loaded (A251).
   */
  private writeCache(): void {
    const { theme, mode, fonts } = this.choice;
    const value = {
      mode,
      id: theme.id,
      ...(builtInTheme(theme.id) ? {} : { theme: storedTheme(theme) }),
      fonts,
      // The fonts over each variant's, so the first paint is in them too (A944).
      vars: {
        light: { ...themeVariables(theme, 'light'), ...fonts },
        dark: { ...themeVariables(theme, 'dark'), ...fonts },
      },
    };
    const json = JSON.stringify(value);
    if (json === this.cacheKey) return;
    this.cacheKey = json;
    try {
      this.env.storage?.setItem(THEME_CACHE_KEY, json);
    } catch {
      // Storage full or blocked: the page still shows the theme, it just won't start in it.
    }
  }
}

/** Remembered font variables, those that are font variables with plain values; else none. */
/**
 * A remembered font value: a stack of family names (any script's letters, as a custom family's
 * may be, T51 review), or a size. No quote but the stacks' own single ones, nothing CSS could
 * read as more.
 */
const FONT_VALUE = /^[\p{L}\p{N}\s,'._-]{1,200}$/u;

function readFonts(value: unknown): Record<string, string> {
  const fonts = fontVariables({});
  if (typeof value !== 'object' || value === null) return fonts;
  for (const [name, each] of Object.entries(value)) {
    if (FONT_VARIABLE.test(name) && typeof each === 'string' && FONT_VALUE.test(each)) {
      fonts[name] = each;
    }
  }
  return fonts;
}

/** The page itself: `<html>`, localStorage, the system scheme, the meta tag and the event. */
export function browserThemeEnvironment(): ThemeEnvironment {
  const query =
    typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-color-scheme: dark)')
      : null;
  let storage: KeyValueStore | null;
  try {
    storage = window.localStorage;
  } catch {
    // Blocked storage (privacy settings) throws on access: start in Penmoss each time.
    storage = null;
  }
  return {
    root: document.documentElement,
    storage,
    systemDark: {
      get matches() {
        return query?.matches ?? false;
      },
      subscribe(listener) {
        query?.addEventListener('change', listener);
        return () => query?.removeEventListener('change', listener);
      },
    },
    onApplied(detail) {
      for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
        meta.setAttribute('content', detail.background);
      }
      window.dispatchEvent(new CustomEvent<ThemeApplied>(THEME_EVENT, { detail }));
    },
  };
}
