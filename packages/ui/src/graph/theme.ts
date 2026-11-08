/**
 * The graph's colours from CSS custom properties (`--pm-graph-*`), so the
 * canvas follows the app's theme. Read again when the colour scheme changes.
 */
import { PENMOSS } from '../theme/builtins';
import { mix } from '../theme/colour';
import type { ThemeColors } from './renderer';

const GROUP_TOKENS = 8;
const light = PENMOSS.light;

/** Fallbacks for a page without the tokens (the perf harness, tests): Penmoss light (T28). */
export const FALLBACK_THEME: ThemeColors = {
  background: light.bg,
  edge: mix(light.bg, light.fg, 0.22),
  edgeHighlight: light.accent,
  label: light.fg,
  labelHalo: light.bg,
  focus: light.graphFocus,
  tag: light.muted,
  groups: [
    light.graph1,
    light.graph2,
    light.graph3,
    light.graph4,
    light.graph5,
    light.graph6,
    light.graph7,
    light.graph8,
  ],
  ungrouped: light.graphUngrouped,
};

export function readTheme(element: Element): ThemeColors {
  const style = getComputedStyle(element);
  const token = (name: string, fallback: string) =>
    style.getPropertyValue(`--pm-graph-${name}`).trim() || fallback;
  const groups = Array.from({ length: GROUP_TOKENS }, (_, i) =>
    token(String(i + 1), FALLBACK_THEME.groups[i]!),
  );
  return {
    background: token('bg', FALLBACK_THEME.background),
    edge: token('edge', FALLBACK_THEME.edge),
    edgeHighlight: token('edge-highlight', FALLBACK_THEME.edgeHighlight),
    label: token('label', FALLBACK_THEME.label),
    labelHalo: token('label-halo', FALLBACK_THEME.labelHalo),
    focus: token('focus', FALLBACK_THEME.focus),
    tag: token('tag', FALLBACK_THEME.tag),
    groups,
    ungrouped: token('ungrouped', FALLBACK_THEME.ungrouped),
    font: style.getPropertyValue('--pm-font').trim() || style.fontFamily,
  };
}

/** Calls `onChange` when the theme may have changed: the OS scheme, or the page's theme (T28). */
export function watchTheme(onChange: () => void): () => void {
  const media =
    typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
  media?.addEventListener('change', onChange);
  const observer = typeof MutationObserver === 'function' ? new MutationObserver(onChange) : null;
  observer?.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class', 'style', 'data-theme', 'data-mode'],
  });
  return () => {
    media?.removeEventListener('change', onChange);
    observer?.disconnect();
  };
}
