export { stemTerm, terms, tokenize } from './tokenize';
export { FOLD_EXCEPTIONS, SEPARATOR_RANGES } from './unicode-table';
export { parseQuery, queryMatcher, type QueryClause, type SearchQuery } from './query';
export {
  COMPLETION_SCAN,
  MAX_COMPLETED_PREFIXES,
  MAX_COMPLETIONS,
  MIN_COMPLETION_LENGTH,
  compareCodePoints,
  completionPrefixes,
  completions,
  withCompletions,
} from './completions';
export { MATCH_END, MATCH_START, highlight, searchText, snippet } from './snippet';
export { reciprocalRankFusion } from './rrf';
export { SEARCH_MODES, type SearchMode } from './modes';
export {
  FAKE_FLOOR,
  HYBRID_DEPTH,
  MeaningIndex,
  MemoryVectorCache,
  VectorIndex,
  chunkKey,
  coverageNotice,
  dot,
  fakeEmbedder,
  fuseHybrid,
  normalize,
  type Embedder,
  type MeaningCoverage,
  type MeaningHit,
  type MeaningNote,
  type VectorCache,
} from './semantic';
export {
  CHUNK_MAX_CHARS,
  chunkNote,
  noteHeadings,
  noteSections,
  type NoteSection,
} from './sections';
export { BM25_B, BM25_K1, FTS_COLUMNS, FTS_WEIGHTS } from './fields';
export { MAX_NOTE_TEXT_BYTES, capNoteText } from './note-text';
