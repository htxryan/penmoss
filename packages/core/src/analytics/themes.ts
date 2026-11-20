/**
 * The built-in themes' ids (`@penmoss/ui/theme`'s, and `themes-v1.json`'s). A launch event names
 * one of these or `custom`, never a custom theme's own name.
 */
export const BUILTIN_THEMES: readonly string[] = [
  'penmoss',
  'paper',
  'slate',
  'nord',
  'solarized',
  'gruvbox',
  'rose-pine',
  'high-contrast',
];

/** What a launch event says of theme `id`. */
export function themeForEvent(id: string): string {
  return BUILTIN_THEMES.includes(id) ? id : 'custom';
}
