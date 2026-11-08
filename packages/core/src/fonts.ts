/**
 * Font settings (T51 item 16, A944): the interface's font, the note text's font and the note
 * text's base size, three synced per-user settings that override the theme's own fonts on
 * every client. Each font is a family with fallbacks, so it renders on the Mac, the web and
 * Android without bundled files: `theme` keeps the theme's font, a preset names a stack, and
 * `custom:<family>` asks for one installed family and falls back to the system sans.
 *
 * The web writes these in its WorkspaceDoc; the Android app through `PUT /api/settings`, which
 * checks them with these same rules.
 */

export const INTERFACE_FONT_SETTING = 'font.interface';
export const NOTE_FONT_SETTING = 'font.note';
export const NOTE_FONT_SIZE_SETTING = 'font.noteSize';

export const FONT_SETTING_KEYS = [
  INTERFACE_FONT_SETTING,
  NOTE_FONT_SETTING,
  NOTE_FONT_SIZE_SETTING,
] as const;

/** The presets, in the order Settings offers them. `theme` is the theme's own font. */
export const FONT_PRESETS = ['theme', 'system', 'serif', 'rounded', 'humanist', 'mono'] as const;
export type FontPreset = (typeof FONT_PRESETS)[number];

/** A font choice: a preset, or `custom:<family>`. */
export type FontChoice = FontPreset | `custom:${string}`;

export const CUSTOM_FONT_PREFIX = 'custom:';

/** What Settings calls each preset. */
export const FONT_PRESET_LABELS: Readonly<Record<FontPreset, string>> = {
  theme: 'Theme Default',
  system: 'System',
  serif: 'Serif',
  rounded: 'Rounded',
  humanist: 'Humanist',
  mono: 'Monospace',
};

/**
 * Each preset's CSS stack: the platform's own face first (the Mac's `ui-*` families, Windows'
 * and Android's named ones), then a generic family, so a device without the first still shows
 * the same kind of letter. Every face named has a regular weight: Chromium (Chrome and the Mac
 * app) has no `ui-rounded`, and 'Arial Rounded MT Bold', which every Mac has, drew all of a
 * note's text in bold there (T51's manual pass), so Rounded falls back to the system's sans.
 */
export const FONT_PRESET_STACKS: Readonly<Record<Exclude<FontPreset, 'theme'>, string>> = {
  system:
    "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
  serif:
    "ui-serif, 'Iowan Old Style', 'New York', Charter, Georgia, 'Noto Serif', 'Times New Roman', serif",
  rounded: "ui-rounded, 'SF Pro Rounded', 'Nunito', 'Varela Round', system-ui, sans-serif",
  humanist:
    "Seravek, 'Gill Sans Nova', Optima, Candara, Ubuntu, 'Noto Sans', 'DejaVu Sans', sans-serif",
  mono: "ui-monospace, 'SF Mono', Menlo, Consolas, 'Roboto Mono', 'Liberation Mono', monospace",
};

/**
 * The generic family Android maps each preset to (Compose's `FontFamily` and the editor
 * page's CSS both resolve these to the phone's own faces).
 */
export const FONT_PRESET_ANDROID: Readonly<Record<Exclude<FontPreset, 'theme'>, string>> = {
  system: 'sans-serif',
  serif: 'serif',
  rounded: 'sans-serif',
  humanist: 'sans-serif',
  mono: 'monospace',
};

/** Longest custom family name. */
export const MAX_FONT_FAMILY_CHARS = 64;

/** A family name: letters, digits, spaces, hyphens, underscores and dots, nothing CSS could read as more. */
const FAMILY = /^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u;

/** The note text's base size, in CSS pixels. */
export const NOTE_FONT_SIZE = { min: 12, max: 28, default: 16 } as const;

/** Why `family` cannot be a custom font's family, or null when it can. */
export function fontFamilyProblem(family: string): string | null {
  const trimmed = family.trim();
  if (trimmed.length === 0) return 'needs a font name';
  if (trimmed.length > MAX_FONT_FAMILY_CHARS)
    return `font name is longer than ${MAX_FONT_FAMILY_CHARS} characters`;
  if (!FAMILY.test(trimmed)) return 'font name may hold only letters, digits, spaces, . _ and -';
  return null;
}

/** Why `value` cannot be stored as `key` (one of the font settings), or null when it can. */
export function fontSettingProblem(key: string, value: unknown): string | null {
  if (value === null) return null;
  if (key === NOTE_FONT_SIZE_SETTING) {
    return typeof value === 'number' &&
      Number.isInteger(value) &&
      value >= NOTE_FONT_SIZE.min &&
      value <= NOTE_FONT_SIZE.max
      ? null
      : `${key} must be a whole number from ${NOTE_FONT_SIZE.min} to ${NOTE_FONT_SIZE.max}`;
  }
  if (typeof value !== 'string') return `${key} must be a font preset or custom:<font name>`;
  if ((FONT_PRESETS as readonly string[]).includes(value)) return null;
  if (value.startsWith(CUSTOM_FONT_PREFIX)) {
    const family = value.slice(CUSTOM_FONT_PREFIX.length);
    if (family !== family.trim()) return `${key} font name cannot start or end with a space`;
    const problem = fontFamilyProblem(family);
    return problem ? `${key} ${problem}` : null;
  }
  return `${key} must be one of ${FONT_PRESETS.join(', ')}, or custom:<font name>`;
}

export const isFontSetting = (key: string): boolean =>
  (FONT_SETTING_KEYS as readonly string[]).includes(key);

/** A stored choice, or `theme` while unset or unreadable. */
export function fontChoiceOf(
  settings: Readonly<Record<string, unknown>>,
  key: typeof INTERFACE_FONT_SETTING | typeof NOTE_FONT_SETTING,
): FontChoice {
  const value = settings[key];
  return value !== undefined && fontSettingProblem(key, value) === null && value !== null
    ? (value as FontChoice)
    : 'theme';
}

/** The note text's size in pixels, or the default while unset or unreadable. */
export function noteFontSizeOf(settings: Readonly<Record<string, unknown>>): number {
  const value = settings[NOTE_FONT_SIZE_SETTING];
  return value !== undefined &&
    value !== null &&
    fontSettingProblem(NOTE_FONT_SIZE_SETTING, value) === null
    ? (value as number)
    : NOTE_FONT_SIZE.default;
}

/** A custom choice's family, or null for a preset. */
export const customFamily = (choice: FontChoice): string | null =>
  choice.startsWith(CUSTOM_FONT_PREFIX) ? choice.slice(CUSTOM_FONT_PREFIX.length) : null;

/** A family name quoted for CSS (the rules above leave no quote or backslash in it). */
const quoted = (family: string) => `'${family}'`;

/**
 * The CSS stack for a choice, or null for `theme` (the theme's own font applies). A custom
 * family falls back to the system stack.
 */
export function fontStack(choice: FontChoice): string | null {
  if (choice === 'theme') return null;
  const family = customFamily(choice);
  if (family !== null) return `${quoted(family)}, ${FONT_PRESET_STACKS.system}`;
  return FONT_PRESET_STACKS[choice as Exclude<FontPreset, 'theme'>];
}

/** What Settings shows for a choice: the preset's label or the custom family. */
export function fontChoiceLabel(choice: FontChoice): string {
  return customFamily(choice) ?? FONT_PRESET_LABELS[choice as FontPreset];
}
