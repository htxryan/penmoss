/**
 * Partly typed words (#120, A680). The index holds stems, and a prefix is
 * matched against them after stemming what was typed (as FTS5 does), so a
 * word typed past its stem found nothing until it was finished: `happin*`
 * never reaches `happi` (happiness), nor `conditio*` `condit` (conditioning).
 *
 * Every client therefore keeps the index's words as written (folded, not
 * stemmed): the server in `notes_words` (migration 0011), the web in its
 * offline index, the phone in `note_word_fts`. A prefix term looks up the
 * first `COMPLETION_SCAN` words that start with it, in code-point order (as
 * SQLite sorts them), and keeps those whose stems its own stem cannot reach:
 * its completions. Each is matched as one more whole word, ORed with the
 * prefix, so it ranks (bm25, one phrase each) and marks as FTS5 ranks and
 * marks `"happin"* OR "happiness"`. Typing part of a word finds what the
 * whole word finds. The same words, the same completions, on every client.
 */
import type { QueryClause, SearchQuery } from './query';
import { stemTerm, tokenize } from './tokenize';

/** Shorter prefixes are left alone: porter keeps a word's first two letters (A680). */
export const MIN_COMPLETION_LENGTH = 3;
/** Words looked at per prefix, the first in code-point order (D1 reads one row for each). */
export const COMPLETION_SCAN = 64;
/** Completions kept per prefix (each is one more term FTS5 looks up). */
export const MAX_COMPLETIONS = 16;
/**
 * Prefixes completed per query: the last ones (the word being typed comes
 * last). A query of many `abc*` would otherwise read 64 words for each.
 */
export const MAX_COMPLETED_PREFIXES = 2;

/** Code-point order: UTF-8's, which is how SQLite compares the words it holds. */
export function compareCodePoints(a: string, b: string): number {
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const x = a.charCodeAt(i);
    const y = b.charCodeAt(i);
    if (x === y) continue;
    // A surrogate (an astral character) sorts after every other UTF-16 unit.
    const sx = x >= 0xd800 && x <= 0xdfff;
    const sy = y >= 0xd800 && y <= 0xdfff;
    if (sx !== sy) return sx ? 1 : -1;
    return x - y;
  }
  return a.length - b.length;
}

/** Bounds for a range scan of the words starting with `prefix`: `>=` the first, `<` the second. */
export function wordRange(prefix: string): readonly [string, string] {
  return [prefix, `${prefix}\u{10ffff}`];
}

/**
 * The completions of `prefix` among `words` (any order; ones that do not
 * start with it are ignored): of the first COMPLETION_SCAN in code-point
 * order, one word per stem that the prefix's stem does not reach, at most
 * MAX_COMPLETIONS.
 */
export function completions(prefix: string, words: Iterable<string>): string[] {
  const scanned = [...new Set(words)]
    .filter((word) => word.startsWith(prefix))
    .sort(compareCodePoints)
    .slice(0, COMPLETION_SCAN);
  const reached = stemTerm(prefix);
  const stems = new Set<string>();
  const out: string[] = [];
  for (const word of scanned) {
    const stem = stemTerm(word);
    if (stem.startsWith(reached) || stems.has(stem)) continue;
    stems.add(stem);
    out.push(word);
    if (out.length === MAX_COMPLETIONS) break;
  }
  return out;
}

function needsCompletions(clause: QueryClause): clause is QueryClause & { kind: 'term' } {
  return (
    clause.kind === 'term' &&
    clause.prefix &&
    !clause.negated &&
    clause.text.length >= MIN_COMPLETION_LENGTH
  );
}

/** The prefixes of a query to look completions up for, each once: the last MAX_COMPLETED_PREFIXES. */
export function completionPrefixes(query: SearchQuery): string[] {
  const out = new Set<string>();
  for (const clause of query.clauses.toReversed()) {
    if (out.size === MAX_COMPLETED_PREFIXES) break;
    if (needsCompletions(clause)) out.add(clause.text);
  }
  return [...out].reverse();
}

/** The query with each prefix term's completions, from `lookup` (a prefix's completions). */
export function withCompletions(
  query: SearchQuery,
  lookup: (prefix: string) => readonly string[],
): SearchQuery {
  let changed = false;
  const prefixes = new Set(completionPrefixes(query));
  const clauses = query.clauses.map((clause) => {
    if (!needsCompletions(clause) || !prefixes.has(clause.text)) return clause;
    const found = lookup(clause.text);
    if (found.length === 0) return clause;
    changed = true;
    return { ...clause, completions: [...found] };
  });
  return changed ? { clauses } : query;
}

/**
 * A note's distinct words, folded and not stemmed, in the order they first
 * appear: what the completion index holds for it.
 */
export function searchWords(columns: readonly string[]): string[] {
  const out = new Set<string>();
  for (const column of columns) {
    for (const { term } of tokenize(column, { stem: false })) out.add(term);
  }
  return [...out];
}
