/**
 * Local replica storage (A7): one IndexedDB database with a single object
 * store keyed by note ID. Each record holds the merged Yjs update, its state
 * vector and the extracted plain text, unlike y-indexeddb, which opens one
 * database per document and appends an update log.
 */
import type { AttachmentMeta, AttachmentStore, StoredAttachment } from './attachment-store';
import type {
  NoteMeta,
  NoteRecord,
  RecordUpdater,
  ReplicaStore,
  UnloadWrite,
} from '@penmoss/sync-client/record';
import {
  decodeUnloadWrite,
  encodeUnloadWrite,
  UNLOAD_MAX_CHARS,
  unloadCopyId,
  withUnloadWrite,
  type UnloadOutcome,
} from './unload';
import { toMeta } from '@penmoss/sync-client/records';
import { WORKSPACE_RECORD_KEY } from '@penmoss/sync-client/workspace';

export type { NoteMeta, NoteRecord, UnloadWrite } from '@penmoss/sync-client/record';

export const NOTES_STORE = 'notes';
/** Small key-value state next to the notes, e.g. the tag-rename journal (T18). */
export const STATE_STORE = 'state';
/**
 * Each note's list metadata (`toMeta`), kept in step with the notes store in
 * the same transactions, so listing notes never deserialises update blobs.
 */
export const META_STORE = 'meta';
/** Attachment metadata keyed by SHA-256 (T10): files added here or fetched from the notebook. */
export const ATTACHMENTS_STORE = 'attachments';
/** Attachment bytes keyed by SHA-256, apart from the metadata so flag updates never copy them. */
export const ATTACHMENT_BYTES_STORE = 'attachmentBytes';
/**
 * Every git notebook's database (`penmoss-git-<id>`) was made at this version, after T50 (A860).
 * Versions 1 to 5 were the server-era personal database's, which nothing opens any more (D49); a
 * database from then may still hold an `uploads` store and a `syncClock` state, which nothing reads.
 */
export const DB_VERSION = 6;
/** The state store's key for how many unload changes to a note were dropped (A676). */
const UNLOAD_DROPS_PREFIX = 'unloadDrops:';
/**
 * Changes kept as a page went (A626), in the page's local storage under
 * `penmoss:unload:<database>:<noteId>:<page>:<source>`, merged into the records when the store next
 * opens. Local storage, not IndexedDB: a write it takes in `pagehide` is never lost, while an
 * IndexedDB transaction still open then is aborted with the page.
 */
const UNLOAD_PREFIX = 'penmoss:unload:';
/** How long a tab may take to save its open notes before it lets a newer version upgrade. */
const VERSION_CHANGE_GRACE_MS = 2000;

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function done(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error('IndexedDB transaction failed'));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
  });
}

export { toMeta };

export interface NoteStoreOptions {
  /**
   * Another tab holds an older version of the database open, so this open
   * waits. Called once; the open completes when that tab closes it (tabs
   * running this code close on `versionchange`).
   */
  readonly onBlocked?: () => void;
  /**
   * A newer version wants to upgrade the database (another tab loaded a newer
   * build). Awaited for up to two seconds, so open notes can be saved; the
   * connection then closes and later calls fail, so the app should reload.
   */
  readonly onVersionChange?: () => void | Promise<void>;
}

/** Writes a record and its list metadata (the transaction spans both stores). */
function write(transaction: IDBTransaction, record: NoteRecord): void {
  transaction.objectStore(NOTES_STORE).put(record);
  transaction.objectStore(META_STORE).put(toMeta(record));
}

/** The page's local storage, or null where there is none (a worker, Node, blocked storage). */
function pageStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** A note's searchable text (`listTexts`). */
export interface NoteText {
  readonly noteId: string;
  readonly title: string;
  readonly text: string;
  /** One heading per line (T22). */
  readonly headings: string;
  readonly tags: readonly string[];
  readonly updatedAt: number;
  readonly deleted: boolean;
}

export class NoteStore implements ReplicaStore, AttachmentStore {
  private closed = false;
  /** This connection's own key part for `putOnUnload`: two pages going at once never collide. */
  private readonly page = Math.random().toString(36).slice(2, 10);
  /** Told which records each committed write changed (`onWrite`). */
  private readonly writeListeners = new Set<(noteIds: readonly string[]) => void>();
  /** Records `adoptUnloadWrites` merged before anyone listened (for the first `onWrite`). */
  private adoptedIds: string[] = [];

  private constructor(
    private readonly db: IDBDatabase,
    options: NoteStoreOptions,
  ) {
    db.onversionchange = () => {
      const saved = Promise.resolve()
        .then(() => options.onVersionChange?.())
        .catch(() => undefined);
      const grace = new Promise((resolve) => setTimeout(resolve, VERSION_CHANGE_GRACE_MS));
      void Promise.race([saved, grace]).then(() => this.close());
    };
  }

  static async open(name: string, options: NoteStoreOptions = {}): Promise<NoteStore> {
    const request = indexedDB.open(name, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(NOTES_STORE)) {
        db.createObjectStore(NOTES_STORE, { keyPath: 'noteId' });
      }
      if (!db.objectStoreNames.contains(STATE_STORE)) db.createObjectStore(STATE_STORE);
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: 'noteId' });
      }
      if (!db.objectStoreNames.contains(ATTACHMENTS_STORE)) {
        db.createObjectStore(ATTACHMENTS_STORE, { keyPath: 'sha256' });
      }
      if (!db.objectStoreNames.contains(ATTACHMENT_BYTES_STORE)) {
        db.createObjectStore(ATTACHMENT_BYTES_STORE, { keyPath: 'sha256' });
      }
    };
    let blocked = false;
    request.onblocked = () => {
      if (blocked) return;
      blocked = true;
      options.onBlocked?.();
    };
    const store = new NoteStore(await promisify(request), options);
    // Before anything reads a record: what pages kept as they went joins it (A626).
    await store.adoptUnloadWrites().catch((error: unknown) => {
      console.warn('[idb] could not merge the changes kept as a page went', error);
    });
    return store;
  }

  /** True once the connection closed (after `close`, or for a newer version). */
  get isClosed(): boolean {
    return this.closed;
  }

  objectStoreNames(): string[] {
    return [...this.db.objectStoreNames];
  }

  async get(noteId: string): Promise<NoteRecord | undefined> {
    const store = this.db.transaction(NOTES_STORE, 'readonly').objectStore(NOTES_STORE);
    return (await promisify(store.get(noteId))) as NoteRecord | undefined;
  }

  /** A note's list metadata alone (`listMeta` for one note): no document bytes are read. */
  async getMeta(noteId: string): Promise<NoteMeta | undefined> {
    const store = this.db.transaction(META_STORE, 'readonly').objectStore(META_STORE);
    return (await promisify(store.get(noteId))) as NoteMeta | undefined;
  }

  /**
   * Calls `listener` after each committed write with the records it changed (a put, an update
   * that wrote, a delete), so other windows on the same database can read them at once (T45,
   * A711). Not for `putOnUnload`: the page is going. What the store merged from those as it
   * opened (`adoptUnloadWrites`), before anyone listened, goes to the first listener.
   */
  onWrite(listener: (noteIds: readonly string[]) => void): () => void {
    this.writeListeners.add(listener);
    const adopted = this.adoptedIds;
    this.adoptedIds = [];
    if (adopted.length > 0) this.wrote(adopted);
    return () => this.writeListeners.delete(listener);
  }

  private wrote(noteIds: readonly string[]): void {
    if (noteIds.length === 0) return;
    for (const listener of this.writeListeners) {
      try {
        listener(noteIds);
      } catch (error) {
        console.warn('[idb] a write listener failed', error);
      }
    }
  }

  async put(record: NoteRecord): Promise<void> {
    const transaction = this.db.transaction([NOTES_STORE, META_STORE], 'readwrite');
    write(transaction, record);
    await done(transaction);
    this.wrote([record.noteId]);
  }

  /**
   * Reads one record and writes what `fn` returns, in a single transaction. `fn` must be
   * synchronous; if it throws, nothing is written.
   */
  async update(noteId: string, fn: RecordUpdater): Promise<NoteRecord | null> {
    const transaction = this.db.transaction([NOTES_STORE, META_STORE], 'readwrite');
    const finished = done(transaction);
    let next: NoteRecord | null = null;
    let failure: unknown = null;
    const request = transaction.objectStore(NOTES_STORE).get(noteId);
    request.onsuccess = () => {
      try {
        next = fn(request.result as NoteRecord | undefined);
        if (next && next.noteId !== noteId) {
          throw new Error(`Record for ${next.noteId} under ${noteId}`);
        }
        if (next) write(transaction, next);
      } catch (error) {
        failure = error;
        transaction.abort();
      }
    };
    try {
      await finished;
    } catch (error) {
      throw failure ?? error;
    }
    const written = next as NoteRecord | null;
    if (written) this.wrote([written.noteId]);
    return written;
  }

  /**
   * Keeps `write` in local storage at once (A626, `ReplicaStore.putOnUnload`), under this
   * connection's and the write's source's own key: a later one of that source replaces it, any
   * other's sits beside it. `adoptUnloadWrites` merges it into the record when the store next
   * opens. Declines one larger than `UNLOAD_MAX_CHARS` (A640), so the origin's storage always
   * has room for the session.
   */
  putOnUnload(write: UnloadWrite): boolean {
    const storage = pageStorage();
    if (this.closed || !storage) return false;
    const value = encodeUnloadWrite(write);
    if (value.length > UNLOAD_MAX_CHARS) return false;
    try {
      storage.setItem(this.unloadKey(write.noteId, write.source), value);
      return true;
    } catch (error) {
      // Full, or not allowed: the caller writes as usual instead.
      console.warn('[idb] could not keep a change as the page went', error);
      return false;
    }
  }

  forgetUnload(noteId: string, source: string): void {
    try {
      pageStorage()?.removeItem(this.unloadKey(noteId, source));
    } catch {
      // Kept: merging it in again on the next open changes nothing.
    }
  }

  /**
   * Merges what pages kept as they went (`putOnUnload`) into the records, in one transaction,
   * then removes it (`withUnloadWrite` says what each makes). One that cannot be merged at all
   * (it throws) is dropped and reported, and the rest are merged (A640). Resolves how many
   * entries had each outcome.
   */
  async adoptUnloadWrites(): Promise<Record<UnloadOutcome | 'failed', number>> {
    return (await this.adoptKept()).counts;
  }

  /**
   * Merges a change another page keeps as it goes (`putOnUnload`) as soon as it is kept, not only
   * when the store next opens (A626; PR #167): the windows and tabs of one origin share local
   * storage, and its `storage` event fires here when another of them writes there, a window that
   * closes without storing its last keystrokes first included. The write listeners hear what it
   * merged (in the Mac app, the engine's window takes a git notebook's edits in and pushes them),
   * and `onMerged` too, for this page to read the records into what it shows. A page that goes
   * before this runs leaves the change in local storage, for the next open. Returns the
   * unsubscribe.
   */
  watchUnloadWrites(
    onMerged: (noteIds: readonly string[]) => void,
    target: EventTarget | null = typeof window === 'undefined' ? null : window,
  ): () => void {
    if (!target) return () => undefined;
    const prefix = this.unloadPrefix();
    let running = false;
    let again = false;
    const run = async () => {
      if (running) {
        again = true;
        return;
      }
      running = true;
      try {
        do {
          again = false;
          if (this.closed) return;
          const { written } = await this.adoptKept();
          if (written.length > 0) onMerged(written);
        } while (again);
      } catch (error) {
        console.warn('[idb] could not merge a change another window kept as it went', error);
      } finally {
        running = false;
      }
    };
    const onStorage = (event: Event) => {
      const { key, newValue } = event as StorageEvent;
      if (typeof key === 'string' && key.startsWith(prefix) && newValue !== null) void run();
    };
    target.addEventListener('storage', onStorage);
    return () => target.removeEventListener('storage', onStorage);
  }

  /**
   * `mergeKept`, claimed first (PR #167): every window of the origin hears the same entry, and
   * a Web Lock per store lets one merge it while the others wait, then find it gone. The claim
   * only saves work: the copy's id (`unloadCopyId`) is what makes them agree, and a window that
   * dies mid-merge lets the lock go with the entry still there, removed only once merged.
   */
  private async adoptKept(): Promise<{
    readonly counts: Record<UnloadOutcome | 'failed', number>;
    readonly written: readonly string[];
  }> {
    const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
    if (!locks) return this.mergeKept();
    return locks.request(`penmoss:unload-merge:${encodeURIComponent(this.name)}`, () =>
      this.mergeKept(),
    );
  }

  private async mergeKept(): Promise<{
    readonly counts: Record<UnloadOutcome | 'failed', number>;
    readonly written: readonly string[];
  }> {
    const counts = { merged: 0, unchanged: 0, described: 0, copied: 0, dropped: 0, failed: 0 };
    const written = new Set<string>();
    const storage = pageStorage();
    if (!storage) return { counts, written: [] };
    const prefix = this.unloadPrefix();
    const kept: Array<{ key: string; raw: string; write: UnloadWrite | null }> = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      const raw = key?.startsWith(prefix) ? storage.getItem(key) : null;
      if (key && raw !== null) kept.push({ key, raw, write: decodeUnloadWrite(raw) });
    }
    counts.failed = kept.filter(({ write }) => !write).length;
    const writes = await Promise.all(
      kept.flatMap(({ key, raw, write }) =>
        write
          ? [unloadCopyId(key, raw, write.updatedAt).then((copyId) => ({ write, copyId }))]
          : [],
      ),
    );
    // Folder changes that could not be kept, for the next folder notice (A676). Only the folder
    // tree's: a note's lost edits become conflict copies. Only unsynced ones: the engine has the
    // rest. An entry that cannot be read names its record in its key.
    const drops = new Map<string, number>();
    const dropped = (noteId: string, unsynced = true) => {
      if (noteId === WORKSPACE_RECORD_KEY && unsynced)
        drops.set(noteId, (drops.get(noteId) ?? 0) + 1);
    };
    for (const { key, write } of kept) {
      if (!write) dropped(key.slice(prefix.length).split(':')[0] ?? '');
    }
    if (writes.length > 0) {
      const transaction = this.db.transaction([NOTES_STORE, META_STORE], 'readwrite');
      const finished = done(transaction);
      const notes = transaction.objectStore(NOTES_STORE);
      // One at a time, each reading what the one before wrote: two pages may have kept changes
      // to the same note. The union is the same in any order.
      const adopt = (i: number) => {
        const entry = writes[i];
        if (!entry) return;
        const { write: next, copyId } = entry;
        const current = notes.get(next.noteId);
        current.onsuccess = () => {
          let made: ReturnType<typeof withUnloadWrite>;
          try {
            made = withUnloadWrite(current.result as NoteRecord | undefined, next, copyId);
          } catch (error) {
            counts.failed++;
            dropped(next.noteId, next.unsynced);
            console.error(
              `[idb] dropped a change to ${next.noteId} that could not be merged`,
              error,
            );
            adopt(i + 1);
            return;
          }
          const store = (records: readonly NoteRecord[], outcome: UnloadOutcome) => {
            for (const record of records) {
              write(transaction, record);
              written.add(record.noteId);
            }
            counts[outcome]++;
            if (outcome === 'dropped') dropped(next.noteId, next.unsynced);
            adopt(i + 1);
          };
          if (made.outcome !== 'copied') return store(made.records, made.outcome);
          // Another window merged this entry first and made its copy: that one stays.
          const existing = notes.get(copyId);
          existing.onsuccess = () =>
            existing.result === undefined ? store(made.records, 'copied') : store([], 'unchanged');
        };
      };
      adopt(0);
      await finished;
      // Other windows read these now (T45, A711); before any listener, the first one hears them.
      if (this.writeListeners.size > 0) this.wrote([...written]);
      else this.adoptedIds.push(...written);
    }
    // Counted before the entries go: a page that closes first counts them again on the next open
    // rather than losing them.
    if (drops.size > 0) await this.addUnloadDrops(drops);
    // Only what was read: a page still open may have kept a newer change meanwhile.
    for (const { key, raw } of kept) if (storage.getItem(key) === raw) storage.removeItem(key);
    if (counts.copied > 0) {
      console.info(`[idb] ${counts.copied} change(s) kept as a page went became conflict copies`);
    }
    return { counts, written: [...written] };
  }

  /** Adds to each record's count of unload changes that were dropped (A676). */
  private async addUnloadDrops(drops: ReadonlyMap<string, number>): Promise<void> {
    const transaction = this.db.transaction(STATE_STORE, 'readwrite');
    const store = transaction.objectStore(STATE_STORE);
    for (const [noteId, count] of drops) {
      const key = `${UNLOAD_DROPS_PREFIX}${noteId}`;
      const request = store.get(key);
      request.onsuccess = () => {
        const stored: unknown = request.result;
        store.put((typeof stored === 'number' ? stored : 0) + count, key);
      };
    }
    await done(transaction);
  }

  /** `ReplicaStore.takeUnloadDrops`: the count, read and cleared in one transaction (A676). */
  async takeUnloadDrops(noteId: string): Promise<number> {
    if (this.closed) return 0;
    const transaction = this.db.transaction(STATE_STORE, 'readwrite');
    const store = transaction.objectStore(STATE_STORE);
    const key = `${UNLOAD_DROPS_PREFIX}${noteId}`;
    let count = 0;
    const request = store.get(key);
    request.onsuccess = () => {
      const stored: unknown = request.result;
      if (typeof stored === 'number' && stored > 0) {
        count = stored;
        store.delete(key);
      }
    };
    await done(transaction);
    return count;
  }

  /** Encoded, so that no database's prefix is the start of another's. */
  private unloadPrefix(): string {
    return `${UNLOAD_PREFIX}${encodeURIComponent(this.name)}:`;
  }

  private unloadKey(noteId: string, source: string): string {
    return `${this.unloadPrefix()}${noteId}:${this.page}:${encodeURIComponent(source)}`;
  }

  /** A small value kept beside the notes (e.g. the tag-rename journal, T18), or undefined. */
  async getState(key: string): Promise<unknown> {
    const store = this.db.transaction(STATE_STORE, 'readonly').objectStore(STATE_STORE);
    return promisify(store.get(key));
  }

  /** Stores a small value beside the notes; undefined removes it. */
  async setState(key: string, value: unknown): Promise<void> {
    const transaction = this.db.transaction(STATE_STORE, 'readwrite');
    const store = transaction.objectStore(STATE_STORE);
    if (value === undefined) store.delete(key);
    else store.put(value, key);
    await done(transaction);
  }

  async delete(noteId: string): Promise<void> {
    const transaction = this.db.transaction([NOTES_STORE, META_STORE], 'readwrite');
    transaction.objectStore(NOTES_STORE).delete(noteId);
    transaction.objectStore(META_STORE).delete(noteId);
    await done(transaction);
    this.wrote([noteId]);
  }

  async keys(): Promise<string[]> {
    const store = this.db.transaction(NOTES_STORE, 'readonly').objectStore(NOTES_STORE);
    return (await promisify(store.getAllKeys())) as string[];
  }

  /** Everything the note list needs at startup, read in one request without the update blobs. */
  async listMeta(): Promise<NoteMeta[]> {
    const store = this.db.transaction(META_STORE, 'readonly').objectStore(META_STORE);
    return (await promisify(store.getAll())) as NoteMeta[];
  }

  /**
   * Every note's title and text, for searches over the local replica (T16
   * unlinked mentions while offline). Reads the whole store: use sparingly.
   */
  async listTexts(): Promise<NoteText[]> {
    const store = this.db.transaction(NOTES_STORE, 'readonly').objectStore(NOTES_STORE);
    const out: NoteText[] = [];
    await new Promise<void>((resolve, reject) => {
      const cursor = store.openCursor();
      cursor.onerror = () => reject(cursor.error ?? new Error('IndexedDB cursor failed'));
      cursor.onsuccess = () => {
        const current = cursor.result;
        if (!current) return resolve();
        const record = current.value as NoteRecord;
        out.push({
          noteId: record.noteId,
          title: toMeta(record).title,
          text: record.text,
          headings: record.headings ?? '',
          tags: record.tags ?? [],
          updatedAt: record.updatedAt,
          deleted: record.deleted ?? false,
        });
        current.continue();
      };
    });
    return out;
  }

  /** The database's name (tests and diagnostics). */
  get name(): string {
    return this.db.name;
  }

  async getAttachment(sha256: string): Promise<StoredAttachment | undefined> {
    const transaction = this.db.transaction([ATTACHMENTS_STORE, ATTACHMENT_BYTES_STORE]);
    const meta = transaction.objectStore(ATTACHMENTS_STORE).get(sha256);
    const bytes = transaction.objectStore(ATTACHMENT_BYTES_STORE).get(sha256);
    await done(transaction);
    const found = meta.result as AttachmentMeta | undefined;
    const stored = bytes.result as { bytes: Uint8Array } | undefined;
    return found && stored ? { ...found, bytes: stored.bytes } : undefined;
  }

  async saveAttachment(attachment: StoredAttachment): Promise<boolean> {
    const transaction = this.db.transaction(
      [ATTACHMENTS_STORE, ATTACHMENT_BYTES_STORE],
      'readwrite',
    );
    const metas = transaction.objectStore(ATTACHMENTS_STORE);
    const { bytes, ...meta } = attachment;
    let added = false;
    const existing = metas.get(attachment.sha256);
    existing.onsuccess = () => {
      transaction.objectStore(ATTACHMENT_BYTES_STORE).put({ sha256: attachment.sha256, bytes });
      if (existing.result === undefined) {
        added = true;
        metas.put(meta);
      }
    };
    await done(transaction);
    return added;
  }

  close(): void {
    this.closed = true;
    this.db.close();
  }
}
