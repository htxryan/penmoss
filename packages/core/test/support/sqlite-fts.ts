/// <reference types="node" />
/**
 * SQLite's own FTS5 (Node's built-in `node:sqlite`), the reference the
 * client's tokenizer and ranking must match (T22): D1 runs the same FTS5.
 * Node-only: import it from `*.node.test.ts` files.
 */
import { DatabaseSync } from 'node:sqlite';
import { tokenize as tokenizeText, type QueryClause, type SearchQuery } from '../../src/search';

/** The tokenizer of `notes_fts` (apps/server/migrations/0002_index.sql and 0006). */
export const NOTES_FTS_TOKENIZE = 'porter unicode61 remove_diacritics 2';

/** The terms SQLite's tokenizer makes of each text, in order (empty texts give none). */
export function sqliteTerms(texts: readonly string[], tokenize = NOTES_FTS_TOKENIZE): string[][] {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE VIRTUAL TABLE t USING fts5(a, tokenize = '${tokenize}');
             CREATE VIRTUAL TABLE v USING fts5vocab(t, 'instance');`);
    const insert = db.prepare('INSERT INTO t (rowid, a) VALUES (?, ?)');
    db.exec('BEGIN');
    texts.forEach((text, index) => insert.run(index + 1, text));
    db.exec('COMMIT');
    const out: string[][] = texts.map(() => []);
    const rows = db.prepare('SELECT doc, term FROM v ORDER BY doc, offset').all() as Array<{
      doc: number;
      term: string;
    }>;
    for (const row of rows) out[row.doc - 1]!.push(row.term);
    return out;
  } finally {
    db.close();
  }
}

/**
 * The FTS5 MATCH expression the server searched with (every token quoted), or
 * null when the query has nothing to look for (no words, or only exclusions):
 * the reference the offline index is checked against (`model/test/local-index.test.ts`).
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

/** Bounds for a range scan of the words starting with `prefix`: `>=` the first, `<` the second. */
export function wordRange(prefix: string): readonly [string, string] {
  return [prefix, `${prefix}\u{10ffff}`];
}

/**
 * A note's distinct words, folded and not stemmed, in the order they first
 * appear: what the server's completion index (`notes_words`) held for it.
 */
export function searchWords(columns: readonly string[]): string[] {
  const out = new Set<string>();
  for (const column of columns) {
    for (const { term } of tokenizeText(column, { stem: false })) out.add(term);
  }
  return [...out];
}

export { DatabaseSync };
