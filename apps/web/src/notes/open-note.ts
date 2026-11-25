/** One note open in this window (service.ts opens it): its replica, its keeper and its live list updates. */
import { type ReplicaStore } from '@penmoss/model/record';
import { ReplicaKeeper, type ReplicaSnapshot } from '../store/keeper';
import { isDeleted, readTrashInfo, readTitle } from '@penmoss/model/note';
import { mergeRecords } from '@penmoss/model/records';
import { noteTags } from '@penmoss/model/tags';
import { createYjs14Replica, type Yjs14Replica } from '@penmoss/model/yjs14';
import type { Notes } from './service';
import { type LocalNotes } from './service-types';

/** How long after a change an open note's tags are read again (T18). */
const TAGS_DELAY_MS = 400;

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
          unsynced: this.keeper.unsynced,
        }
      : null;
    // The keeper keeps retrying its final write; the replica stays until it lands.
    const written = this.keeper.destroy().finally(() => this.replica.destroy());
    this.notes.noteClosed(this, written, snapshot);
  }
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
