/**
 * What the notes service (service.ts) works with and reports: this device's store, the note
 * registry, the source's sync, its options and its sync state, and the store's keys that are not
 * notes.
 */
import type { NoteLink } from '@penmoss/core/links';
import { type AttachmentStore } from '../store/attachment-store';
import { type NoteText } from '../store/idb';
import {
  type NoteMeta,
  type NoteRecord,
  type RecordUpdater,
  type ReplicaStore,
} from '@penmoss/model/record';
import { type AttachmentsElsewhere } from '../store/attachments';
import { WORKSPACE_RECORD_KEY } from '@penmoss/model/workspace';

/** What the app needs from local storage; NoteStore (IndexedDB) implements it. */
export interface LocalNotes extends ReplicaStore, AttachmentStore {
  update(noteId: string, fn: RecordUpdater): Promise<NoteRecord | null>;
  listMeta(): Promise<NoteMeta[]>;
  /** Removes a record (a note deleted for good, T21). */
  delete?(noteId: string): Promise<void>;
  /** One note's list metadata (another window stored it, T45). */
  getMeta?(noteId: string): Promise<NoteMeta | undefined>;
  /** Tells `listener` which records each committed write changed (T45, A711). */
  onWrite?(listener: (noteIds: readonly string[]) => void): () => void;
  /** Every note's text (offline unlinked mentions, T16). */
  listTexts?(): Promise<NoteText[]>;
  /** Small values kept with the notes (the tag-rename journal, T18). */
  getState?(key: string): Promise<unknown>;
  setState?(key: string, value: unknown): Promise<void>;
  /**
   * Merges what another window keeps as it goes as soon as it is kept (A626, PR #167), telling
   * `onMerged` which records it wrote; returns the unsubscribe.
   */
  watchUnloadWrites?(onMerged: (noteIds: readonly string[]) => void): () => void;
}

export interface TagChangeResult {
  readonly notes: readonly string[];
  /** Puts back what the changes did in each note, where its text is still as they left it. */
  readonly undo: () => Promise<readonly string[]>;
}

/** One note's outgoing links in the local replica (T16 backlinks and graph). */
export interface LocalLinks {
  readonly id: string;
  readonly title: string;
  readonly updatedAt: number;
  readonly unsynced: boolean;
  readonly links: readonly NoteLink[];
}

/** Keys in the notes store that are not notes (T7 keeps the WorkspaceDoc under `workspace`). */
export const RESERVED_KEYS: ReadonlySet<string> = new Set([WORKSPACE_RECORD_KEY]);
export const isReserved = (noteId: string) => RESERVED_KEYS.has(noteId);

/** The WorkspaceDoc's note registry (T7), told when a note is deleted or restored. */
export interface NoteRegistry {
  unregister(noteId: string): void;
  /** Files a new note beside `besideId` (a copy, A5): the same folder. */
  register?(noteId: string, besideId?: string): void;
  /** The note's folder now (null: top level), recorded when it goes to Trash (T21). */
  folderOf?(noteId: string): string | null;
  /** Files a note restored from Trash back in its folder, or the top level if that is gone (T21). */
  restore?(noteId: string, folderId: string | null): void;
  /**
   * Where a note out of Trash would go (T43 review B2): a folder (null: the top level), or no
   * place known (`refused`: Trash forgets the folder it was in), when the person is asked.
   */
  restorePlace?(
    noteId: string,
    folderId: string | null,
  ): { readonly folderId: string | null } | { readonly refused: true };
}

/**
 * How a source syncs (a git notebook's engine host, A860). The notes service's pill shows what
 * this says, and Delete for good goes through it.
 */
export interface LocalSyncBackend {
  /** Where its sync stands now (a stable reference between changes). */
  state(): LocalSyncState;
  subscribe(listener: () => void): () => void;
  /** Deletes a note in Trash for good (A828: the notebook's `purged` map; history keeps it). */
  purge(id: string): Promise<void>;
}

export interface LocalSyncState {
  readonly phase: 'offline' | 'syncing' | 'synced' | 'stopped';
  /** Why it stopped, or is offline, in the host's words where it gave some. */
  readonly detail: string | null;
  /**
   * Notes (and `workspace`) with changes not in a pushed commit yet. The records' own `unsynced`
   * flags mean nothing here: no server ever confirms them.
   */
  readonly pending: ReadonlySet<string>;
}

export interface NotesOptions {
  /** How the notes sync (a git notebook's engine, A860). */
  readonly backend: LocalSyncBackend;
  /** Salts derived ids (daily and weekly notes) within a git notebook (A820, A827, A1021). */
  readonly periodicSalt: string;
  /** Whether a note id was deleted for good in this source (a git notebook's `purged`, A828). */
  readonly isPurged?: (id: string) => boolean;
  /** Opens this device's store of the source's notes (a git notebook's own database). */
  readonly openStore: (hooks: StoreHooks) => Promise<LocalNotes>;
  readonly registry?: NoteRegistry;
  /** Whether the browser thinks it is online (`navigator.onLine`). */
  readonly online?: () => boolean;
  /** Asks the browser not to evict local storage (`navigator.storage.persist`). */
  readonly persistStorage?: () => Promise<boolean>;
  /** Where the notebook's attachments go and come from (its engine and clone, A1032). */
  readonly attachments?: AttachmentsElsewhere;
}

/** What the store reports about database versions (see NoteStore.open). */
export interface StoreHooks {
  readonly onBlocked: () => void;
  readonly onVersionChange: () => Promise<void>;
}

/** The app-wide sync state behind a source's dot. */
export interface AppSyncState {
  readonly phase: 'offline' | 'syncing' | 'synced' | 'stopped';
  /** Notes with changes not pushed yet. */
  readonly pending: number;
  /** Why syncing stopped, or a storage problem; null when all is well. */
  readonly detail: string | null;
  /**
   * What stopped it, while `phase` is `stopped` (T42, A578): this device's storage, or the git
   * notebook's sync. Decides where "Sync stopped" leads and what fixes it.
   */
  readonly reason?: SyncStopKind | null;
}

/**
 * What can stop sync (T42, A578): this device's storage, or a git notebook's sync (A860), whose
 * reason Settings → Notebooks says.
 */
type SyncStopKind = 'storage' | 'git';
