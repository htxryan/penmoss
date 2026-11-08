// The local replica store and its records (T59, D49: the server's sync went with the server).
// The Yjs 14 replica lives in the `./yjs14` entry point, its keeper in `./keeper`, and
// attachments in `./attachments`.
export type {
  AttachmentMeta,
  AttachmentStore,
  PendingUpload,
  StoredAttachment,
  UploadUpdater,
} from './attachment-store';
export {
  ATTACHMENT_BYTES_STORE,
  ATTACHMENTS_STORE,
  DB_VERSION,
  DEFAULT_DB_NAME,
  META_STORE,
  NOTES_STORE,
  NoteStore,
  STATE_STORE,
  toMeta,
  UPLOADS_STORE,
  type NoteStoreOptions,
  type NoteText,
} from './idb';
export type { Actor, ActorKind, EngineName } from './protocol';
export type {
  NoteMeta,
  NoteRecord,
  RecordUpdater,
  RecordsUpdater,
  ReplicaStore,
  UnloadWrite,
} from './record';
export {
  NOTE_ROOT,
  sameRanges,
  type AttributedRun,
  type ClientRanges,
  type ClockRange,
  type PendingIds,
  type Replica,
  type UpdateInfo,
  type UpdateListener,
} from './replica';
