/**
 * A source's notes (A7, T8; T59): one IndexedDB store holding a full replica of every note of a
 * git notebook, the note list, creating, deleting and opening notes, and the sync state its
 * engine reports (A860).
 *
 * Opening a note is local-first: the replica is restored from IndexedDB and shown at once. A
 * note whose local write is still in flight (just created, or just closed) opens from memory: its
 * editor exists before the next keystroke, and it never reads back a record older than its last
 * edit. Each open note's `ReplicaKeeper` writes its changes back to the store (A1031); the
 * notebook's engine commits and pushes what is stored, and writes what it pulls into the store,
 * which the open notes read in (`pullStored`).
 *
 * Images (T10) live in the same store: `attachments` adds them and shows them from local bytes.
 */
import { ulid } from '@penmoss/core/ids';
import type { DocJson, NoteLink } from '@penmoss/core/links';
import {
  NoteStore,
  type AttachmentStore,
  toMeta,
  type NoteMeta,
  type NoteRecord,
  type NoteText,
  type RecordUpdater,
  type ReplicaStore,
} from '@penmoss/sync-client';
import { Attachments, type AttachmentsElsewhere } from '@penmoss/sync-client/attachments';
import { ReplicaKeeper, type ReplicaSnapshot } from '@penmoss/sync-client/keeper';
import {
  initNote,
  isDeleted,
  readTrashInfo,
  isoWithOffset,
  readTitle,
  setDeleted,
  setNoteNotebook,
} from '@penmoss/sync-client/note';
import { periodicNoteId, type PeriodKind } from '@penmoss/core/periodic';
import {
  changeRecord,
  deleteRecord,
  linksField,
  mergeRecords,
  needsLinks,
  newRev,
  recordFromUpdates,
  withLinks,
} from '@penmoss/sync-client/records';
import { noteTags, renameTagInDoc } from '@penmoss/sync-client/tags';
import { WORKSPACE_RECORD_KEY } from '@penmoss/sync-client/workspace';
import { bodyJson, createYjs14Replica, type Yjs14Replica } from '@penmoss/sync-client/yjs14';
import { applyLive, mergeNotes, type LiveNote, type NoteListEntry } from './list';

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
  /** Fills in older records' tags and headings after an upgrade (search awaits it, A119). */
  backfillSearchFields?(): Promise<void>;
  /**
   * Merges what another window keeps as it goes as soon as it is kept (A626, PR #167), telling
   * `onMerged` which records it wrote; returns the unsubscribe.
   */
  watchUnloadWrites?(onMerged: (noteIds: readonly string[]) => void): () => void;
}

/** Where tag renames wait until every note on this device has them (T18). */
const TAG_RENAMES_KEY = 'tagRenames';

interface TagRename {
  readonly from: string;
  readonly to: string;
}

const isTagRename = (value: unknown): value is TagRename =>
  typeof (value as TagRename | null)?.from === 'string' &&
  typeof (value as TagRename | null)?.to === 'string';

/** One note's outgoing links in the local replica (T16 backlinks and graph). */
export interface LocalLinks {
  readonly id: string;
  readonly title: string;
  readonly updatedAt: number;
  readonly unsynced: boolean;
  readonly links: readonly NoteLink[];
}

/** A note open for the embeds showing it (T13). */
interface EmbeddedNote {
  readonly note: OpenNote;
  readonly listeners: Set<() => void>;
  off: (() => void) | null;
  closing: ReturnType<typeof setTimeout> | null;
}

/** How long a note stays open after its last embed goes (T13). */
const EMBED_CLOSE_DELAY_MS = 2000;
/**
 * Notes open at once for embeds. Embeds follow notes only while on screen; past this many, the
 * rest wait for a turn and show this device's stored copy meanwhile.
 */
export const MAX_LIVE_EMBEDS = 8;

/** One embed's watch on a note: live once it has `off`, waiting for a turn before. */
interface EmbedWatch {
  readonly listener: () => void;
  off: (() => void) | null;
}

/** Keys in the notes store that are not notes (T7 keeps the WorkspaceDoc under `workspace`). */
export const RESERVED_KEYS: ReadonlySet<string> = new Set([WORKSPACE_RECORD_KEY]);
const isReserved = (noteId: string) => RESERVED_KEYS.has(noteId);

/** The WorkspaceDoc's note registry (T7), told when a note is deleted or restored. */
export interface NoteRegistry {
  unregister(noteId: string): void;
  /** Files a new note beside `besideId` (a copy, A5): the same folder, so the same notebook. */
  register?(noteId: string, besideId?: string): void;
  /** The note's folder now (null: top level), recorded when it goes to Trash (T21). */
  folderOf?(noteId: string): string | null;
  /** Files a note restored from Trash back in its folder, or the top level if that is gone (T21). */
  restore?(noteId: string, folderId: string | null): void;
  /**
   * Where a note out of Trash would go (T43 review B2): a folder (null: the top level), or no
   * safe place because its notebook was deleted (`refused`), when the person is asked.
   */
  restorePlace?(
    noteId: string,
    folderId: string | null,
  ):
    | { readonly folderId: string | null }
    | { readonly refused: true; readonly notebook: { id: string; name: string } | null };
  /** The notebook of a note filed in `folderId` (A766), or null when that is not certain. */
  notebookOf?(folderId: string | null): string | null;
}

/**
 * A note could not come out of Trash on its own (T43 review B2, A757): the folder it was deleted
 * from is gone and the way up passes a deleted notebook (`notebook`, while it is in Trash), so
 * there is no safe place for it. Nothing was restored; the app asks where to put it, or offers to
 * restore the notebook first. Never the default notebook's top level on its own.
 */
export class RestoreNeedsFolder extends Error {
  constructor(
    readonly noteId: string,
    readonly notebook: { readonly id: string; readonly name: string } | null,
  ) {
    super(
      notebook
        ? `The note was in “${notebook.name}”, which is in Trash. Restore the notebook, or choose a folder for the note.`
        : 'The folder the note was in is gone. Choose a folder for it.',
    );
    this.name = 'RestoreNeedsFolder';
  }
}

/** A note in Trash (T21). */
export interface TrashEntry {
  readonly id: string;
  readonly title: string;
  /** When it was deleted (epoch ms). */
  readonly deletedAt: number;
  /** Its folder when deleted (null: top level; undefined: not recorded here). */
  readonly folderId?: string | null;
}

/** How long Trash shows a note's days left for (T21). */
export const TRASH_DAYS = 30;

/**
 * Whole days left of a note deleted at `deletedAt`: 30 the day it was deleted, never more, even
 * when it was deleted after `now` was read or by a device whose clock runs ahead (B9).
 */
export function trashDaysLeft(deletedAt: number, now: number): number {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const left = Math.ceil((deletedAt + TRASH_DAYS * DAY_MS - now) / DAY_MS);
  return Math.min(TRASH_DAYS, Math.max(0, left));
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
  readonly openStore?: (hooks: StoreHooks) => Promise<LocalNotes>;
  readonly registry?: NoteRegistry;
  /** Whether the browser thinks it is online (`navigator.onLine`). */
  readonly online?: () => boolean;
  /** Asks the browser not to evict local storage (`navigator.storage.persist`). */
  readonly persistStorage?: () => Promise<boolean>;
  /** Where the notebook's attachments go and come from (its engine and clone, A1032). */
  readonly attachments?: AttachmentsElsewhere;
}

/** How long after a change an open note's tags are read again (T18). */
const TAGS_DELAY_MS = 400;

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
export type SyncStopKind = 'storage' | 'git';

const INITIAL_SYNC: AppSyncState = { phase: 'syncing', pending: 0, detail: null };
const RETRY_MAX_MS = 30_000;

/** One open note: its replica, its keeper and live list updates. */
export class OpenNote {
  readonly replica: Yjs14Replica = createYjs14Replica();
  readonly keeper: ReplicaKeeper;
  /** Resolves once the local copy (if any) is in the replica. */
  readonly ready: Promise<void>;
  private closed = false;
  /** The replica holds the note's local copy (so its state may stand for the note). */
  private loaded = false;
  private offUpdate: (() => void) | null = null;

  constructor(
    readonly id: string,
    private readonly notes: Notes,
    store: Promise<LocalNotes>,
    snapshot?: ReplicaSnapshot,
  ) {
    this.keeper = new ReplicaKeeper({
      noteId: id,
      replica: this.replica,
      store: lazyStore(store),
      title: () => readTitle(this.replica.doc),
      tags: () => noteTags(this.replica.doc),
      deleted: () => isDeleted(this.replica.doc),
      trashInfo: () => readTrashInfo(this.replica.doc),
      mergeRecords,
    });
    this.keeper.onChange(() => notes.syncChanged());
    let loaded: Promise<void>;
    if (snapshot) {
      // The note's latest state while its last write is in flight.
      this.keeper.restore(snapshot);
      loaded = Promise.resolve();
    } else {
      loaded = this.keeper.load();
    }
    this.ready = loaded.then(() => {
      if (this.closed) return;
      this.loaded = true;
      // Tags cost a walk of the document: read them once typing pauses (T18).
      let tagTimer: ReturnType<typeof setTimeout> | null = null;
      const readTags = () => {
        tagTimer = null;
        if (this.closed) return;
        notes.noteTagsChanged(id, noteTags(this.replica.doc));
        notes.noteLinksChanged(id, this.replica.links());
      };
      // Not now: opening a long note shows it first (T31); its tags follow a moment later.
      tagTimer = setTimeout(readTags, TAGS_DELAY_MS);
      const offTags = () => {
        if (tagTimer) clearTimeout(tagTimer);
      };
      const offChanges = this.replica.onUpdate((_update, _origin, info) => {
        // A comment is not an edit (T48, A770): it leaves the note where it is in Recent.
        if (info?.commentsOnly) return;
        notes.noteChanged(id, readTitle(this.replica.doc));
        tagTimer ??= setTimeout(readTags, TAGS_DELAY_MS);
      });
      this.offUpdate = () => {
        offChanges();
        offTags();
      };
    });
  }

  /** Local edits not pushed by the engine yet, as the record says (always true once edited). */
  get unsynced(): boolean {
    return this.keeper.unsynced;
  }

  /** Every change is in this device's store. */
  get savedLocally(): boolean {
    return this.keeper.savedLocally;
  }

  /** The last failed local write, while it is being retried. */
  get persistError(): unknown {
    return this.keeper.persistError;
  }

  /** Called when the keeper's save state changes (stored, or a write failed). */
  onSaveState(listener: () => void): () => void {
    return this.keeper.onChange(listener);
  }

  get isLoaded(): boolean {
    return this.loaded;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  flush(): Promise<void> {
    return this.keeper.flush();
  }

  /** Writes the latest state at once, beside a write in flight. */
  saveNow(): Promise<void> {
    return this.keeper.saveNow();
  }

  /** Keeps what the store lacks as the page goes, in this event (A626). */
  saveOnUnload(): void {
    this.keeper.saveOnUnload();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.offUpdate?.();
    // Closed before loading finished (React StrictMode does this): nothing to stand for the note.
    const snapshot: ReplicaSnapshot | null = this.loaded
      ? {
          update: this.replica.encodeStateAsUpdate(),
          epoch: this.keeper.currentEpoch,
          unsynced: this.keeper.unsynced,
          ...(this.keeper.isSeeded ? { seeded: true } : {}),
        }
      : null;
    // The keeper keeps retrying its final write; the replica stays until it lands.
    const written = this.keeper.destroy().finally(() => this.replica.destroy());
    this.notes.noteClosed(this, written, snapshot);
  }
}

/** The source of a closed note's in-flight snapshot kept as the page goes (A626, A640). */
const SNAPSHOT_SOURCE = 'snapshot';

/** How often another window's edits (text and time only) re-sort this window's list (T45). */
const LIST_REFRESH_MS = 1000;

/** Whether two list entries differ only in what every write changes (text, time, size). */
function sameListing(a: NoteMeta, b: NoteMeta): boolean {
  return (
    a.title === b.title &&
    a.deleted === b.deleted &&
    a.deletedAt === b.deletedAt &&
    a.deletedFrom === b.deletedFrom &&
    a.unsynced === b.unsynced &&
    a.linksVersion === b.linksVersion &&
    a.tags.join('\n') === b.tags.join('\n') &&
    JSON.stringify(a.links ?? null) === JSON.stringify(b.links ?? null)
  );
}

/** A ReplicaStore that waits for the store to open. */
function lazyStore(store: Promise<LocalNotes>): ReplicaStore {
  // The store once open, for the page-hide write, which cannot wait for a promise (A626).
  let opened: LocalNotes | null = null;
  void store.then(
    (ready) => (opened = ready),
    () => undefined,
  );
  return {
    get: async (noteId) => (await store).get(noteId),
    put: async (record) => (await store).put(record),
    update: async (noteId, fn) => (await store).update(noteId, fn),
    putOnUnload: (write) => opened?.putOnUnload?.(write) ?? false,
    forgetUnload: (noteId, source) => opened?.forgetUnload?.(noteId, source),
  };
}

/** Retries a local write with backoff until it lands (a full disk or a closing tab may fail it). */
async function untilStored(write: () => Promise<unknown>): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await write();
      return;
    } catch (error) {
      console.error('[notes] could not save locally; retrying', error);
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(RETRY_MAX_MS, 200 * 2 ** attempt)),
      );
    }
  }
}

const browserOnline = () => typeof navigator === 'undefined' || navigator.onLine !== false;

function browserPersist(): Promise<boolean> {
  const storage = typeof navigator === 'undefined' ? undefined : navigator.storage;
  return storage?.persist ? storage.persist() : Promise.resolve(false);
}

export class Notes {
  /** Images in notes (T10): stored here, shown from local bytes. */
  readonly attachments: Attachments;
  /** Whether the browser agreed not to evict local storage (null until asked). */
  persisted: boolean | null = null;
  private readonly openStore: (hooks: StoreHooks) => Promise<LocalNotes>;
  private readonly registry: NoteRegistry | undefined;
  private readonly online: () => boolean;
  private readonly persistStorage: () => Promise<boolean>;
  /** Tag renames in progress, one at a time (T18). */
  private renaming: Promise<unknown> = Promise.resolve();
  /** Other keepers flushed with the notes, e.g. the workspace's. */
  private readonly watched = new Set<ReplicaKeeper>();
  /** A list refresh for another window's edits, at most once a second (T45). */
  private listTimer: ReturnType<typeof setTimeout> | null = null;
  private store: Promise<LocalNotes> | null = null;
  /** The store once open, for the page-hide write (A626). */
  private opened: LocalNotes | null = null;
  private local = new Map<string, NoteMeta>();
  private readonly live = new Map<string, LiveNote>();
  private readonly open = new Set<OpenNote>();
  /** Notes deleted here, hidden at once (their records follow). */
  private readonly deleted = new Set<string>();
  /** Local writes in flight per note. */
  private readonly writes = new Map<string, Promise<void>>();
  /** The latest state of each note with a write in flight (see OpenNote's snapshot). */
  private readonly inMemory = new Map<string, ReplicaSnapshot>();
  private readonly listeners = new Set<() => void>();
  private readonly syncListeners = new Set<() => void>();
  /** Notes shown in embeds (T13), opened live while any embed shows them. */
  private readonly embedded = new Map<string, EmbeddedNote>();
  /** Watches waiting for a turn (`MAX_LIVE_EMBEDS`), by note id, oldest first. */
  private readonly embedWaiting = new Map<string, Set<EmbedWatch>>();
  private entries: NoteListEntry[] = [];
  private sync: AppSyncState = INITIAL_SYNC;
  private loaded = false;
  /** `refreshLocal`'s reads: how many started, and the latest one whose result is in `local`. */
  private localReads = 0;
  private localApplied = 0;
  private focusTitleOf: string | null = null;
  private focusBodyOf: string | null = null;
  private stopped: (() => void) | null = null;
  /** The running pass of `fillLinks`, if any. */
  private linksFilling: Promise<void> | null = null;
  private storageProblem: string | null = null;
  /** The git notebook's sync (A860). */
  private readonly backend: LocalSyncBackend;
  /** The salt of this source's derived ids (A820). */
  readonly periodicSalt: string;
  private readonly isPurged: (id: string) => boolean;

  constructor(options: NotesOptions) {
    this.backend = options.backend;
    this.periodicSalt = options.periodicSalt;
    this.isPurged = options.isPurged ?? (() => false);
    this.openStore = options.openStore ?? ((hooks) => NoteStore.open(undefined, hooks));
    this.registry = options.registry;
    this.online = options.online ?? browserOnline;
    this.persistStorage = options.persistStorage ?? browserPersist;
    this.attachments = new Attachments({
      store: () => this.localStore(),
      ...(options.attachments ? { elsewhere: options.attachments } : {}),
    });
  }

  /** How the source's sync stands (its engine's, A860). */
  localSync(): LocalSyncState {
    return this.backend.state();
  }

  /**
   * The id of a period's daily or weekly note in this source (T19): salted within the git
   * notebook (A820), and past any id deleted for good there (`<salt>#2`, …, A828).
   */
  periodicId(kind: PeriodKind, period: string): string {
    const salt = this.periodicSalt;
    let id = periodicNoteId(kind, period, salt);
    for (let round = 2; this.isPurged(id) && round < 100; round++) {
      id = periodicNoteId(kind, period, `${salt}#${round}`);
    }
    return id;
  }

  /** The salt `periodicId` used for `id` (what makes the note's document match it). */
  private saltOf(kind: PeriodKind, period: string, id: string): string {
    const salt = this.periodicSalt;
    for (let round = 1; round < 100; round++) {
      const each = round === 1 ? salt : `${salt}#${round}`;
      if (periodicNoteId(kind, period, each) === id) return each;
    }
    return salt;
  }

  /** The shared local store (the workspace keeps its record in it too, T7). */
  openLocal(): Promise<LocalNotes> {
    return this.localStore();
  }

  /** Flushes another keeper with the notes (the workspace's), and on a version change. */
  watchKeeper(keeper: ReplicaKeeper): () => void {
    this.watched.add(keeper);
    return () => this.watched.delete(keeper);
  }

  /** Opens the local store and loads the list, and follows the engine's sync. Idempotent. */
  start(): Promise<void> {
    if (!this.stopped) {
      // On page hide every change not stored yet is kept in that event, synchronously: a write
      // that waits for a callback is lost with the page (A626).
      const onPageHide = () => this.saveAllOnUnload();
      const onOnlineChange = () => this.syncChanged();
      // Hidden (the app in the background, maybe ended there): stored as on page hide, in case
      // this is the last event, and written to the records too, which other windows read.
      const onVisible = () => {
        if (document.visibilityState === 'hidden') {
          this.saveAllOnUnload();
          void this.saveAll();
        }
      };
      const browser = typeof window === 'undefined' ? null : window;
      browser?.addEventListener('pagehide', onPageHide);
      browser?.addEventListener('online', onOnlineChange);
      browser?.addEventListener('offline', onOnlineChange);
      if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);
      const offBackend = this.backend.subscribe(() => this.syncChanged());
      // Another window's last keystrokes, kept as it went without storing them (closed at once,
      // or its renderer gone): merged here at once, so this window shows them and the engine's
      // window takes them in and pushes them (PR #167).
      let offKept: (() => void) | null = null;
      let keptStopped = false;
      this.localStore().then(
        (store) => {
          if (keptStopped) return;
          offKept =
            store.watchUnloadWrites?.((ids) => {
              void this.pullStored(ids).catch(() => undefined);
            }) ?? null;
        },
        () => undefined,
      );
      this.stopped = () => {
        browser?.removeEventListener('pagehide', onPageHide);
        browser?.removeEventListener('online', onOnlineChange);
        browser?.removeEventListener('offline', onOnlineChange);
        if (typeof document !== 'undefined') {
          document.removeEventListener('visibilitychange', onVisible);
        }
        offBackend();
        keptStopped = true;
        offKept?.();
      };
      if (this.persisted === null) {
        this.persistStorage().then(
          (persisted) => (this.persisted = persisted),
          () => (this.persisted = false),
        );
      }
      this.syncChanged();
    }
    return this.refreshLocal().then(() => {
      // A tag rename the last session did not finish (the window closed) completes now.
      void this.resumeTagRenames();
    });
  }

  stop(): void {
    this.stopped?.();
    this.stopped = null;
    if (this.listTimer) clearTimeout(this.listTimer);
    this.listTimer = null;
  }

  /**
   * Writes every open note now, and waits for writes in flight (when the page is hidden, and
   * before the Mac app closes its window or quits, T29).
   */
  async saveAll(): Promise<void> {
    const writes = [
      ...[...this.open].map((note) => note.saveNow()),
      ...[...this.watched].map((keeper) => keeper.saveNow()),
      ...this.writes.values(),
    ];
    await Promise.all(writes.map((write) => write.catch(() => undefined)));
  }

  /**
   * The page is going (`pagehide`, A626): what the store lacks of every open note, every watched
   * document (the workspace) and every closed note whose write is still in flight is kept in
   * this event, synchronously, so a reload or a closed window keeps the last change. The store
   * merges it in when it next opens.
   */
  saveAllOnUnload(): void {
    for (const note of this.open) note.saveOnUnload();
    for (const keeper of this.watched) keeper.saveOnUnload();
    const store = this.opened;
    if (!store?.putOnUnload) return;
    // Kept under their own source even when the note is open again: an embed of it, or an editor
    // restored from the snapshot with no edits since, keeps nothing of it (A640).
    for (const [id, snapshot] of this.inMemory) {
      store.putOnUnload({
        noteId: id,
        engine: 'yjs14',
        source: SNAPSHOT_SOURCE,
        epoch: snapshot.epoch,
        update: snapshot.update,
        whole: true,
        unsynced: snapshot.unsynced,
        ...(snapshot.seeded ? { seeded: true } : {}),
        updatedAt: snapshot.updatedAt ?? Date.now(),
      });
    }
  }

  /**
   * Picks up what another writer stored (T30's capture window; T45's windows, A711; the engine,
   * A860): the note list, and the changes to notes open here. `ids` names the records written;
   * null reads everything.
   */
  async pullStored(ids: readonly string[] | null = null): Promise<void> {
    const wanted = ids ? new Set(ids) : null;
    // Open notes only: the page pulls the workspace itself.
    await Promise.all(
      [...this.open]
        .filter((note) => !wanted || wanted.has(note.id))
        .map((note) => note.keeper.pullStored().catch(() => false)),
    );
    const store = await this.localStore();
    if (!wanted || !store.getMeta || !this.loaded) {
      await this.refreshLocal();
      return;
    }
    // Only the named notes' list entries: a window reads them on every write of another.
    let listChanged = false;
    for (const id of wanted) {
      const meta = await store.getMeta(id);
      const before = this.local.get(id);
      if (meta) this.local.set(id, meta);
      else this.local.delete(id);
      if (!before || !meta || !sameListing(before, meta)) listChanged = true;
    }
    // A title, tag, link or Trash change shows at once; an edit's text and time (every write
    // while typing) re-sort the list at most once a second.
    if (listChanged) this.listChangedNow();
    else this.listChangedSoon();
  }

  private listChangedNow(): void {
    if (this.listTimer) clearTimeout(this.listTimer);
    this.listTimer = null;
    this.changed();
  }

  private listChangedSoon(): void {
    this.listTimer ??= setTimeout(() => {
      this.listTimer = null;
      this.changed();
    }, LIST_REFRESH_MS);
  }

  /** Tells `listener` which records this window stored, as it stores them (T45, A711). */
  onStored(listener: (ids: readonly string[]) => void): () => void {
    let off: (() => void) | null = null;
    let cancelled = false;
    this.localStore().then(
      (store) => {
        if (!cancelled) off = store.onWrite?.(listener) ?? null;
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
      off?.();
    };
  }

  /** True once the local list has been read. */
  get isLoaded(): boolean {
    return this.loaded;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** The list, newest first (a stable reference between changes). */
  list = (): NoteListEntry[] => this.entries;

  subscribeSync = (listener: () => void): (() => void) => {
    this.syncListeners.add(listener);
    return () => this.syncListeners.delete(listener);
  };

  /** The source's sync state (a stable reference between changes). */
  syncState = (): AppSyncState => this.sync;

  async refreshLocal(): Promise<void> {
    const read = ++this.localReads;
    const metas = await (await this.localStore()).listMeta();
    // Reads overlap (every stored write starts one) and a long list can take a while: one that
    // started earlier and ends later holds older records, and must not put them back. It did:
    // a note closed a moment after it was made went back to its first, untitled record once
    // its live title was dropped, and showed as Untitled in the list and in ⌘E.
    if (read < this.localApplied) return;
    this.localApplied = read;
    this.local = new Map(metas.map((meta) => [meta.noteId, meta]));
    this.loaded = true;
    this.changed();
    this.fillLinks();
  }

  /**
   * Computes, in the background, the links of notes stored before T16 (or by a build with an
   * older `LINKS_VERSION`): once each, stored in the record, one note at a time so the page stays
   * responsive. Their links show in the graph and Backlinks as they come; a note with none is
   * never revisited.
   */
  private fillLinks(): void {
    if (this.linksFilling) return;
    const pending = [...this.local.values()].filter((meta) => !meta.deleted && needsLinks(meta));
    if (pending.length === 0) return;
    this.linksFilling = (async () => {
      const store = await this.localStore();
      let found = false;
      for (const { noteId } of pending) {
        const stored = await store.update(noteId, (current) =>
          current && needsLinks(current) ? withLinks(current) : null,
        );
        if (stored) {
          this.local.set(noteId, toMeta(stored));
          found ||= Boolean(stored.links?.length);
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      if (found) this.changed();
    })()
      .catch((error: unknown) => console.warn('[notes] could not index older notes’ links', error))
      .finally(() => {
        this.linksFilling = null;
      });
  }

  /**
   * Whether `id` is a note of this source: on this device (trashed included) or made here this
   * session. Null while the local list is still being read. Opening an id nobody has would make
   * a new, empty note under it, so a link to one shows "Note not found" instead.
   */
  knows = (id: string): boolean | null => {
    if (this.local.has(id) || this.live.has(id)) return true;
    if (!this.loaded) return null;
    return false;
  };

  /**
   * Creates an empty note on this device and returns its id at once; the IndexedDB write
   * finishes in the background (`settled`). Its title field takes focus when it opens.
   */
  create(
    now: Date = new Date(),
    options: {
      readonly title?: string;
      readonly focus?: boolean;
      /**
       * The note's notebook (T43 review, A766), recorded in its own document: the folder it is
       * made in (`folderId`), or a notebook named outright (`notebook`, `default` for captures).
       */
      readonly folderId?: string | null;
      readonly notebook?: string;
    } = {},
  ): string {
    const id = ulid(now.getTime());
    const title = options.title?.replace(/[\r\n]+/g, ' ').trim() ?? '';
    const notebook =
      options.notebook ??
      (options.folderId !== undefined ? this.registry?.notebookOf?.(options.folderId) : null) ??
      null;
    const replica = createYjs14Replica();
    initNote(
      replica.doc,
      { id, created: isoWithOffset(now), kind: 'note', ...(notebook ? { notebook } : {}) },
      title,
    );
    const record: NoteRecord = {
      noteId: id,
      engine: replica.engine,
      update: replica.encodeStateAsUpdate(),
      stateVector: replica.encodeStateVector(),
      text: '',
      title,
      ...linksField([]),
      epoch: null,
      updatedAt: now.getTime(),
      unsynced: true,
      rev: newRev(),
    };
    replica.destroy();
    // A note created from a link (T16) keeps the focus where it is.
    if (options.focus !== false) this.focusTitleOf = id;
    this.live.set(id, { title, updatedAt: record.updatedAt });
    this.changed();
    // Only if nothing is stored yet: a retry must not overwrite edits saved meanwhile.
    const written = untilStored(async () =>
      (await this.localStore()).update(id, (current) => (current ? null : record)),
    );
    this.trackWrite(id, written, record);
    void written.then(() => this.refreshLocal());
    return id;
  }

  /**
   * Soft-deletes a note (A16): the flag syncs like any edit and lists hide it. It also leaves
   * the workspace registry (T7).
   */
  async deleteNote(id: string, options: { readonly folderId?: string | null } = {}): Promise<void> {
    this.deleted.add(id);
    this.changed();
    // Trash (T21) remembers when and from which folder, so a restore puts it back. A deleted
    // notebook's notes have left the registry already, so their folder is given (T43).
    const folderId =
      options.folderId !== undefined ? options.folderId : (this.registry?.folderOf?.(id) ?? null);
    const info = { at: Date.now(), folderId };
    const open = [...this.open].find((note) => note.id === id && note.isLoaded);
    if (open) {
      setDeleted(open.replica.doc, true, null, info);
    } else {
      await this.settled(id);
      await untilStored(async () =>
        (await this.localStore()).update(id, (current) =>
          current ? deleteRecord(current, true, info) : null,
        ),
      );
    }
    this.registry?.unregister(id);
  }

  /** Notes in Trash on this device, newest deletion first (T21), from the last list read. */
  localTrash(metas: Iterable<NoteMeta> = this.local.values()): TrashEntry[] {
    return [...metas]
      .filter((meta) => meta.deleted && !isReserved(meta.noteId))
      .map((meta) => ({
        id: meta.noteId,
        title: meta.title,
        deletedAt: meta.deletedAt ?? meta.updatedAt,
        ...(meta.deletedFrom !== undefined ? { folderId: meta.deletedFrom } : {}),
      }))
      .sort((a, b) => b.deletedAt - a.deletedAt);
  }

  /** Trash (T21): this source's deleted notes, read from storage. */
  async trash(): Promise<TrashEntry[]> {
    // Read from storage: a note deleted while open is written when it closes.
    return this.localTrash(await (await this.localStore()).listMeta());
  }

  /**
   * Takes a note out of Trash and files it back in the folder it was deleted from (T21), or where
   * the person chose. Restored on this device, offline too; it syncs like any edit. The note keeps
   * its id, so links to it still resolve.
   */
  async restoreFromTrash(
    id: string,
    options: {
      /** Where the person chose to put it (a folder, or null for the top level). */
      readonly folderId?: string | null;
    } = {},
  ): Promise<void> {
    const chosen = 'folderId' in options;
    const store = await this.localStore();
    const record = await store.get(id);
    if (!record?.deleted) throw new Error('This note is not in Trash on this device.');
    let folderId = chosen ? (options.folderId ?? null) : (record.deletedFrom ?? null);
    if (!chosen) {
      const place = this.registry?.restorePlace?.(id, folderId);
      if (place && 'refused' in place) throw new RestoreNeedsFolder(id, place.notebook);
      if (place) folderId = place.folderId;
    }
    this.deleted.delete(id);
    this.registry?.restore?.(id, folderId);
    await untilStored(() =>
      store.update(id, (current) => (current?.deleted ? deleteRecord(current, false) : null)),
    );
    // Where the person chose, recorded in the note itself (A766): perhaps another notebook.
    const notebook = chosen ? (this.registry?.notebookOf?.(folderId) ?? null) : null;
    if (notebook) await this.recordNotebook(id, notebook);
    await this.refreshLocal();
  }

  /**
   * Deletes a note in Trash for good (T21, A828): the notebook's `purged` map, then this device's
   * copy. Git keeps its history.
   */
  async purgeFromTrash(id: string): Promise<void> {
    const store = await this.localStore();
    await this.backend.purge(id);
    await store.delete?.(id);
    // Gone, not hidden: a daily note made again under its derived id (T19) is listed.
    this.deleted.delete(id);
    await this.refreshLocal();
  }

  /** Resolves once this note's local writes in flight have finished. */
  settled(id: string): Promise<void> {
    return (this.writes.get(id) ?? Promise.resolve()).catch(() => undefined);
  }

  /** This window's open copies of a note (T49: Send feedback reads their save state). */
  openCopies(id: string): readonly OpenNote[] {
    return [...this.open].filter((note) => note.id === id && !note.isClosed);
  }

  /**
   * The plain text of every note this window holds open (the editor, kept editors, embeds):
   * Send feedback drops a recent error that quotes any of them (T49, A791). Never sent.
   */
  openTexts(): string[] {
    const texts: string[] = [];
    for (const note of this.open) {
      if (note.isClosed || !note.isLoaded) continue;
      try {
        texts.push(note.replica.plainText());
      } catch {
        // A replica that cannot be read holds nothing to quote.
      }
    }
    return texts;
  }

  /** Opens a note for editing; call `close()` when done. */
  openNote(id: string): OpenNote {
    const note = new OpenNote(id, this, this.localStore(), this.inMemory.get(id));
    this.open.add(note);
    this.syncChanged();
    return note;
  }

  /**
   * Each listed note's outgoing links, from this device's replica (T16): the Backlinks panel and
   * the graph. Deleted notes link nowhere.
   */
  localLinks(): LocalLinks[] {
    const out: LocalLinks[] = [];
    for (const meta of this.local.values()) {
      if (meta.deleted || this.deleted.has(meta.noteId) || isReserved(meta.noteId)) continue;
      out.push({
        id: meta.noteId,
        title: this.live.get(meta.noteId)?.title ?? meta.title,
        updatedAt: meta.updatedAt,
        unsynced: meta.unsynced,
        // An open note's own, read as it changes, before its stored record catches up.
        links: this.live.get(meta.noteId)?.links ?? meta.links ?? [],
      });
    }
    return out;
  }

  /** Every local note's title and text (unlinked mentions, T16). */
  async localTexts(): Promise<NoteText[]> {
    const store = await this.localStore();
    const texts = (await store.listTexts?.()) ?? [];
    return texts.filter(
      (note) => !note.deleted && !this.deleted.has(note.noteId) && !isReserved(note.noteId),
    );
  }

  /**
   * A note's body as JSON (headings for `[[Title#`, T16; embeds, T13): from its open replica,
   * else from this device's copy. Null when there is none.
   */
  async body(id: string): Promise<DocJson | null> {
    const open = [...this.open].find((note) => note.id === id && note.isLoaded);
    if (open) return bodyJson(open.replica.doc);
    const snapshot = this.inMemory.get(id);
    const update = snapshot?.update ?? (await (await this.localStore()).get(id))?.update;
    if (!update) return null;
    const replica = createYjs14Replica();
    try {
      replica.applyUpdate(update);
      return bodyJson(replica.doc);
    } finally {
      replica.destroy();
    }
  }

  /**
   * A note's whole state now (T68: Duplicate, and copies to another notebook): its open
   * replica's, else this device's copy. Null when there is none.
   */
  async stateOf(id: string): Promise<Uint8Array | null> {
    const open = [...this.open].find((note) => note.id === id && note.isLoaded);
    if (open) return open.replica.encodeStateAsUpdate();
    const snapshot = this.inMemory.get(id);
    return snapshot?.update ?? (await (await this.localStore()).get(id))?.update ?? null;
  }

  /**
   * Stores a note made elsewhere as a new note of this notebook (T68: `copyNote`'s record), as
   * `create` stores an empty one: listed at once, written in the background (`settled`). The
   * caller files it in a folder.
   */
  addCopy(record: NoteRecord): string {
    const id = record.noteId;
    this.live.set(id, { title: record.title ?? '', updatedAt: record.updatedAt });
    this.changed();
    const written = untilStored(async () =>
      (await this.localStore()).update(id, (current) => (current ? null : record)),
    );
    this.trackWrite(id, written, record);
    void written.then(() => this.refreshLocal());
    return id;
  }

  /**
   * Follows a note's changes for embeds (T13): the note is opened as the editor opens one, shared
   * by every embed showing it, and closed a moment after the last one goes (an editor
   * re-rendering its embeds keeps it open). At most `MAX_LIVE_EMBEDS` notes are open: a watch
   * past that waits for a turn. `listener` runs on every change and once the note is loaded.
   * Nothing here writes to the note.
   */
  watchNote(id: string, listener: () => void): () => void {
    const watch: EmbedWatch = { listener, off: null };
    this.startWatch(id, watch);
    return () => {
      if (watch.off) {
        watch.off();
        watch.off = null;
        return;
      }
      const waiting = this.embedWaiting.get(id);
      waiting?.delete(watch);
      if (waiting?.size === 0) this.embedWaiting.delete(id);
    };
  }

  /** Follows `id` for `watch`: opens it if a turn is free, else queues the watch. */
  private startWatch(id: string, watch: EmbedWatch): void {
    let entry = this.embedded.get(id);
    if (!entry) {
      if (this.embedded.size >= MAX_LIVE_EMBEDS) {
        const waiting = this.embedWaiting.get(id) ?? new Set<EmbedWatch>();
        this.embedWaiting.set(id, waiting);
        waiting.add(watch);
        return;
      }
      entry = this.openEmbedded(id);
    }
    const current = entry;
    if (current.closing !== null) clearTimeout(current.closing);
    current.closing = null;
    current.listeners.add(watch.listener);
    watch.off = () => {
      current.listeners.delete(watch.listener);
      if (current.listeners.size > 0 || current.closing !== null) return;
      current.closing = setTimeout(() => {
        current.closing = null;
        if (current.listeners.size > 0 || this.embedded.get(id) !== current) return;
        this.embedded.delete(id);
        current.off?.();
        current.note.close();
        this.nextEmbedTurn();
      }, EMBED_CLOSE_DELAY_MS);
    };
  }

  private openEmbedded(id: string): EmbeddedNote {
    const note = this.openNote(id);
    const created: EmbeddedNote = {
      note,
      listeners: new Set(),
      off: null,
      closing: null,
    };
    void note.ready.then(() => {
      if (this.embedded.get(id) !== created) return;
      created.off = note.replica.onUpdate(() => {
        for (const each of created.listeners) each();
      });
      // Loaded: the body may differ from what the embed first read.
      for (const each of created.listeners) each();
    });
    this.embedded.set(id, created);
    return created;
  }

  /** Opens notes waiting for a turn, oldest first, while turns are free. */
  private nextEmbedTurn(): void {
    for (const [id, waiting] of this.embedWaiting) {
      if (this.embedded.size >= MAX_LIVE_EMBEDS) return;
      this.embedWaiting.delete(id);
      for (const watch of waiting) this.startWatch(id, watch);
    }
  }

  /** Whether the browser thinks it is online. */
  get isOnline(): boolean {
    return this.online();
  }

  /**
   * Makes sure the daily or weekly note of `period` is on this device (T19): one this source
   * holds opens (out of Trash if it was there); otherwise it is created from `template`, with
   * the deterministic update of A4, so a copy another device made offline merges into the same
   * note with one copy of the template. Returns its id.
   */
  async ensurePeriodic(kind: PeriodKind, period: string, template: string): Promise<string> {
    const id = this.periodicId(kind, period);
    const salt = this.saltOf(kind, period, id);
    if (this.entries.some((entry) => entry.id === id)) return id;
    const store = await this.localStore();
    const existing = await store.get(id);
    if (existing) {
      // Today's note in Trash comes back rather than opening deleted (T21).
      if (existing.deleted) await this.restoreFromTrash(id);
      else await this.refreshLocal();
      return id;
    }
    const [{ periodicNote }, codec] = await Promise.all([
      import('@penmoss/editor/periodic'),
      import('@penmoss/core'),
    ]);
    const note = periodicNote(codec, kind, period, template, salt);
    await store.update(id, (current) =>
      current ? null : recordFromUpdates(id, [note.update], { epoch: null, unsynced: true }),
    );
    this.deleted.delete(id);
    await this.refreshLocal();
    return id;
  }

  /**
   * Changes a note that may not be open (quick capture, T30). A copy open in this window takes
   * the change, so its editor shows it at once; otherwise the note is opened from the local
   * replica, changed, stored and closed. Resolves once the change is stored on this device.
   */
  async editNote(id: string, edit: (doc: OpenNote['replica']['doc']) => void): Promise<void> {
    await this.settled(id);
    const open = [...this.open].reverse().find((note) => note.id === id && !note.isClosed);
    if (open) {
      await open.ready;
      if (!open.isClosed) {
        edit(open.replica.doc);
        await open.flush();
        return;
      }
    }
    const note = this.openNote(id);
    await note.ready;
    edit(note.replica.doc);
    await note.flush();
    note.close();
  }

  /**
   * Records the note's notebook in its own document (T43 review, A766), after this device moved
   * it to another notebook.
   */
  async recordNotebook(id: string, notebook: string): Promise<void> {
    try {
      await this.editNote(id, (doc) => setNoteNotebook(doc, notebook));
    } catch (error) {
      console.error('[notes] could not record a note’s notebook', id, error);
    }
  }

  /** Asks the note's body to take focus once it opens (the palette and switcher, T20). */
  requestBodyFocus(id: string): void {
    this.focusBodyOf = id;
  }

  /** Whether the note's body should take focus when it opens (asked once). */
  takeBodyFocus(id: string): boolean {
    if (this.focusBodyOf !== id) return false;
    this.focusBodyOf = null;
    return true;
  }

  /** Whether the note was just created here, so its title field should take focus (asked once). */
  takeTitleFocus(id: string): boolean {
    if (this.focusTitleOf !== id) return false;
    this.focusTitleOf = null;
    return true;
  }

  /** @internal Called by OpenNote on every change. */
  noteChanged(id: string, title: string): void {
    const previous = this.live.get(id);
    const updatedAt = Date.now();
    if (previous && previous.title === title && previous.updatedAt === updatedAt) return;
    this.setLive(id, { ...previous, title, updatedAt });
  }

  /** @internal Called by OpenNote a moment after changes, with the note's tags (T18). */
  noteTagsChanged(id: string, tags: readonly string[]): void {
    const previous = this.live.get(id);
    if (previous?.tags && previous.tags.join(' ') === tags.join(' ')) return;
    const entry = this.entries.find((candidate) => candidate.id === id);
    if (!previous && entry && entry.tags.join(' ') === tags.join(' ')) return;
    this.setLive(id, {
      ...previous,
      title: previous?.title ?? entry?.title ?? '',
      updatedAt: previous?.updatedAt ?? 0,
      tags,
    });
  }

  /** @internal Called by OpenNote with its tags, with the note's links (T51, A936). */
  noteLinksChanged(id: string, links: readonly NoteLink[]): void {
    const previous = this.live.get(id);
    const known = previous?.links ?? this.local.get(id)?.links ?? [];
    if (JSON.stringify(known) === JSON.stringify(links)) return;
    const entry = this.entries.find((candidate) => candidate.id === id);
    this.setLive(id, {
      ...previous,
      title: previous?.title ?? entry?.title ?? '',
      updatedAt: previous?.updatedAt ?? 0,
      links,
    });
  }

  private setLive(id: string, change: LiveNote): void {
    this.live.set(id, change);
    const patched = applyLive(this.entries, id, change);
    if (!patched) return this.changed();
    this.entries = patched;
    this.notify();
  }

  /**
   * Renames a tag, or merges it into one that exists (T18, T24), in every note that has it (and
   * the levels nested under it), notes in Trash included, through each note's own document:
   * open notes in their editor's replica, the rest in the local store. The rename is journalled
   * first, so one cut short (the window closed) completes the next time the app starts. Returns
   * the notes covered.
   */
  renameTag(from: string, to: string): Promise<string[]> {
    const run = this.renaming.then(async () => {
      const store = await this.localStore();
      const pending = await this.pendingRenames(store);
      await store.setState?.(TAG_RENAMES_KEY, [...pending, { from, to }]);
      const changed = await this.applyTagRename(store, from, to);
      await this.finishRename(store, { from, to });
      return changed;
    });
    this.renaming = run.catch(() => undefined);
    return run;
  }

  /** Notes on this device with `tag` or a tag nested under it: stored (Trash included) and open. */
  private async notesTagged(store: LocalNotes, tag: string): Promise<Set<string>> {
    const has = (tags: readonly string[] | undefined) =>
      (tags ?? []).some((name) => name === tag || name.startsWith(`${tag}/`));
    // Stored notes (Trash included, so a restore never brings the old tag back), and what open
    // notes show now (a tag typed a moment ago is not stored yet).
    const affected = new Set<string>();
    for (const meta of await store.listMeta()) {
      if (!isReserved(meta.noteId) && has(meta.tags)) affected.add(meta.noteId);
    }
    for (const entry of this.entries) if (has(entry.tags)) affected.add(entry.id);
    return affected;
  }

  /** Resolves once no tag rename is running (tests). */
  async whenRenamed(): Promise<void> {
    await this.renaming;
  }

  /** Completes the renames a previous session journalled but did not finish. */
  private resumeTagRenames(): Promise<unknown> {
    this.renaming = this.renaming
      .then(async () => {
        const store = await this.localStore();
        for (const rename of await this.pendingRenames(store)) {
          await this.applyTagRename(store, rename.from, rename.to);
          await this.finishRename(store, rename);
        }
      })
      .catch((error: unknown) => console.warn('[notes] could not finish a tag rename', error));
    return this.renaming;
  }

  private async pendingRenames(store: LocalNotes): Promise<TagRename[]> {
    const value = await store.getState?.(TAG_RENAMES_KEY);
    return Array.isArray(value) ? value.filter(isTagRename) : [];
  }

  private async finishRename(store: LocalNotes, done: TagRename): Promise<void> {
    const pending = await this.pendingRenames(store);
    const index = pending.findIndex((rename) => rename.from === done.from && rename.to === done.to);
    if (index >= 0) pending.splice(index, 1);
    await store.setState?.(TAG_RENAMES_KEY, pending.length > 0 ? pending : undefined);
  }

  private async applyTagRename(store: LocalNotes, from: string, to: string): Promise<string[]> {
    const affected = await this.notesTagged(store, from);
    const changed: string[] = [];
    for (const id of affected) {
      const open = [...this.open].find((note) => note.id === id && note.isLoaded);
      if (open) {
        if (renameTagInDoc(open.replica.doc, from, to)) changed.push(id);
        continue;
      }
      let did = false;
      await store.update(id, (record) => {
        if (!record) return null;
        let renamed = false;
        const next = changeRecord(record, (doc) => {
          renamed = renameTagInDoc(doc, from, to);
        });
        did = renamed;
        return renamed ? { ...next, updatedAt: Date.now() } : null;
      });
      if (did) changed.push(id);
    }
    await this.refreshLocal();
    return changed;
  }

  /** @internal */
  noteClosed(note: OpenNote, written: Promise<void>, snapshot: ReplicaSnapshot | null): void {
    this.open.delete(note);
    if (snapshot) this.trackWrite(note.id, written, snapshot);
    // Once the closing write lands, the stored record is current: drop the live override.
    void written
      .then(() => this.refreshLocal())
      .then(() => {
        if ([...this.open].some((other) => other.id === note.id)) return;
        if (this.live.delete(note.id)) this.changed();
      });
    this.syncChanged();
  }

  /** @internal Recomputes the source's sync state. */
  syncChanged(): void {
    const next = this.computeSync();
    const current = this.sync;
    if (
      current.phase === next.phase &&
      current.pending === next.pending &&
      current.detail === next.detail &&
      (current.reason ?? null) === (next.reason ?? null)
    ) {
      return;
    }
    this.sync = next;
    for (const listener of this.syncListeners) listener();
  }

  /** @internal Storage hooks for NoteStore.open (blocked upgrades, newer versions). */
  storeHooks(): StoreHooks {
    return {
      onBlocked: () => {
        this.storageProblem = 'Close other Penmoss windows to finish updating';
        this.syncChanged();
      },
      onVersionChange: async () => {
        await Promise.allSettled([
          ...[...this.open].map((note) => note.flush()),
          ...[...this.watched].map((keeper) => keeper.flush()),
        ]);
        this.storageProblem = 'Penmoss was updated in another window: reload this one';
        this.syncChanged();
      },
    };
  }

  private computeSync(): AppSyncState {
    if (this.storageProblem) {
      return { phase: 'stopped', pending: 0, detail: this.storageProblem, reason: 'storage' };
    }
    // What the engine says (A860), and the changes it has not pushed yet.
    const local = this.backend.state();
    const pending = [...local.pending].filter((id) => !isReserved(id)).length;
    if (local.phase === 'stopped') {
      return { phase: 'stopped', pending, detail: local.detail, reason: 'git' };
    }
    const phase = local.phase === 'synced' && pending > 0 ? 'syncing' : local.phase;
    return { phase, pending, detail: local.detail };
  }

  /**
   * Remembers a write of `snapshot` until it (and every earlier write of the note) has landed;
   * until then the note opens from `snapshot`. A write that fails keeps its snapshot (writes
   * retry until they land).
   */
  private trackWrite(id: string, write: Promise<void>, snapshot: ReplicaSnapshot): void {
    const all = Promise.all([this.writes.get(id), write]).then(() => undefined);
    this.writes.set(id, all);
    this.inMemory.set(id, snapshot);
    void all.then(
      () => {
        if (this.writes.get(id) !== all) return;
        this.writes.delete(id);
        this.inMemory.delete(id);
        // Stored: what the page kept of the snapshot as it hid needs no merging in.
        this.opened?.forgetUnload?.(id, SNAPSHOT_SOURCE);
      },
      () => undefined,
    );
  }

  private localStore(): Promise<LocalNotes> {
    this.store ??= this.openStore(this.storeHooks()).then((store) => {
      this.opened = store;
      return store;
    });
    return this.store;
  }

  private changed(): void {
    const entries = mergeNotes(this.local.values(), this.live);
    this.entries = entries.filter((entry) => !this.deleted.has(entry.id) && !isReserved(entry.id));
    this.notify();
    this.syncChanged();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
