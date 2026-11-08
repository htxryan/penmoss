/**
 * Fuzzy matching for note titles (T16 `[[` completion; later quick open).
 * Every query character must appear in order in the text, ignoring case and
 * accents; matches that start words, run together or start the title rank
 * higher, and an exact title ranks highest. DOM-free and synchronous: the
 * editor ranks the local registry on each keystroke, offline included.
 */

/** Lower case without accents, keeping one code unit per character where possible. */
function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

const isBoundary = (text: string, index: number) =>
  index === 0 || /[\s\-_/.,:;()[\]{}'"#|]/.test(text[index - 1]!);

/**
 * A score for `text` against `query` (higher is better), or null when the
 * query's characters do not all appear in order. An empty query scores 0.
 */
export function fuzzyScore(query: string, text: string): number | null {
  return foldedScore(fold(query.trim()), fold(text));
}

/** `fuzzyScore` for a query and text already folded (`fold`). */
function foldedScore(q: string, t: string): number | null {
  if (q === '') return 0;
  if (t === q) return 1000;
  // Greedy, preferring word starts: for each query character, the next word
  // start holding it if there is one before a plain occurrence would be used.
  const chars = [...q].filter((char) => char !== ' ');
  let score = 0;
  let from = 0;
  let previous = -2;
  for (const [n, char] of chars.entries()) {
    let at = t.indexOf(char, from);
    if (at === -1) return null;
    if (at !== previous + 1) {
      for (let i = t.indexOf(char, at + 1); i !== -1; i = t.indexOf(char, i + 1)) {
        if (isBoundary(t, i) && !isBoundary(t, at) && isSubsequence(chars, n + 1, t, i + 1)) {
          at = i;
          break;
        }
      }
    }
    if (at === previous + 1) score += 6;
    if (isBoundary(t, at)) score += 8;
    if (at === 0) score += 10;
    score -= Math.min(at - from, 10) * 0.5;
    previous = at;
    from = at + 1;
  }
  if (t.startsWith(q)) score += 40;
  else if (t.includes(q)) score += 20;
  // Shorter titles win ties: the match covers more of them.
  return score - t.length * 0.05;
}

function isSubsequence(chars: readonly string[], from: number, text: string, at: number): boolean {
  let position = at;
  for (let i = from; i < chars.length; i++) {
    position = text.indexOf(chars[i]!, position);
    if (position === -1) return false;
    position++;
  }
  return true;
}

/** `items` matching `query`, best first (ties keep their order), at most `limit`. */
export function fuzzyFilter<T>(
  items: readonly T[],
  query: string,
  text: (item: T) => string,
  limit = Infinity,
): T[] {
  return rank(items, fold(query.trim()), (item) => fold(text(item)), limit);
}

function rank<T>(
  items: readonly T[],
  query: string,
  folded: (item: T) => string,
  limit: number,
): T[] {
  const scored: { item: T; score: number; index: number }[] = [];
  items.forEach((item, index) => {
    const score = foldedScore(query, folded(item));
    if (score !== null) scored.push({ item, score, index });
  });
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.slice(0, limit).map((entry) => entry.item);
}

/** Folded texts a matcher keeps; past this many it starts again (renames leave old ones behind). */
const MAX_FOLDED = 50_000;

/**
 * `fuzzyFilter` for ranking the same texts on every keystroke (`[[`
 * completion over the whole workspace): each text is folded once and kept.
 */
export class FuzzyMatcher {
  private readonly folded = new Map<string, string>();

  filter<T>(items: readonly T[], query: string, text: (item: T) => string, limit = Infinity): T[] {
    return rank(items, fold(query.trim()), (item) => this.fold(text(item)), limit);
  }

  private fold(text: string): string {
    let folded = this.folded.get(text);
    if (folded === undefined) {
      if (this.folded.size >= MAX_FOLDED) this.folded.clear();
      folded = fold(text);
      this.folded.set(text, folded);
    }
    return folded;
  }
}
