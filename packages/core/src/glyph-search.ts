/**
 * Finding an icon or a character by name (A1568): the icon picker's search, for Lucide's icons
 * (name, tags, aliases) and for the Characters (name, CLDR keywords), on the Mac and on Android
 * (`GlyphSearch.kt`, held to the same order by `contract/glyph-search-v1.json`).
 *
 * The query is split into words; an item is found when every word matches its name or one of
 * its keywords. Each word scores most for a whole word of the name, then the start of one, then
 * anywhere in the name, then a whole keyword, the start of one, and anywhere in one (three
 * letters or more). The whole query as the whole name, or the start of it, scores most of all,
 * and a pasted glyph finds itself first. Equal scores keep the items' own order.
 */

export interface Findable {
  /** Lower case, words split by spaces or hyphens (`notebook-pen`, `light bulb`). */
  readonly name: string;
  /** Other words it is found by (Lucide's tags and aliases, CLDR's keywords). */
  readonly keywords: readonly string[];
  /** The character itself, for a pasted one (`★`). */
  readonly glyph?: string;
}

/** Lower case, with hyphens, underscores, colons and runs of spaces as one space. */
export function normaliseQuery(text: string): string {
  return text
    .toLowerCase()
    .replace(/[-_:,]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const VARIATION_SELECTORS = /[︎️]/g;

const words = (text: string): string[] => normaliseQuery(text).split(' ').filter(Boolean);

/** How well one query word matches an item, or 0 when it does not. */
function wordScore(
  term: string,
  name: string,
  nameWords: readonly string[],
  keys: readonly string[],
): number {
  if (nameWords.includes(term)) return 6;
  if (nameWords.some((word) => word.startsWith(term))) return 4;
  if (name.includes(term)) return 3;
  if (keys.includes(term)) return 2.5;
  if (keys.some((key) => key.startsWith(term))) return 2;
  if (term.length >= 3 && keys.some((key) => key.includes(term))) return 1;
  return 0;
}

/** An item's score for a query (0: not found). `query` is already normalised. */
function glyphScore(item: Findable, query: string, raw = query): number {
  if (item.glyph && raw.trim() !== '') {
    const pasted = raw.trim().replace(VARIATION_SELECTORS, '');
    if (pasted === item.glyph.replace(VARIATION_SELECTORS, '')) return 1000;
  }
  const terms = query.split(' ').filter(Boolean);
  if (terms.length === 0) return 0;
  const name = normaliseQuery(item.name);
  const nameWords = name.split(' ');
  const keys = item.keywords.flatMap(words);
  let score = 0;
  for (const term of terms) {
    const each = wordScore(term, name, nameWords, keys);
    if (each === 0) return 0;
    score += each;
  }
  if (name === query) score += 100;
  else if (name.startsWith(query)) score += 20;
  return score;
}

/** The items a query finds, best first (all of them, in their order, for an empty query). */
export function findGlyphs<T extends Findable>(items: readonly T[], query: string): T[] {
  const normal = normaliseQuery(query);
  if (normal === '' && query.trim() === '') return [...items];
  const scored: Array<{ item: T; score: number; at: number }> = [];
  items.forEach((item, at) => {
    const score = glyphScore(item, normal, query);
    if (score > 0) scored.push({ item, score, at });
  });
  scored.sort((a, b) => b.score - a.score || a.at - b.at);
  return scored.map((each) => each.item);
}
