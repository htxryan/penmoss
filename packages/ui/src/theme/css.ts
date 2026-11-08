/**
 * A theme variant as CSS custom properties (T28). The page sets these on
 * `<html>`; the stylesheets read only `var(--pm-…)`, and derive hover,
 * pressed, soft and ring colours from them with `color-mix`.
 */
import { COLOUR_TOKENS, type Theme, type ThemeVariant } from './tokens';

export function themeVariables(theme: Theme, variant: ThemeVariant): Record<string, string> {
  const colours = theme[variant];
  const vars: Record<string, string> = {};
  for (const token of COLOUR_TOKENS) {
    for (const name of token.css) vars[name] = colours[token.key];
  }
  vars['--pm-font'] = theme.fonts.ui;
  vars['--pm-font-body'] = theme.fonts.body;
  vars['--pm-mono'] = theme.fonts.mono;
  vars['--pm-editor-width'] = `${theme.editorWidth}rem`;
  return vars;
}

/** What the page needs to show a theme: something with a style and attributes (`<html>`). */
export interface ThemeTarget {
  readonly style: Pick<CSSStyleDeclaration, 'setProperty'> & { colorScheme: string };
  setAttribute(name: string, value: string): void;
}

/**
 * Shows `theme` on `root`: its variables, `data-theme` (the id), `data-mode`
 * (the variant shown) and `color-scheme`, so form controls and scrollbars
 * match.
 */
export function applyThemeTo(root: ThemeTarget, theme: Theme, variant: ThemeVariant): void {
  for (const [name, value] of Object.entries(themeVariables(theme, variant))) {
    root.style.setProperty(name, value);
  }
  root.style.colorScheme = variant;
  root.setAttribute('data-theme', theme.id);
  root.setAttribute('data-mode', variant);
}
