/// <reference types="node" />
/**
 * SQLite's own FTS5 (Node's built-in `node:sqlite`), the reference the
 * client's tokenizer and ranking must match (T22): D1 runs the same FTS5.
 * Node-only: import it from `*.node.test.ts` files.
 */
import { DatabaseSync } from 'node:sqlite';

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

export { DatabaseSync };
