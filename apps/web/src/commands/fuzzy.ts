/**
 * Fuzzy matching for the palette and quick open (T20), after the prototype:
 * every query character must appear in order; runs, word starts and a
 * contiguous or prefix match score higher, long titles and late starts lower.
 */
export interface FuzzyMatch {
  readonly score: number;
  /** Matched character positions in the text (for highlighting). */
  readonly indices: readonly number[];
}

const WORD_BREAK = /[\s\-—–/:·(.,_#[]/;

export function fuzzy(query: string, text: string): FuzzyMatch | null {
  const q = query.toLowerCase().trim();
  if (!q) return { score: 0, indices: [] };
  const t = text.toLowerCase();
  let from = 0;
  let score = 0;
  let previous = -2;
  const indices: number[] = [];
  for (const char of q) {
    if (char === ' ') continue;
    const found = t.indexOf(char, from);
    if (found < 0) return null;
    indices.push(found);
    score += 1;
    if (found === previous + 1) score += 3;
    if (found === 0 || WORD_BREAK.test(t[found - 1] ?? '')) score += 4;
    previous = found;
    from = found + 1;
  }
  const contiguous = t.includes(q);
  const spread = indices.at(-1)! - indices[0]!;
  // Scattered single letters across a long title are noise, not a match.
  if (!contiguous && spread > q.replace(/\s/g, '').length * 3 + 4) return null;
  if (contiguous) score += 12;
  if (t.startsWith(q)) score += 6;
  return { score: score - t.length * 0.02 - (indices[0] ?? 0) * 0.05, indices };
}

/** Splits text into runs, marking matched characters (for <mark>-style highlighting). */
export function highlightRuns(
  text: string,
  indices: readonly number[],
): Array<{ readonly text: string; readonly match: boolean }> {
  const matched = new Set(indices);
  const runs: Array<{ text: string; match: boolean }> = [];
  [...text].forEach((char, index) => {
    const match = matched.has(index);
    const last = runs.at(-1);
    if (last && last.match === match) last.text += char;
    else runs.push({ text: char, match });
  });
  return runs;
}
