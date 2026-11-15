/** The sync engine (T50, A822): the class, what it is given and reports, and its errors. */
export { commitMessage } from './build';
export { GitNotebookEngine } from './engine';
export { NotebookError, type NotebookErrorCode } from './errors';
export {
  MAX_ACTOR_BYTES,
  MAX_ATTEMPTS,
  MAX_LOG_BYTES,
  RETIRE_WRITER_AFTER_IDS,
  type CopyToWithhold,
  type EngineOptions,
  type SyncOptions,
  type SyncReport,
} from './options';
