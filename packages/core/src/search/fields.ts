/**
 * The full-text index's columns and their bm25 weights (T22), shared by the
 * server's `notes_fts` (migration 0006 stores the same weights as its rank)
 * and the client's offline index, so both rank alike. A title match counts
 * ten body matches; tags and headings sit between.
 */
export const FTS_COLUMNS = ['title', 'body', 'tags', 'headings'] as const;
export type FtsColumn = (typeof FTS_COLUMNS)[number];

export const FTS_WEIGHTS: Readonly<Record<FtsColumn, number>> = {
  title: 10,
  body: 1,
  tags: 5,
  headings: 4,
};

/** FTS5's bm25 constants (fts5_aux.c). */
export const BM25_K1 = 1.2;
export const BM25_B = 0.75;

/** The rank function `notes_fts` is configured with (`ORDER BY rank`). */
export const FTS_RANK = `bm25(${FTS_COLUMNS.map((column) => FTS_WEIGHTS[column].toFixed(1)).join(', ')})`;

/** One note as the full-text index stores it: one string per column. */
export interface SearchDocument {
  readonly title: string;
  readonly body: string;
  /** Space-separated tags. */
  readonly tags: string;
  /** One heading per line. */
  readonly headings: string;
}
