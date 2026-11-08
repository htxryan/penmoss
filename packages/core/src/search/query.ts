/**
 * Search queries (T22): words, `"quoted phrases"` and `prefix*`, all of which
 * must match (AND). `-word` or `-"phrase"` leaves out notes holding it, and
 * `title:word` or `title:"phrase"` looks in the title only (A117). One parser
 * serves the server (an FTS5 MATCH expression) and the client's offline index
 * (`queryMatcher`), so both read a query the same way. Words are folded as the
 * index folds text; FTS5 stems them itself, and the client stems them with the
 * same porter step. A prefix term may carry completions (`completions.ts`,
 * A680): whole words of the index it starts, matched as words.
 */
import type { FtsColumn } from './fields';
import { stemTerm, tokenize } from './tokenize';

export interface QueryTerm {
  readonly kind: 'term';
  /** Folded, not stemmed. */
  readonly text: string;
  /** Matches every indexed term that starts with `text`, stemmed (as FTS5 does). */
  readonly prefix: boolean;
  /** Only this column (`title:`); absent: any column. */
  readonly column?: 'title';
  /** `-word`: notes holding it are left out; it never scores or marks anything. */
  readonly negated?: true;
  /**
   * A prefix term's completions (A680): words of the index that start with
   * `text` but whose stems the stem of `text` does not reach (`happin` and
   * `happiness`, stemmed `happi`). Each matches as a whole word, stemmed, as
   * one more phrase ORed with the prefix. Absent: none (or none looked up).
   */
  readonly completions?: readonly string[];
}

export interface QueryPhrase {
  readonly kind: 'phrase';
  /** Folded, not stemmed: consecutive tokens in one field. */
  readonly texts: readonly string[];
  readonly column?: 'title';
  readonly negated?: true;
}

export type QueryClause = QueryTerm | QueryPhrase;

export interface SearchQuery {
  readonly clauses: readonly QueryClause[];
}

/** Clauses kept from one query; the rest are dropped (each costs a posting-list read). */
export const MAX_CLAUSES = 12;
/** Shorter prefixes match too many terms to be worth a scan; they stay whole words. */
export const MIN_PREFIX_LENGTH = 2;

export interface ParseOptions {
  /**
   * Search as you type: the last word is a prefix unless the query ends with
   * a space (or a closing quote).
   */
  readonly prefixLast?: boolean;
}

interface Part {
  readonly text: string;
  readonly quoted: boolean;
  readonly negated: boolean;
  readonly column: 'title' | null;
}

const TITLE_PREFIX = /^title:(?=\S)/i;

/** The query's words and phrases, with their `-` and `title:` operators. */
function parts(input: string): Part[] {
  const out: Part[] = [];
  let at = 0;
  while (at < input.length) {
    if (/\s/.test(input[at]!)) {
      at++;
      continue;
    }
    let negated = false;
    let column: 'title' | null = null;
    if (input[at] === '-' && at + 1 < input.length && !/\s/.test(input[at + 1]!)) {
      negated = true;
      at++;
    }
    const titled = TITLE_PREFIX.exec(input.slice(at));
    if (titled) {
      column = 'title';
      at += titled[0].length;
    }
    if (input[at] === '"') {
      const close = input.indexOf('"', at + 1);
      out.push({
        text: input.slice(at + 1, close === -1 ? undefined : close),
        quoted: true,
        negated,
        column,
      });
      at = close === -1 ? input.length : close + 1;
      continue;
    }
    let end = at;
    while (end < input.length && !/[\s"]/.test(input[end]!)) end++;
    out.push({ text: input.slice(at, end), quoted: false, negated, column });
    at = end;
  }
  return out;
}

export function parseQuery(input: string, options: ParseOptions = {}): SearchQuery {
  const all = parts(input);
  const typingLast = Boolean(options.prefixLast) && /[^\s"]$/.test(input);
  const clauses: QueryClause[] = [];
  all.forEach((part, index) => {
    const starred = !part.quoted && part.text.endsWith('*');
    const texts = tokenize(part.text, { stem: false }).map((token) => token.term);
    if (texts.length === 0) return;
    const extra = {
      ...(part.column ? { column: part.column } : {}),
      ...(part.negated ? { negated: true as const } : {}),
    };
    if (texts.length > 1) {
      clauses.push({ kind: 'phrase', texts, ...extra });
      return;
    }
    const text = texts[0]!;
    const wantsPrefix =
      !part.negated && (starred || (!part.quoted && typingLast && index === all.length - 1));
    clauses.push({
      kind: 'term',
      text,
      prefix: wantsPrefix && text.length >= MIN_PREFIX_LENGTH,
      ...extra,
    });
  });
  return { clauses: clauses.slice(0, MAX_CLAUSES) };
}

function clauseMatch(clause: QueryClause): string {
  let phrase =
    clause.kind === 'term'
      ? `"${clause.text}"${clause.prefix ? '*' : ''}`
      : `"${clause.texts.join(' ')}"`;
  if (clause.kind === 'term' && clause.completions?.length) {
    // Folded words: letters and digits only, never a quote.
    phrase = `(${[phrase, ...clause.completions.map((word) => `"${word}"`)].join(' OR ')})`;
  }
  return clause.column ? `${clause.column} : ${phrase}` : phrase;
}

/**
 * The FTS5 MATCH expression for a query (every token quoted), or null when it
 * has nothing to look for (no words, or only exclusions).
 */
export function ftsMatch(query: SearchQuery): string | null {
  const kept = query.clauses.filter((clause) => !clause.negated);
  if (kept.length === 0) return null;
  // FTS5 ANDs phrases side by side, but a parenthesised OR (completions) only with AND.
  const grouped = kept.some((clause) => clause.kind === 'term' && clause.completions?.length);
  const wanted = kept.map(clauseMatch).join(grouped ? ' AND ' : ' ');
  const excluded = query.clauses.filter((clause) => clause.negated).map(clauseMatch);
  if (excluded.length === 0) return wanted;
  return `(${wanted})${excluded.map((each) => ` NOT ${each}`).join('')}`;
}

/**
 * Whether an indexed (stemmed) term is one the query looks for, for marking
 * matches: in `column` when given (a `title:` word only in titles). Excluded
 * words are never marked.
 */
export function queryMatcher(query: SearchQuery, column?: FtsColumn): (term: string) => boolean {
  const exact = new Set<string>();
  const prefixes: string[] = [];
  for (const clause of query.clauses) {
    if (clause.negated) continue;
    if (column !== undefined && clause.column !== undefined && clause.column !== column) continue;
    if (clause.kind === 'phrase') for (const text of clause.texts) exact.add(stemTerm(text));
    else {
      if (clause.prefix) prefixes.push(stemTerm(clause.text));
      else exact.add(stemTerm(clause.text));
      // A prefix's completions (A680), and the words holding a term inside them (A1126).
      for (const word of clause.completions ?? []) exact.add(stemTerm(word));
    }
  }
  return (term) => exact.has(term) || prefixes.some((prefix) => term.startsWith(prefix));
}
