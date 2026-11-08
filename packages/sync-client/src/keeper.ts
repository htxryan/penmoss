/**
 * Keeps one Yjs document's replica in the local store (T59, A1031): it restores the replica from
 * IndexedDB, writes every change back (debounced while typing, at once on `saveNow`, in the
 * `pagehide` event through `saveOnUnload`), merges in what another window stored, and on
 * `destroy` resolves once every change is stored.
 *
 * It is the persistence half of the server's old `SyncProvider`, with the WebSocket, the
 * handshake, acks and stop reasons taken out: a git notebook's engine syncs the store, never
 * the replica (A860). The write logic (sequence numbers, merging a foreign record, the unload
 * write) is the provider's, unchanged, since it is what kept edits safe across windows (T45,
 * A626, A711).
 */
import type { NoteLink } from '@penmoss/core/links';
import { linksField, type NoteRecord, type ReplicaStore } from './record';
import type { Replica, UpdateInfo } from './replica';

/** A note's state held in memory, e.g. while its last write is still in flight. */
export interface ReplicaSnapshot {
  readonly update: Uint8Array;
  readonly epoch: string | null;
  readonly unsynced: boolean;
  /** Kept from records the Penmoss server once seeded (`NoteRecord.seeded`). */
  readonly seeded?: boolean | undefined;
  readonly rev?: string | undefined;
  /** When its content last changed (the record's `updatedAt`). */
  readonly updatedAt?: number | undefined;
}

export interface ReplicaKeeperOptions {
  readonly noteId: string;
  readonly replica: Replica;
  readonly store?: ReplicaStore;
  /** Reads the note's title for the stored record (`readTitle` from `./note`). */
  readonly title?: () => string;
  /** Reads the note's soft-delete flag for the stored record (`isDeleted` from `./note`). */
  readonly deleted?: () => boolean;
  /** When and from which folder a deleted note was deleted (`readTrashInfo` from `./note`, T21). */
  readonly trashInfo?: () => { readonly at?: number; readonly folderId?: string | null };
  /** Reads the note's tags for the stored record (`noteTags` from `./tags`, T18). */
  readonly tags?: () => string[];
  /**
   * Merges a record someone else stored (another window) with this keeper's (`mergeRecords`
   * from `./records`). Without it a write replaces the stored record.
   */
  readonly mergeRecords?: (stored: NoteRecord, mine: NoteRecord) => NoteRecord;
  readonly persistDelayMs?: number;
  /**
   * The stored plain text, tags and links are refreshed at most this often while typing (they
   * cost a document walk); the title is read on every write, and the final write is always fresh.
   */
  readonly textIntervalMs?: number;
  /**
   * While typing, a write follows the last one at most this often (default 600 ms): the first
   * change is stored after `persistDelayMs`, and other windows read each write (T45).
   */
  readonly writeIntervalMs?: number;
}

const PERSIST_RETRY_MAX_MS = 30_000;
const WRITE_INTERVAL_MS = 600;

/** Origin of the stored state applied by `load` / `restore` (already persisted). */
const LOAD_ORIGIN = Symbol('penmoss-idb-load');
/** Origin of another writer's stored changes merged into the replica (treated as local). */
const MERGE_ORIGIN = Symbol('penmoss-idb-merge');
/** Origin of another window's stored record read by `pullStored`: already stored (T45). */
const PULL_ORIGIN = Symbol('penmoss-idb-pull');

export class ReplicaKeeper {
  /**
   * True once the replica holds local edits (the record's `unsynced` flag). Nothing clears it
   * here: a git notebook's engine says what is not pushed yet (A860).
   */
  unsynced = false;
  /** The last local (IndexedDB) write failure; null once a write succeeds. Retried with backoff. */
  persistError: unknown = null;

  private destroyed = false;
  /** The final write after `destroy` landed; nothing more is written. */
  private finished = false;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  /** When the scheduled write runs (`Date.now()` time). */
  private persistDue = 0;
  /** The scheduled write is a retry after a failure: an edit never brings it forward. */
  private persistRetry = false;
  /** When the last write was handed to the store (`Date.now()` time). */
  private lastFlushAt: number | null = null;
  /** Serialises store writes; never rejects, so one failure cannot stall later writes. */
  private persistChain: Promise<void> = Promise.resolve();
  /** The newest write, which rejects if that write failed (returned by `flush`). */
  private lastWrite: Promise<void> = Promise.resolve();
  /** Counts changes worth persisting; a change is saved once `savedSeq` reaches it. */
  private changeSeq = 0;
  /** Newest change handed to the store (reset to `savedSeq` when a write fails). */
  private queuedSeq = 0;
  /** Newest change the store confirmed. */
  private savedSeq = 0;
  /** Newest change a write of this keeper put in the store (older writes then skip). */
  private storedSeq = 0;
  /** The change `saveOnUnload` last kept (A626); -1 when a later write stored it. */
  private unloadSeq = -1;
  /** The state vector of what the store holds of this replica: null when unknown. */
  private storedVector: Uint8Array | null = null;
  /** The latest `saveNow` write and the change it holds. */
  private savingNow: { readonly seq: number; readonly write: Promise<void> } | null = null;
  /** Newest change to the document itself (not a text or title refresh). */
  private contentSeq = 0;
  private savedWaiters: Array<() => void> = [];
  private persistFailures = 0;
  /**
   * When the document's content last changed here (a local edit, a stored change merged in), or
   * as stored: the record's `updatedAt`.
   */
  private contentAt: number | null = null;
  private localSeq = 0;
  /** localSeq covered by the newest stored write. */
  private savedLocalSeq = 0;
  /** The epoch of the record read (a git notebook's are null); written back as it was. */
  private epoch: string | null = null;
  /** Kept from a record the server once seeded, written back as it was. */
  private seeded = false;
  /** The `rev` of the record this keeper last loaded or wrote. */
  private lastRev: string | undefined;
  private described: {
    text: string;
    tags?: string[];
    deleted: boolean;
    deletedAt?: number;
    deletedFrom?: string | null;
    links?: readonly NoteLink[] | undefined;
    at: number;
  } | null = null;
  /** The last write reused an old text, so a refresh write is due. */
  private describeStale = false;
  private closing: Promise<void> | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly offUpdate: () => void;

  constructor(private readonly options: ReplicaKeeperOptions) {
    this.offUpdate = options.replica.onUpdate((update, origin, info) =>
      this.handleReplicaUpdate(update, origin, info),
    );
  }

  /** Restores the replica from IndexedDB, so the note opens at once. */
  async load(): Promise<void> {
    const record = await this.options.store?.get(this.options.noteId);
    if (!record) return;
    // Read as a string: a record written by another client version may name another engine.
    const stored: string = record.engine;
    if (stored !== this.options.replica.engine) {
      throw new Error(
        `Note ${record.noteId} is stored for ${stored}, not ${this.options.replica.engine}`,
      );
    }
    this.restore(record);
    this.storedVector = record.stateVector;
  }

  /**
   * Brings in what another writer stored for this document since this keeper's last read or
   * write (the Mac app's capture window, T30; another window, T45; the engine, A860), without
   * waiting for this keeper's next write to merge it. What it reads is stored already, so it
   * writes nothing. Resolves whether anything was read.
   */
  async pullStored(): Promise<boolean> {
    const record = await this.options.store?.get(this.options.noteId);
    if (!record || record.rev === this.lastRev || this.finished) return false;
    if ((record.engine as string) !== this.options.replica.engine) return false;
    this.options.replica.applyUpdate(record.update, PULL_ORIGIN);
    // A write of this keeper still waiting for the store was encoded without this record: it
    // compares the stored rev with the one it was encoded against, not with this, so it still
    // finds the record foreign and merges it as it lands.
    this.lastRev = record.rev;
    this.storedVector = record.stateVector;
    if (this.epoch === null && record.epoch !== null) this.epoch = record.epoch;
    if (record.seeded) this.seeded = true;
    if (record.unsynced) this.unsynced = true;
    return true;
  }

  /** Restores the replica from a snapshot (a record, or state whose write is still in flight). */
  restore(snapshot: ReplicaSnapshot): void {
    this.options.replica.applyUpdate(snapshot.update, LOAD_ORIGIN);
    this.epoch = snapshot.epoch;
    this.seeded = snapshot.seeded === true;
    this.lastRev = snapshot.rev;
    if (snapshot.updatedAt !== undefined) this.contentAt = snapshot.updatedAt;
    this.unsynced = snapshot.unsynced;
  }

  /** Local edits not yet in the store. */
  get unsavedLocalEdits(): boolean {
    return this.localSeq > this.savedLocalSeq;
  }

  /** The epoch of the record read (null in a git notebook). */
  get currentEpoch(): string | null {
    return this.epoch;
  }

  /** Whether the record read was once seeded by the Penmoss server (kept as it was). */
  get isSeeded(): boolean {
    return this.seeded;
  }

  /** Called whenever `persistError` or `savedLocally` changes. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Writes the replica to IndexedDB now. Rejects if that write fails (it is retried with backoff). */
  flush(): Promise<void> {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = null;
    this.persistRetry = false;
    const { store } = this.options;
    if (!store || this.finished || this.changeSeq === this.queuedSeq) return this.lastWrite;
    const seq = (this.queuedSeq = this.changeSeq);
    const localAt = this.localSeq;
    this.lastFlushAt = Date.now();
    // Encoded now, so later edits wait for the next write; against the record last written or
    // read, which `write` compares the stored one with when it lands.
    const base = this.lastRev;
    const record = this.encodeRecord();
    const write = this.persistChain
      .then(() => this.write(record, seq, base))
      .then(
        (stored) => {
          if (stored) this.savedLocalSeq = Math.max(this.savedLocalSeq, localAt);
          this.persistSucceeded(seq);
        },
        (error: unknown) => {
          this.persistFailed(error);
          throw error;
        },
      );
    this.persistChain = write.catch(() => undefined);
    this.lastWrite = write;
    return write;
  }

  /**
   * Writes the latest state now, with fresh text and title, beside any write still in flight
   * rather than after it: on page hide the page may unload before a queued write's IndexedDB
   * transaction opens. Every write holds the whole replica, and an older one that lands later is
   * skipped, so nothing is lost either way.
   */
  saveNow(): Promise<void> {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = null;
    this.persistRetry = false;
    const { store } = this.options;
    if (!store || this.finished || this.savedSeq >= this.changeSeq) return this.lastWrite;
    // Asked twice for the same state (the notes and the workspace both listen): one write.
    if (this.savingNow?.seq === this.changeSeq) return this.savingNow.write;
    // The last write before a reload: the text as it is now, not as of the last refresh.
    this.described = null;
    this.describeStale = false;
    const seq = (this.queuedSeq = this.changeSeq);
    const localAt = this.localSeq;
    const base = this.lastRev;
    const write = this.write(this.encodeRecord(), seq, base).then(
      (stored) => {
        if (stored) this.savedLocalSeq = Math.max(this.savedLocalSeq, localAt);
        this.persistSucceeded(seq);
      },
      (error: unknown) => {
        this.persistFailed(error);
        throw error;
      },
    );
    const before = this.persistChain;
    this.persistChain = Promise.all([before, write.catch(() => undefined)]).then(() => undefined);
    this.lastWrite = write;
    this.savingNow = { seq, write };
    return write;
  }

  /**
   * The last write as the page goes (`pagehide`, A626): what the store lacks is kept by its
   * `putOnUnload` at once, in this event, since nothing that waits for a callback lands then.
   * Only the changes since the stored record when that is known, else the whole document. Stores
   * without it, or that cannot, fall back to `saveNow`. Asked twice for the same state, it keeps
   * it once.
   */
  saveOnUnload(): void {
    // The debounced write stays scheduled: if the page comes back (back-forward cache), it still
    // updates the record itself.
    const { store, noteId, replica } = this.options;
    if (!store || this.finished || this.savedSeq >= this.changeSeq) return;
    if (this.unloadSeq === this.changeSeq) return;
    const since = this.storedVector;
    const kept =
      store.putOnUnload?.({
        noteId,
        engine: replica.engine,
        source: this.unloadSource,
        epoch: this.epoch,
        update: since ? replica.encodeStateAsUpdate(since) : replica.encodeStateAsUpdate(),
        whole: since === null,
        unsynced: this.unsynced,
        ...(this.seeded ? { seeded: true } : {}),
        updatedAt: this.contentAt ?? Date.now(),
      }) ?? false;
    if (kept) this.unloadSeq = this.changeSeq;
    else void this.saveNow().catch(() => undefined);
  }

  /**
   * Resolves once every change is stored. Failed writes keep being retried with backoff, so the
   * replica must stay alive until then.
   */
  destroy(): Promise<void> {
    if (this.closing) return this.closing;
    this.destroyed = true;
    this.listeners.clear();
    this.closing = this.saveAll().finally(() => {
      this.finished = true;
      if (this.persistTimer) clearTimeout(this.persistTimer);
      this.offUpdate();
    });
    return this.closing;
  }

  /**
   * True once the local store holds every change to the document, so a reload never opens an
   * older local copy.
   */
  get savedLocally(): boolean {
    return !this.options.store || this.savedSeq >= this.contentSeq;
  }

  private async saveAll(): Promise<void> {
    if (!this.options.store) return;
    this.described = null; // The final write carries fresh text.
    this.describeStale = false;
    while (this.savedSeq < this.changeSeq) {
      const target = this.changeSeq;
      this.flush().catch(() => undefined); // Retried with backoff by persistFailed.
      await new Promise<void>((resolve) => {
        if (this.savedSeq >= target) resolve();
        else this.savedWaiters.push(resolve);
      });
    }
  }

  private encodeRecord(): NoteRecord {
    const {
      noteId,
      replica,
      title,
      tags,
      deleted,
      trashInfo,
      textIntervalMs = 2000,
    } = this.options;
    const now = Date.now();
    let described = this.described;
    // A description that catches up with content changed since the last one (the trailing
    // refresh after typing pauses) is stamped now, so lists and panels keyed on `updatedAt` see
    // its text and links; any other write keeps the content's time.
    let caughtUp = false;
    if (!described || now - described.at >= textIntervalMs) {
      caughtUp = described !== null && this.contentAt !== null && this.contentAt > described.at;
      described = {
        text: replica.plainText(),
        ...(tags ? { tags: tags() } : {}),
        deleted: deleted?.() ?? false,
        links: replica.links?.(),
        at: now,
      };
      const trash = described.deleted ? trashInfo?.() : undefined;
      if (trash?.at !== undefined) described.deletedAt = trash.at;
      if (trash?.folderId !== undefined) described.deletedFrom = trash.folderId;
      this.described = described;
      this.describeStale = false;
    } else {
      this.describeStale = true;
    }
    return {
      noteId,
      engine: replica.engine,
      update: replica.encodeStateAsUpdate(),
      stateVector: replica.encodeStateVector(),
      text: described.text,
      // Always current (one read, no walk): other windows list notes by it, and `[[` completion
      // there matches it, so a half-typed title must not stay.
      ...(title ? { title: title() } : {}),
      ...(described.tags !== undefined ? { tags: described.tags } : {}),
      ...(described.deleted ? { deleted: true } : {}),
      ...linksField(described.links),
      ...(described.deletedAt !== undefined ? { deletedAt: described.deletedAt } : {}),
      ...(described.deletedFrom !== undefined ? { deletedFrom: described.deletedFrom } : {}),
      epoch: this.epoch,
      updatedAt: caughtUp ? now : (this.contentAt ?? now),
      unsynced: this.unsynced,
      ...(this.seeded ? { seeded: true } : {}),
      rev: crypto.randomUUID(),
    };
  }

  /**
   * Stores `record`, merging in whatever another writer stored since this keeper's last write.
   * `base` is the rev of the record `record` was encoded against (written or read by this keeper
   * then): a stored record with any other rev holds changes `record` may lack, so it is merged.
   * The live `lastRev` would not do: a write encoded earlier lands after this keeper read or
   * wrote another record (T45, A711). Resolves false when nothing was stored.
   */
  private async write(record: NoteRecord, seq: number, base: string | undefined): Promise<boolean> {
    const { store, mergeRecords } = this.options;
    if (!store) return false;
    if (seq < this.storedSeq) return false; // A newer write (page hide) holds all of it.
    if (!store.update) {
      await store.put(record);
      this.lastRev = record.rev;
      this.stored(record, seq);
      return true;
    }
    let foreign: NoteRecord | null = null;
    const written = await store.update(record.noteId, (current) => {
      // A newer write of this keeper landed first (page hide): this one adds nothing.
      if (seq < this.storedSeq) return null;
      if (!current) return record;
      if (current.rev === base || !mergeRecords) {
        return record.epoch === null && current.epoch !== null
          ? { ...record, epoch: current.epoch }
          : record;
      }
      foreign = current;
      return mergeRecords(current, record);
    });
    if (!written) return false;
    this.stored(written, seq);
    this.lastRev = written.rev;
    if (this.epoch === null && written.epoch !== null) this.epoch = written.epoch;
    if (written.seeded) this.seeded = true;
    const merged = foreign as NoteRecord | null;
    if (merged && !this.finished) {
      // Bring the other writer's changes into this replica (and so to the editor).
      this.options.replica.applyUpdate(merged.update, MERGE_ORIGIN);
    }
    return true;
  }

  /** This keeper's own entries as the page goes: another keeper of the note has its own. */
  private get unloadSource(): string {
    return `replica-${this.options.replica.clientId}`;
  }

  /** A write of change `seq` landed, as `record`. */
  private stored(record: NoteRecord, seq: number): void {
    if (seq >= this.storedSeq) this.storedVector = record.stateVector;
    this.storedSeq = Math.max(this.storedSeq, seq);
    if (this.unloadSeq !== -1 && seq >= this.unloadSeq) {
      // The record holds what was kept as the page went (it stayed): nothing to merge in.
      this.unloadSeq = -1;
      this.options.store?.forgetUnload?.(this.options.noteId, this.unloadSource);
    }
  }

  private handleReplicaUpdate(_update: Uint8Array, origin: unknown, info?: UpdateInfo): void {
    if (origin === LOAD_ORIGIN) return;
    // A change to the comments alone is not an edit (T48, A770): the note keeps its time.
    if (!info?.commentsOnly) this.contentAt = Date.now();
    // Another window's stored record: nothing to write.
    if (origin === PULL_ORIGIN) return;
    this.schedulePersist();
    this.localSeq++;
    this.unsynced = true;
  }

  private schedulePersist(): void {
    this.changeSeq++;
    this.contentSeq = this.changeSeq;
    // The first change is stored soon; while typing, a write follows the last one at most once
    // an interval (each encodes the whole document).
    const soon = this.options.persistDelayMs ?? 200;
    const interval = this.options.writeIntervalMs ?? WRITE_INTERVAL_MS;
    const next = this.lastFlushAt === null ? 0 : this.lastFlushAt + interval - Date.now();
    this.queuePersist(Math.max(soon, next));
  }

  private queuePersist(delay: number, retry = false): void {
    if (!this.options.store || this.finished) return;
    const due = Date.now() + delay;
    if (this.persistTimer) {
      // A write is already due: an edit never waits for a later one (the trailing text
      // refresh's 2 s), so other windows read it soon (T45, A711); a retry keeps its backoff.
      if (this.persistRetry || due >= this.persistDue) return;
      clearTimeout(this.persistTimer);
    }
    this.persistDue = due;
    this.persistRetry = retry;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persistRetry = false;
      this.flush().catch(() => undefined); // Reported through persistError.
    }, delay);
  }

  private persistSucceeded(seq: number): void {
    const wasSaved = this.savedLocally;
    this.savedSeq = Math.max(this.savedSeq, seq);
    this.queuedSeq = Math.max(this.queuedSeq, seq);
    this.persistFailures = 0;
    this.setPersistError(null);
    const waiters = this.savedWaiters;
    this.savedWaiters = [];
    for (const resolve of waiters) resolve();
    if (!wasSaved && this.savedLocally && !this.destroyed) this.notify();
    if (this.describeStale && !this.destroyed) {
      // The text was reused from an earlier write; refresh it once typing pauses.
      this.changeSeq++;
      this.queuePersist(this.options.textIntervalMs ?? 2000);
    }
  }

  /** Marks the unsaved changes dirty again and retries with exponential backoff. */
  private persistFailed(error: unknown): void {
    this.queuedSeq = this.savedSeq;
    console.error('[keeper] could not save the note locally; retrying', error);
    this.setPersistError(error);
    const base = this.options.persistDelayMs ?? 200;
    this.queuePersist(Math.min(PERSIST_RETRY_MAX_MS, base * 2 ** ++this.persistFailures), true);
  }

  private setPersistError(error: unknown): void {
    if (this.persistError === error) return;
    this.persistError = error;
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
