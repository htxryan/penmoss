/**
 * The colour pairs the app paints, per theme variant, with the WCAG 2.2 AA
 * minimum each needs (T28): 4.5:1 for text, 3:1 for icons and other
 * non-text UI (1.4.11), and borders that can be seen at all (EDGE_MIN). Derived surfaces are computed the way the
 * stylesheet derives them (styles.css, blocks.css), so a check covers what a
 * browser shows: muted text on a hovered sidebar row, a link on a pressed
 * button, a keyword on the code block's background.
 */
import { contrast, mix, over } from './colour';
import type { ThemeColours } from './tokens';

export const TEXT_MIN = 4.5;
export const UI_MIN = 3;
/**
 * Borders are hairlines that group and divide (the built-ins' sit at 1.1–1.7:1,
 * High Contrast's above 4.7:1); controls never rely on them alone. They must
 * still be visible: a border that matches its surface is reported (A253).
 */
export const EDGE_MIN = 1.1;

export interface ContrastCheck {
  /** What is being read, on what: "Secondary text on a hovered sidebar row". */
  readonly label: string;
  readonly fg: string;
  readonly bg: string;
  readonly kind: 'text' | 'ui' | 'edge';
  readonly min: number;
  readonly ratio: number;
}

/** The stylesheet's derived surfaces for one variant. */
export function derivedSurfaces(c: ThemeColours) {
  return {
    hoverBg: over(c.fg, 0.06, c.bg),
    hoverSidebar: over(c.fg, 0.06, c.sidebar),
    hoverRaised: over(c.fg, 0.06, c.raised),
    activeSidebar: over(c.fg, 0.09, c.sidebar),
    activeBg: over(c.fg, 0.09, c.bg),
    accentSoft: over(c.accent, 0.14, c.bg),
    accentSoftRaised: over(c.accent, 0.14, c.raised),
    codeBg: mix(c.bg, c.fg, 0.06),
    searchMark: over(c.searchMatch, 0.38, c.raised),
    backlinkMark: over(c.highlight, 0.7, c.bg),
    focus: mix(c.accent, c.fg, 0.3),
  };
}

const CODE_TOKENS = [
  ['codeKeyword', 'Keywords'],
  ['codeString', 'Strings'],
  ['codeComment', 'Comments'],
  ['codeNumber', 'Numbers'],
  ['codeFunction', 'Functions'],
  ['codeType', 'Types'],
  ['codeVariable', 'Variables'],
  ['codeMeta', 'Meta'],
  ['codeTag', 'Tags'],
] as const;

const CALLOUT_TOKENS = [
  ['calloutNote', 'Note'],
  ['calloutAbstract', 'Abstract'],
  ['calloutTip', 'Tip'],
  ['calloutSuccess', 'Success'],
  ['calloutQuestion', 'Question'],
  ['calloutWarning', 'Warning'],
  ['calloutFailure', 'Failure'],
  ['calloutExample', 'Example'],
  ['calloutQuote', 'Quote'],
] as const;

const GRAPH_TOKENS = [
  ['graphFocus', 'focused note'],
  ['graphUngrouped', 'ungrouped notes'],
  ['graph1', 'group 1'],
  ['graph2', 'group 2'],
  ['graph3', 'group 3'],
  ['graph4', 'group 4'],
  ['graph5', 'group 5'],
  ['graph6', 'group 6'],
  ['graph7', 'group 7'],
  ['graph8', 'group 8'],
] as const;

/** Every pair to check for one variant. */
export function contrastChecks(c: ThemeColours): ContrastCheck[] {
  const s = derivedSurfaces(c);
  const checks: ContrastCheck[] = [];
  const text = (label: string, fg: string, bg: string) =>
    checks.push({ label, fg, bg, kind: 'text', min: TEXT_MIN, ratio: contrast(fg, bg) });
  const ui = (label: string, fg: string, bg: string) =>
    checks.push({ label, fg, bg, kind: 'ui', min: UI_MIN, ratio: contrast(fg, bg) });
  const edge = (label: string, fg: string, bg: string) =>
    checks.push({ label, fg, bg, kind: 'edge', min: EDGE_MIN, ratio: contrast(fg, bg) });

  const surfaces: ReadonlyArray<readonly [string, string]> = [
    ['the page', c.bg],
    ['the sidebar', c.sidebar],
    ['a menu or dialog', c.raised],
    ['a hovered row', s.hoverBg],
    ['a hovered sidebar row', s.hoverSidebar],
    ['a hovered menu item', s.hoverRaised],
    ['a selected sidebar row', s.activeSidebar],
    ['a pressed button', s.activeBg],
  ];
  for (const [where, bg] of surfaces) {
    text(`Text on ${where}`, c.fg, bg);
    text(`Secondary text on ${where}`, c.muted, bg);
  }
  text('Text in a code block', c.fg, s.codeBg);
  text('Text on a warning', c.fg, c.warnBg);
  text('Highlighted text', c.fg, c.highlight);
  text('A search match', c.fg, s.searchMark);
  text('A backlink match', c.fg, s.backlinkMark);
  // Accent and link text: links in notes, backlinks, search sources, checked menu items.
  for (const [where, bg] of [
    ['the page', c.bg],
    ['a menu or dialog', c.raised],
    ['a hovered menu item', s.hoverRaised],
  ] as const) {
    text(`Accent text on ${where}`, c.accent, bg);
    text(`A link on ${where}`, c.link, bg);
  }
  // A notebook's name in the sidebar (T52): the accent a quarter of the way to the text colour.
  const notebookName = mix(c.accent, c.fg, 0.25);
  text('A notebook’s name on the sidebar', notebookName, c.sidebar);
  text('A notebook’s name on a hovered sidebar row', notebookName, s.hoverSidebar);
  // The selected palette option is tinted with the accent; its matched letters are text.
  text('Text on the selected palette option', c.fg, s.accentSoftRaised);
  text('Danger text on the page', c.danger, c.bg);
  text('Danger text on a menu or dialog', c.danger, c.raised);
  text('Danger text on a hovered menu item', c.danger, s.hoverRaised);
  text('Text on the accent (primary button)', c.onAccent, c.accent);
  text('A tooltip', c.bg, c.fg);
  // A toast is a raised card in the theme's colours (PEN-63): its text, its action and its glyphs.
  text('Toast text', c.fg, c.raised);
  text('A toast’s action', c.accent, c.raised);
  text('A toast’s action, hovered', c.accent, s.hoverRaised);
  text('An agent label', c.bg, c.agent);
  for (const [key, name] of CODE_TOKENS) text(`Code: ${name}`, c[key], s.codeBg);
  for (const [key, name] of CALLOUT_TOKENS) {
    text(`Callout label: ${name}`, c[key], mix(c.bg, c[key], 0.07));
  }

  ui('Focus ring on the page', s.focus, c.bg);
  ui('Focus ring on a menu or dialog', s.focus, c.raised);
  ui('Success icon on the page', c.success, c.bg);
  ui('Success icon on the sidebar', c.success, c.sidebar);
  ui('Accent icon on a selected sidebar row', c.accent, s.activeSidebar);
  ui('Accent icon on a pressed toggle', c.accent, s.accentSoft);
  ui('Accent icon on the sidebar', c.accent, c.sidebar);
  ui('A toast’s check', c.accent, c.raised);
  ui('A toast’s warning', c.danger, c.raised);
  for (const [key, name] of GRAPH_TOKENS) ui(`Graph: ${name}`, c[key], c.bg);
  for (const [key, name] of CALLOUT_TOKENS) ui(`Callout marker: ${name}`, c[key], c.bg);
  edge('Borders on the page', c.border, c.bg);
  edge('Borders on the sidebar', c.border, c.sidebar);
  edge('Borders on a menu or dialog', c.border, c.raised);
  return checks;
}

/** The checks a variant fails (none for every built-in). */
export function contrastProblems(c: ThemeColours): ContrastCheck[] {
  return contrastChecks(c).filter((check) => check.ratio < check.min);
}
