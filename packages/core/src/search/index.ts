export { defaultFold, stemTerm, terms, tokenize, type Token } from './tokenize';
export { FOLD_EXCEPTIONS, SEPARATOR_RANGES } from './unicode-table';
export {
  MAX_CLAUSES,
  MIN_PREFIX_LENGTH,
  parseQuery,
  queryMatcher,
  type ParseOptions,
  type QueryClause,
  type QueryPhrase,
  type QueryTerm,
  type SearchQuery,
} from './query';
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
export { ELLIPSIS, MATCH_END, MATCH_START, highlight, searchText, snippet } from './snippet';
export { RRF_K, reciprocalRankFusion, type Fused } from './rrf';
export { SEARCH_MODES, type SearchMode } from './modes';
export {
  FAKE_DIMENSIONS,
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
  type FusableTextHit,
  type FusedHit,
  type IndexedChunk,
  type MeaningCoverage,
  type MeaningHit,
  type MeaningNote,
  type MeaningSearchOptions,
  type UpdateOptions,
  type VectorCache,
} from './semantic';
export {
  CHUNK_MAX_CHARS,
  chunkNote,
  noteHeadings,
  noteSections,
  type NoteChunk,
  type NoteSection,
} from './sections';
export { BM25_B, BM25_K1, FTS_COLUMNS, FTS_WEIGHTS, type FtsColumn } from './fields';
export {
  MAX_NOTE_HEADINGS_BYTES,
  MAX_NOTE_TEXT_BYTES,
  capNoteText,
  noteTextKey,
} from './note-text';
