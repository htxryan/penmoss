/**
 * Tag suggestions for the Info panel's Add a tag field (T42, #104 item 8, A577): every tag on
 * any note on this device, matched to what is typed. A tag starting with the text comes first,
 * then one with a level starting with it (`area/cook` for "cook"), then any containing it; the
 * more notes carry a tag, the higher it ranks among equals. Tags the note already has are left
 * out.
 */

/** How many suggestions the list shows. */
export const SUGGESTION_LIMIT = 8;

export function tagSuggestions(
  /** Every note's tags (one array per note), as the note list has them. */
  notes: Iterable<readonly string[]>,
  typed: string,
  /** The note's own tags. */
  exclude: readonly string[] = [],
  limit: number = SUGGESTION_LIMIT,
): string[] {
  const query = typed.trim().replace(/^#+/, '').toLowerCase();
  if (!query) return [];
  const counts = new Map<string, number>();
  for (const tags of notes) {
    for (const tag of new Set(tags)) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  const skip = new Set(exclude);
  const rank = (tag: string): number =>
    tag.startsWith(query)
      ? 0
      : tag.split('/').some((level) => level.startsWith(query))
        ? 1
        : tag.includes(query)
          ? 2
          : -1;
  return [...counts]
    .filter(([tag]) => !skip.has(tag) && rank(tag) >= 0)
    .sort(([a, countA], [b, countB]) => rank(a) - rank(b) || countB - countA || a.localeCompare(b))
    .slice(0, limit)
    .map(([tag]) => tag);
}
