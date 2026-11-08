/**
 * The colour behind the page (T28, T29): each window's background is the
 * page's theme background, so a new window, a resize or the capture window
 * never flashes another colour. The page sends its theme's two backgrounds
 * and the mode; the main process picks the variant (macOS's appearance for
 * System) and keeps the choice for the next launch. Until then: Penmoss.
 */
import { isHexColour, PENMOSS, THEME_MODES, type ThemeMode } from '@penmoss/ui/theme';

export interface WindowTheme {
  readonly light: string;
  readonly dark: string;
  readonly mode: ThemeMode;
}

/** The page's message, or null: only `#rrggbb` colours and a known mode. */
export function parseWindowTheme(raw: unknown): WindowTheme | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { light, dark, mode } = raw as Record<string, unknown>;
  if (typeof light !== 'string' || !isHexColour(light)) return null;
  if (typeof dark !== 'string' || !isHexColour(dark)) return null;
  if (!(THEME_MODES as readonly unknown[]).includes(mode)) return null;
  return { light, dark, mode: mode as ThemeMode };
}

/** The background for a window: the theme's variant for its mode, or Penmoss. */
export function windowBackground(theme: WindowTheme | null, systemDark: boolean): string {
  const dark = theme?.mode === 'dark' || (theme?.mode !== 'light' && systemDark);
  if (!theme) return dark ? PENMOSS.dark.bg : PENMOSS.light.bg;
  return dark ? theme.dark : theme.light;
}

/**
 * Writes the last value once changes pause for `ms` (a colour dragged in the
 * theme editor saves many times a second), or at once on `flush` (quitting).
 */
export function debouncedWriter<T>(write: (value: T) => void, ms: number) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: { value: T } | null = null;
  const flush = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    const due = pending;
    pending = null;
    if (due) write(due.value);
  };
  return {
    schedule(value: T): void {
      pending = { value };
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(flush, ms);
    },
    flush,
  };
}
