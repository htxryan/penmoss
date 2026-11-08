/**
 * The theme token model (T28, D14). A theme is JSON: a name, fonts, the
 * editor's width and one colour per token for each of a light and a dark
 * variant. Each colour token sets one CSS custom property on the page; the
 * stylesheet derives everything else (hover, pressed, soft accents, code
 * background, rings) from these with `color-mix`, so no theme can produce a
 * state the stylesheet has not designed. No custom CSS (D14).
 */

export type ColourGroup = 'surfaces' | 'text' | 'states' | 'code' | 'callouts' | 'graph';

export interface ColourTokenInfo {
  readonly key: string;
  /** The custom property it sets (and any aliases, for older names). */
  readonly css: readonly string[];
  readonly label: string;
  readonly group: ColourGroup;
}

const token = <K extends string>(
  key: K,
  label: string,
  group: ColourGroup,
  ...css: string[]
): ColourTokenInfo & { readonly key: K } => ({ key, label, group, css });

/** Every colour token, in the theme editor's order. */
export const COLOUR_TOKENS = [
  token('bg', 'Page background', 'surfaces', '--pm-bg'),
  token('sidebar', 'Sidebar', 'surfaces', '--pm-sidebar'),
  token('raised', 'Raised (menus, cards, dialogs)', 'surfaces', '--pm-raised'),
  token('border', 'Borders', 'surfaces', '--pm-border'),
  token('fg', 'Text', 'text', '--pm-fg'),
  token('muted', 'Secondary text and icons', 'text', '--pm-muted'),
  token('link', 'Links', 'text', '--pm-link'),
  token('accent', 'Accent', 'states', '--pm-accent'),
  token('onAccent', 'Text on accent', 'states', '--pm-on-accent'),
  token('danger', 'Danger', 'states', '--pm-danger'),
  token('success', 'Success', 'states', '--pm-success'),
  token('warnBg', 'Warning background', 'states', '--pm-warn-bg'),
  token('agent', 'Agent edits', 'states', '--pm-agent'),
  token('highlight', 'Highlighted text', 'states', '--pm-highlight-bg'),
  token('searchMatch', 'Search matches', 'states', '--pm-search-match'),
  token('shadow', 'Shadow tint', 'states', '--pm-shadow-color'),
  token('codeKeyword', 'Keywords', 'code', '--pm-code-keyword'),
  token('codeString', 'Strings', 'code', '--pm-code-string'),
  token('codeComment', 'Comments', 'code', '--pm-code-comment'),
  token('codeNumber', 'Numbers', 'code', '--pm-code-number'),
  token('codeFunction', 'Functions', 'code', '--pm-code-function'),
  token('codeType', 'Types', 'code', '--pm-code-type'),
  token('codeVariable', 'Variables', 'code', '--pm-code-variable'),
  token('codeMeta', 'Meta and punctuation', 'code', '--pm-code-meta'),
  token('codeTag', 'Tags and attributes', 'code', '--pm-code-tag'),
  token('codeAddition', 'Added lines', 'code', '--pm-code-addition'),
  token('codeDeletion', 'Removed lines', 'code', '--pm-code-deletion'),
  token(
    'calloutNote',
    'Note, info, to-do',
    'callouts',
    '--pm-callout-note',
    '--pm-callout-info',
    '--pm-callout-todo',
  ),
  token('calloutAbstract', 'Abstract', 'callouts', '--pm-callout-abstract'),
  token('calloutTip', 'Tip', 'callouts', '--pm-callout-tip'),
  token('calloutSuccess', 'Success', 'callouts', '--pm-callout-success'),
  token('calloutQuestion', 'Question', 'callouts', '--pm-callout-question'),
  token('calloutWarning', 'Warning', 'callouts', '--pm-callout-warning'),
  token(
    'calloutFailure',
    'Failure, danger, bug',
    'callouts',
    '--pm-callout-failure',
    '--pm-callout-danger',
    '--pm-callout-bug',
  ),
  token('calloutExample', 'Example', 'callouts', '--pm-callout-example'),
  token('calloutQuote', 'Quote', 'callouts', '--pm-callout-quote'),
  token('graphFocus', 'Focused note', 'graph', '--pm-graph-focus'),
  token('graphUngrouped', 'Notes outside a group', 'graph', '--pm-graph-ungrouped'),
  token('graph1', 'Group 1', 'graph', '--pm-graph-1'),
  token('graph2', 'Group 2', 'graph', '--pm-graph-2'),
  token('graph3', 'Group 3', 'graph', '--pm-graph-3'),
  token('graph4', 'Group 4', 'graph', '--pm-graph-4'),
  token('graph5', 'Group 5', 'graph', '--pm-graph-5'),
  token('graph6', 'Group 6', 'graph', '--pm-graph-6'),
  token('graph7', 'Group 7', 'graph', '--pm-graph-7'),
  token('graph8', 'Group 8', 'graph', '--pm-graph-8'),
] as const satisfies readonly ColourTokenInfo[];

export type ColourToken = (typeof COLOUR_TOKENS)[number]['key'];
export const COLOUR_KEYS: readonly ColourToken[] = COLOUR_TOKENS.map((info) => info.key);

export const COLOUR_GROUPS: ReadonlyArray<{ readonly id: ColourGroup; readonly label: string }> = [
  { id: 'surfaces', label: 'Surfaces' },
  { id: 'text', label: 'Text' },
  { id: 'states', label: 'Accent and states' },
  { id: 'code', label: 'Code' },
  { id: 'callouts', label: 'Callouts' },
  { id: 'graph', label: 'Graph' },
];

/** One variant's colours, each `#rrggbb`. */
export type ThemeColours = Readonly<Record<ColourToken, string>>;

export type ThemeVariant = 'light' | 'dark';
/** The user's choice: a variant, or whichever the system prefers. */
export type ThemeMode = ThemeVariant | 'system';
export const THEME_MODES: readonly ThemeMode[] = ['light', 'dark', 'system'];

export interface ThemeFonts {
  /** The interface. */
  readonly ui: string;
  /** Note text and titles. */
  readonly body: string;
  /** Code. */
  readonly mono: string;
}

/** The note column's maximum width, in rem. */
export const EDITOR_WIDTH = { min: 32, max: 72 } as const;

/**
 * The built-in themes' note width, in rem (T41, A500): 52rem of text, about 830 px, a
 * little wider than Typora (860 px with its padding) and wider than Obsidian's readable
 * line (700 px) and Notion's page (708 px). Ryan found 46rem too narrow in the Mac app.
 * Full width (`note.fullWidth`) lifts the limit altogether.
 */
export const DEFAULT_EDITOR_WIDTH = 52;

export interface Theme {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** The built-in a custom theme was duplicated from: its values fill anything missing or invalid. */
  readonly base: string | null;
  readonly fonts: ThemeFonts;
  readonly editorWidth: number;
  readonly light: ThemeColours;
  readonly dark: ThemeColours;
}

/** Font stacks offered by the theme editor (any safe stack is accepted from sync). */
export const FONT_STACKS = {
  sans: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  serif: "'Iowan Old Style', 'Palatino Linotype', Palatino, Georgia, serif",
  humanist:
    "Seravek, 'Gill Sans Nova', Ubuntu, Calibri, 'DejaVu Sans', source-sans-pro, sans-serif",
  mono: "ui-monospace, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace",
} as const;

export const FONT_CHOICES: ReadonlyArray<{ readonly label: string; readonly stack: string }> = [
  { label: 'System sans-serif', stack: FONT_STACKS.sans },
  { label: 'Serif (book)', stack: FONT_STACKS.serif },
  { label: 'Humanist sans-serif', stack: FONT_STACKS.humanist },
  { label: 'Monospace', stack: FONT_STACKS.mono },
];
