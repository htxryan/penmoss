/**
 * Finding a comment's passage again by its text (T52 item 5): when a thread's Yjs anchor is lost
 * (its text was deleted and written again, pasted over, or the note was rebuilt), its quote and
 * the text around it when it was made (`prefix`, `suffix`) find where it is now, even after small
 * edits. Plain text in, offsets out: the caller (`@penmoss/sync-client/comments`) maps them to
 * the note's body, and every client and the server find the same place.
 *
 * In order: the quote exactly (the one whose surroundings match best, when there are several);
 * then a span close to the quote (edit similarity of at least `MIN_QUOTE_SIMILARITY`), found from
 * pieces of the quote and the ends of its surroundings; then, for a passage rewritten in place,
 * the span between its unchanged surroundings. Bounded work: a few hundred candidate spans,
 * each compared on at most `COMPARED_CHARS` characters, so it stays cheap on long notes.
 */

export interface AnchorText {
  /** The passage's text; empty for a point. */
  readonly quote: string;
  /** Up to about 60 characters before it, and after it, when the thread was made. */
  readonly prefix: string;
  readonly suffix: string;
}

/**
 * How the passage was found: `exact`, its quote, once in the text; `exact-context`, its quote,
 * one of several, picked by its surroundings; `fuzzy`, text close to its quote; `context`, the
 * text between its surroundings (the passage itself was rewritten).
 */
export type AnchorFound = 'exact' | 'exact-context' | 'fuzzy' | 'context';

export interface TextMatch {
  readonly start: number;
  readonly end: number;
  readonly how: AnchorFound;
  /** How close the span is to the quote, 0–1 (1 for an exact match; a point's context score). */
  readonly similarity: number;
}

/** A fuzzy span must be at least this close to the quote. */
export const MIN_QUOTE_SIMILARITY = 0.6;
/** Surroundings at least this close place a rewritten passage, or a point. */
export const MIN_CONTEXT_SIMILARITY = 0.7;
/** Characters of each string compared: its first and last halves of this, for long ones. */
const COMPARED_CHARS = 120;
/** The length of the pieces looked up exactly to find candidates. */
const PIECE = 12;
const MAX_OCCURRENCES = 40;
const MAX_SPANS = 300;

/** Levenshtein distance (insertions, deletions and substitutions cost one). */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let previous = new Array<number>(b.length + 1);
  let current = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) previous[j] = j;
  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    const char = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j++) {
      const cost = char === b.charCodeAt(j - 1) ? 0 : 1;
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + cost);
    }
    [previous, current] = [current, previous];
  }
  return previous[b.length]!;
}

/** A long string as its first and last `COMPARED_CHARS / 2` characters. */
const compared = (text: string) =>
  text.length <= COMPARED_CHARS
    ? text
    : text.slice(0, COMPARED_CHARS / 2) + text.slice(-COMPARED_CHARS / 2);

/** How alike two strings are, 0–1: one minus their edit distance over the longer's length. */
export function similarity(a: string, b: string): number {
  const x = compared(a);
  const y = compared(b);
  const longest = Math.max(x.length, y.length);
  if (longest === 0) return 1;
  return 1 - editDistance(x, y) / longest;
}

function occurrences(text: string, piece: string): number[] {
  const found: number[] = [];
  if (!piece) return found;
  for (let at = text.indexOf(piece); at >= 0 && found.length < MAX_OCCURRENCES;) {
    found.push(at);
    at = text.indexOf(piece, at + 1);
  }
  return found;
}

/**
 * How well the text around `[start, end)` matches the passage's surroundings, 0–1 (the prefix's
 * and suffix's similarities, weighed by their lengths); null when it kept none.
 */
function contextScore(text: string, target: AnchorText, start: number, end: number) {
  const { prefix, suffix } = target;
  const total = prefix.length + suffix.length;
  if (total === 0) return null;
  const before = text.slice(Math.max(0, start - prefix.length), start);
  const after = text.slice(end, end + suffix.length);
  return (
    (similarity(before, prefix) * prefix.length + similarity(after, suffix) * suffix.length) / total
  );
}

/** Where the passage is in `text` now, or null when nothing there is close enough. */
export function findAnchorText(text: string, target: AnchorText): TextMatch | null {
  return target.quote ? findRange(text, target) : findPoint(text, target);
}

function findRange(text: string, target: AnchorText): TextMatch | null {
  const { quote, prefix, suffix } = target;
  const exact = occurrences(text, quote);
  if (exact.length === 1) {
    return { start: exact[0]!, end: exact[0]! + quote.length, how: 'exact', similarity: 1 };
  }
  if (exact.length > 1) {
    let best = exact[0]!;
    let bestScore = -1;
    for (const at of exact) {
      const score = contextScore(text, target, at, at + quote.length) ?? 0;
      if (score > bestScore) [best, bestScore] = [at, score];
    }
    return { start: best, end: best + quote.length, how: 'exact-context', similarity: 1 };
  }
  // Not there as it was: candidates from pieces of the quote, and from its surroundings' ends.
  const length = quote.length;
  const piece = Math.min(PIECE, length);
  const starts = new Set<number>();
  const ends = new Set<number>();
  const offsets = new Set<number>([0, Math.max(0, length - piece)]);
  for (let i = 1; i < 6; i++) offsets.add(Math.floor(((length - piece) * i) / 6));
  for (const offset of offsets) {
    for (const at of occurrences(text, quote.slice(offset, offset + piece))) {
      starts.add(Math.max(0, at - offset));
      ends.add(Math.min(text.length, at - offset + length));
    }
  }
  const fromPrefix = new Set<number>();
  const fromSuffix = new Set<number>();
  if (prefix.length >= 4) {
    const tail = prefix.slice(-PIECE);
    for (const at of occurrences(text, tail)) fromPrefix.add(at + tail.length);
  }
  if (suffix.length >= 4) {
    for (const at of occurrences(text, suffix.slice(0, PIECE))) fromSuffix.add(at);
  }
  for (const at of fromPrefix) {
    starts.add(at);
    ends.add(Math.min(text.length, at + length));
  }
  for (const at of fromSuffix) {
    ends.add(at);
    starts.add(Math.max(0, at - length));
  }
  type Span = { start: number; end: number; between: boolean };
  const spans = new Map<string, Span>();
  const add = (start: number, end: number, between = false) => {
    if (end <= start || spans.size >= MAX_SPANS) return;
    const key = `${start}:${end}`;
    const known = spans.get(key);
    if (known) known.between ||= between;
    else spans.set(key, { start, end, between });
  };
  const sortedEnds = [...ends].sort((a, b) => a - b);
  for (const start of starts) {
    add(start, Math.min(text.length, start + length));
    for (const end of sortedEnds) {
      if (end <= start + length / 2) continue;
      if (end > start + length * 2 + 20) break;
      add(start, end, fromPrefix.has(start) && fromSuffix.has(end));
    }
  }
  for (const end of ends) add(Math.max(0, end - length), end);
  // A rewritten passage between unchanged surroundings, however long it is now.
  for (const start of fromPrefix) {
    for (const end of fromSuffix) {
      if (end > start && end - start <= Math.max(length * 4, 400)) add(start, end, true);
    }
  }
  let best: TextMatch | null = null;
  let bestScore = -1;
  for (const span of spans.values()) {
    const close = similarity(text.slice(span.start, span.end), quote);
    const context = contextScore(text, target, span.start, span.end) ?? 0;
    let how: AnchorFound | null = null;
    if (close >= MIN_QUOTE_SIMILARITY) how = 'fuzzy';
    else if (span.between && context >= MIN_CONTEXT_SIMILARITY) how = 'context';
    if (!how) continue;
    const score = close * 0.6 + context * 0.4;
    if (score > bestScore) {
      bestScore = score;
      best = { start: span.start, end: span.end, how, similarity: close };
    }
  }
  return best;
}

/** A point: where its surroundings meet, exactly or nearly. */
function findPoint(text: string, target: AnchorText): TextMatch | null {
  const { prefix, suffix } = target;
  if (!prefix && !suffix) return null;
  const tail = prefix.slice(-PIECE);
  const head = suffix.slice(0, PIECE);
  const joined = occurrences(text, tail + head).map((at) => at + tail.length);
  const pick = (candidates: Iterable<number>) => {
    let best: number | null = null;
    let bestScore = -1;
    for (const at of candidates) {
      const score = contextScore(text, target, at, at) ?? 0;
      if (score > bestScore) [best, bestScore] = [at, score];
    }
    return best === null ? null : { at: best, score: bestScore };
  };
  if (joined.length > 0) {
    const found = pick(joined)!;
    return {
      start: found.at,
      end: found.at,
      how: joined.length === 1 ? 'exact' : 'exact-context',
      similarity: 1,
    };
  }
  const candidates = new Set<number>();
  if (tail) for (const at of occurrences(text, tail)) candidates.add(at + tail.length);
  if (head) for (const at of occurrences(text, head)) candidates.add(at);
  const found = pick(candidates);
  if (!found || found.score < MIN_CONTEXT_SIMILARITY) return null;
  return { start: found.at, end: found.at, how: 'context', similarity: found.score };
}
