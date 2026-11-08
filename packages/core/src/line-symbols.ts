/**
 * Line symbols (T44, D36): signifiers such as ★ important, ? question, ! follow-up, 💡 idea
 * and → next at the start of a paragraph, list item, checklist item, heading or table cell. They
 * are plain text in the markdown (A741): each symbol is its glyph and one space, at the start of
 * the block's text, after any list marker, checkbox or heading hashes (`- [ ] ! ★ Send the form`,
 * `## ? Open questions`, `| ★ Ship it |`: T52 item 2). The editor draws a leading run of known glyphs in the margin; the
 * codec, the git mirror and agents see only text, so nothing here changes a note's bytes.
 *
 * The glyphs a person uses are one synced setting, `symbols.list` (A743): up to nine entries,
 * one per shortcut slot, each a glyph, a name and a theme colour (D14). The web writes it in
 * its WorkspaceDoc; the Android app through `PUT /api/settings`, which checks it with
 * `symbolListProblem`.
 */

/** The synced setting that holds the list (A743). */
export const SYMBOLS_SETTING = 'symbols.list';

/** One entry per shortcut slot, `editor.symbol1`–`editor.symbol9` (A744). */
export const MAX_SYMBOLS = 9;

/** Longest glyph, in UTF-16 code units: room for a family emoji (👨‍👩‍👧‍👦 is 11). */
export const MAX_GLYPH_CHARS = 16;

/** Longest name. */
export const MAX_SYMBOL_NAME_CHARS = 40;

/**
 * The theme colours a symbol may take (D14): tokens drawn as text on the page background, so
 * every theme has designed them to be legible there. Each maps to its custom property.
 */
export const SYMBOL_COLOURS = {
  accent: '--pm-accent',
  link: '--pm-link',
  danger: '--pm-danger',
  success: '--pm-success',
  agent: '--pm-agent',
  muted: '--pm-muted',
  calloutNote: '--pm-callout-note',
  calloutTip: '--pm-callout-tip',
  calloutQuestion: '--pm-callout-question',
  calloutWarning: '--pm-callout-warning',
  calloutFailure: '--pm-callout-failure',
  calloutExample: '--pm-callout-example',
} as const;

export type ThemeSymbolColour = keyof typeof SYMBOL_COLOURS;

/**
 * A symbol's colour (A939): a theme colour, which each theme designs for light and dark, or
 * any colour as `#rrggbb` or `#rrggbbaa` (lower case), the same in both.
 */
export type SymbolColour = ThemeSymbolColour | `#${string}`;

/** A custom colour as stored: `#rrggbb` or `#rrggbbaa`, lower case. */
export const HEX_COLOUR = /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/;

/** Whether `colour` is a custom `#rrggbb(aa)` colour rather than a theme colour. */
export const isHexColour = (colour: string): colour is `#${string}` => HEX_COLOUR.test(colour);

/** The colours in the order Settings offers them. */
export const SYMBOL_COLOUR_KEYS = Object.keys(SYMBOL_COLOURS) as readonly ThemeSymbolColour[];

/** What Settings → Symbols calls each colour. */
export const SYMBOL_COLOUR_LABELS: Readonly<Record<ThemeSymbolColour, string>> = {
  accent: 'Accent',
  link: 'Link',
  danger: 'Red',
  success: 'Green',
  agent: 'Violet',
  muted: 'Grey',
  calloutNote: 'Blue',
  calloutTip: 'Teal',
  calloutQuestion: 'Yellow',
  calloutWarning: 'Orange',
  calloutFailure: 'Rose',
  calloutExample: 'Purple',
};

export interface LineSymbol {
  readonly glyph: string;
  readonly name: string;
  readonly colour: SymbolColour;
}

/** The list until a person changes it (A743). */
export const DEFAULT_SYMBOLS: readonly LineSymbol[] = [
  { glyph: '★', name: 'Important', colour: 'calloutWarning' },
  { glyph: '?', name: 'Question', colour: 'calloutQuestion' },
  { glyph: '!', name: 'Follow-up', colour: 'danger' },
  { glyph: '💡', name: 'Idea', colour: 'calloutTip' },
  { glyph: '→', name: 'Next', colour: 'accent' },
];

/**
 * What a screen reader is given for a symbol (T51 review, A940): its glyph, and its older name
 * too when it has one ("★ Important"), since a glyph that is only punctuation ("!", "?") may
 * be read as nothing. A symbol made since A940 is named by its glyph: the glyph alone.
 */
export function symbolSpokenName(symbol: Pick<LineSymbol, 'glyph' | 'name'>): string {
  const name = symbol.name.trim();
  return name && name !== symbol.glyph ? `${symbol.glyph} ${name}` : symbol.glyph;
}

/** A colour for a style: a theme colour's custom property (`var(--pm-callout-warning)`), or the hex itself. */
export const symbolColourVar = (colour: SymbolColour): string =>
  isHexColour(colour) ? colour : `var(${SYMBOL_COLOURS[colour]})`;

/** What Settings calls a colour: the theme colour's name, or its hex in capitals. */
export const symbolColourLabel = (colour: SymbolColour): string =>
  isHexColour(colour) ? colour.toUpperCase() : SYMBOL_COLOUR_LABELS[colour];

/**
 * The glyphs Settings offers in its picker (T51 item 9, A939), in the order shown: marks,
 * arrows, ticks, shapes, then emoji. Each passes `glyphProblem`; any other glyph can still be
 * pasted in.
 */
export const SYMBOL_GLYPH_PRESETS: readonly string[] = [
  ...['★', '☆', '?', '!', '‼', '⁉', '→', '←', '↑', '↓', '⇒', '✓', '✔', '✗', '✘'],
  ...['●', '○', '◆', '◇', '■', '□', '▲', '△', '♥', '⚑', '⚠', '✎', '§', '※', '❖'],
  ...['💡', '⭐', '❓', '❗', '🔥', '📌', '📎', '💬', '⏰', '⏳', '🗓️', '🔒'],
];

/**
 * Characters a glyph may not hold, beyond letters, digits and spaces: at the start of a line
 * they are markdown (a heading, list, quote, table, code, a link or task box, HTML, an escape,
 * emphasis, maths), so the codec would escape them and the note's text would no longer be the
 * glyph as written (A743).
 */
const MARKDOWN_PUNCTUATION = /[#\-+*>=|`~[\]\\<_$]/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
/**
 * Characters that show nothing or turn text around (T44 review): a soft hyphen, zero-width
 * spaces and joiners outside an emoji, direction marks, embeddings, overrides and isolates,
 * the word joiner and invisible operators. A glyph made of them would look like another or
 * like nothing at all.
 */
const INVISIBLE =
  /[\u00ad\u061c\u180e\u200b\u200c\u200e\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069]/;
const COMBINING_FIRST = /^\p{M}/u;
const SPACE = /\s/u;

/** Emoji and text presentation selectors: `💡` and `💡️` are the same symbol. */
const VARIATION_SELECTORS = /[︎️]/g;

/** A glyph as it is compared: without variation selectors. */
export const glyphKey = (glyph: string): string => glyph.replace(VARIATION_SELECTORS, '');

/** Why `glyph` cannot be a symbol's glyph, or null when it can. */
export function glyphProblem(glyph: unknown): string | null {
  if (typeof glyph !== 'string' || glyph.length === 0) return 'needs a glyph';
  if (glyph.length > MAX_GLYPH_CHARS) return `glyph is longer than ${MAX_GLYPH_CHARS} characters`;
  if (SPACE.test(glyph) || CONTROL.test(glyph)) return 'glyph cannot hold a space';
  if (INVISIBLE.test(glyph) || glyph.startsWith('\u200d') || glyph.endsWith('\u200d'))
    return 'glyph cannot hold invisible or direction characters';
  if (COMBINING_FIRST.test(glyph)) return 'glyph cannot start with a combining mark';
  if (LETTER_OR_DIGIT.test(glyph)) return 'glyph cannot hold letters or digits';
  if (MARKDOWN_PUNCTUATION.test(glyph)) return 'glyph cannot hold # - + * > = | ` ~ [ ] \\ < _ $';
  if (glyphKey(glyph).length === 0) return 'needs a glyph';
  return null;
}

/** Why `name` cannot be a symbol's name, or null when it can. */
export function symbolNameProblem(name: unknown): string | null {
  if (typeof name !== 'string' || name.trim().length === 0) return 'needs a name';
  if (name.length > MAX_SYMBOL_NAME_CHARS)
    return `name is longer than ${MAX_SYMBOL_NAME_CHARS} characters`;
  if (CONTROL.test(name)) return 'name cannot hold control characters';
  return null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isColour = (value: unknown): value is SymbolColour =>
  typeof value === 'string' && (Object.hasOwn(SYMBOL_COLOURS, value) || isHexColour(value));

/**
 * Why `value` cannot be stored as `symbols.list`, or null when it can (A743): a list of at
 * most nine `{ glyph, name, colour }`, glyphs distinct. `[]` (no symbols) is a list.
 */
export function symbolListProblem(value: unknown): string | null {
  if (!Array.isArray(value)) return `${SYMBOLS_SETTING} must be a list of symbols`;
  if (value.length > MAX_SYMBOLS)
    return `${SYMBOLS_SETTING} must have at most ${MAX_SYMBOLS} symbols`;
  const seen = new Set<string>();
  for (const [index, entry] of (value as unknown[]).entries()) {
    const at = `${SYMBOLS_SETTING} symbol ${index + 1}`;
    if (!isRecord(entry)) return `${at} must be { glyph, name, colour }`;
    const problem = glyphProblem(entry['glyph']) ?? symbolNameProblem(entry['name']);
    if (problem) return `${at} ${problem}`;
    if (!isColour(entry['colour']))
      return `${at} colour must be one of ${SYMBOL_COLOUR_KEYS.join(', ')}, or #rrggbb or #rrggbbaa`;
    const key = glyphKey(entry['glyph'] as string);
    if (seen.has(key)) return `${at} repeats the glyph ${entry['glyph'] as string}`;
    seen.add(key);
  }
  return null;
}

/** A valid stored list with only the fields this build knows, or null. */
export function readSymbolList(value: unknown): readonly LineSymbol[] | null {
  if (symbolListProblem(value) !== null) return null;
  return (value as Record<string, unknown>[]).map((entry) => ({
    glyph: entry['glyph'] as string,
    name: (entry['name'] as string).trim(),
    colour: entry['colour'] as SymbolColour,
  }));
}

/**
 * The person's symbols, from their settings: the stored list, or the defaults while it is
 * unset or unreadable (a list from a newer build with rules this one does not know).
 */
export function symbolsOf(settings: Readonly<Record<string, unknown>>): readonly LineSymbol[] {
  return readSymbolList(settings[SYMBOLS_SETTING]) ?? DEFAULT_SYMBOLS;
}

/** One symbol at the start of a line: its slot in the list and its text, the space included. */
export interface SymbolToken {
  /** The symbol's index in the list (its shortcut slot). */
  readonly index: number;
  /** Where the glyph starts in the text. */
  readonly from: number;
  /** Just after the space that follows it. */
  readonly to: number;
}

export interface SymbolRun {
  readonly tokens: readonly SymbolToken[];
  /**
   * Where the line's own text starts: after the last symbol's space (0 without symbols); the
   * end of the text on a line that is only symbols, whose last glyph may have no space.
   */
  readonly end: number;
}

/** Whether the run's last symbol has no space after it (a line of only symbols, as read back). */
export const runEndsBare = (run: SymbolRun, text: string): boolean => {
  const last = run.tokens[run.tokens.length - 1];
  return last !== undefined && last.to === text.length && text[last.to - 1] !== ' ';
};

const NO_RUN: SymbolRun = { tokens: [], end: 0 };

/**
 * The leading run of known symbols in a block's text (A741): glyphs from `symbols`, each
 * followed by one space, from the start. A glyph matches as a whole string, so `★★ ` is not
 * `★` and a multi-code-point emoji is one symbol; variation selectors are ignored. A prose
 * line starting with a known glyph and a space is a symbol too (A742): its bytes never change.
 */
export function symbolRun(
  text: string,
  symbols: readonly LineSymbol[],
  /**
   * Whether a last glyph with no space after it, ending the text, counts (A741). The editor
   * leaves it out on the line holding the caret, so `!` typed before a word never hides.
   */
  bareEnd = true,
): SymbolRun {
  if (symbols.length === 0 || text.length === 0) return NO_RUN;
  const slots = new Map<string, number>();
  symbols.forEach((symbol, index) => {
    const key = glyphKey(symbol.glyph);
    if (!slots.has(key)) slots.set(key, index);
  });
  const tokens: SymbolToken[] = [];
  let at = 0;
  for (;;) {
    const space = text.indexOf(' ', at);
    if (space === -1 && bareEnd) {
      // A line that is only symbols ends with a glyph: markdown drops a line's trailing space,
      // so `★ ` is written `★` and must read back as a symbol (T44 review, A741).
      const index =
        text.length - at <= MAX_GLYPH_CHARS ? slots.get(glyphKey(text.slice(at))) : undefined;
      if (at < text.length && index !== undefined) {
        tokens.push({ index, from: at, to: text.length });
        at = text.length;
      }
      break;
    }
    if (space === -1 || space <= at || space - at > MAX_GLYPH_CHARS) break;
    const index = slots.get(glyphKey(text.slice(at, space)));
    if (index === undefined) break;
    tokens.push({ index, from: at, to: space + 1 });
    at = space + 1;
  }
  return tokens.length ? { tokens, end: at } : NO_RUN;
}

/** Whether the text's run has the symbol in slot `index`. */
export const hasSymbol = (run: SymbolRun, index: number): boolean =>
  run.tokens.some((token) => token.index === index);

/** A change to a block's text, in its own offsets. */
export interface TextEdit {
  readonly from: number;
  readonly to: number;
  readonly insert: string;
}

/**
 * The edits that add (`add`) or remove symbol `index` on a line with `run` (A740). Added at its
 * place by list order among the symbols there (before the first with a later slot), so a line
 * keeps the list's order however its symbols were added; removed wherever it is, every copy of
 * it. Other symbols are untouched. Empty when there is nothing to do. Edits are in descending
 * order, so they can be applied one after the other.
 */
export function symbolEdits(
  run: SymbolRun,
  symbols: readonly LineSymbol[],
  index: number,
  add: boolean,
  /** The line's text, when its run may end in a glyph with no space (a line of only symbols). */
  text?: string,
): TextEdit[] {
  const symbol = symbols[index];
  if (!symbol) return [];
  // A second copy of a symbol (two devices added it at once) goes with any toggle on the line.
  const seen = new Set<number>();
  const extra = run.tokens.filter((token) => {
    const again = seen.has(token.index);
    seen.add(token.index);
    return again && token.index !== index;
  });
  const removals = (tokens: readonly SymbolToken[]) =>
    tokens.map((token) => ({ from: token.from, to: token.to, insert: '' }));
  if (!add) {
    const own = run.tokens.filter((token) => token.index === index);
    if (own.length === 0) return [];
    return removals([...own, ...extra].sort((a, b) => a.from - b.from)).reverse();
  }
  if (hasSymbol(run, index)) {
    const copies = run.tokens.filter((token) => token.index === index).slice(1);
    return removals([...copies, ...extra].sort((a, b) => a.from - b.from)).reverse();
  }
  const before = run.tokens.find((token) => token.index > index);
  const at = before ? before.from : run.end;
  // After a last glyph with no space (`★`, read back from `★ `), the space goes first.
  const bare = !before && text !== undefined && runEndsBare(run, text);
  const insert: TextEdit = {
    from: at,
    to: at,
    insert: bare ? ` ${symbol.glyph} ` : `${symbol.glyph} `,
  };
  // Applied in order from the end; a removal starting where the symbol goes comes first.
  return [insert, ...removals(extra)].sort((a, b) => b.from - a.from || b.to - a.to);
}

/**
 * A heading's text without its leading symbols, for matching it (A741, A748): any leading run
 * of tokens without letters or digits, each followed by a space, whatever the person's list
 * (the server has no list), so `## ? Open questions` is found as "Open questions". A heading
 * that is only such tokens keeps its text.
 */
export function withoutLeadingSymbols(text: string): string {
  const trimmed = text.trim();
  const rest = trimmed.replace(/^(?:[^\p{L}\p{N}\s]+[ \t]+)+/u, '');
  return rest.length > 0 ? rest : trimmed;
}

/** The form two headings are compared in: symbols dropped, trimmed, case folded. */
export const headingKey = (text: string): string => withoutLeadingSymbols(text).toLowerCase();

/** The form headings are compared in exactly: trimmed and case folded, symbols kept. */
export const exactHeadingKey = (text: string): string => text.trim().toLowerCase();

/**
 * The index of the heading `wanted` names among `headings` (their texts), or -1 (A748): one
 * whose text is the same, symbols and all, if there is one; else the first that is the same
 * without leading symbols on either side.
 */
export function findHeading(headings: readonly string[], wanted: string): number {
  const exact = exactHeadingKey(wanted);
  const found = headings.findIndex((text) => exactHeadingKey(text) === exact);
  if (found >= 0) return found;
  // Without symbols, a name two headings share (`★ Ideas`, `? Ideas`) names neither, as
  // `update_section` says it is ambiguous (T44 review, A748); written with its symbol it is found.
  const key = headingKey(wanted);
  const matches = headings.flatMap((text, index) => (headingKey(text) === key ? [index] : []));
  return matches.length === 1 ? matches[0]! : -1;
}
