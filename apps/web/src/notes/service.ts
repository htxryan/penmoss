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
import { type NoteText } from '../store/idb';
import { type NoteMeta, type NoteRecord } from '@penmoss/model/record';
import { toMeta } from '@penmoss/model/records';
import { Attachments } from '../store/attachments';
import { ReplicaKeeper, type ReplicaSnapshot } from '../store/keeper';
import { initNote, isoWithOffset } from '@penmoss/model/note';
import { periodicNoteId, periodicSalt, type PeriodKind } from '@penmoss/core/periodic';
import {
  linksField,
  needsLinks,
  newRev,
  recordFromUpdates,
  withLinks,
} from '@penmoss/model/records';
import { type TagChange } from '@penmoss/model/tags';
import { bodyJson, createYjs14Replica } from '@penmoss/model/yjs14';
import { applyLive, mergeNotes, sameListing, type LiveNote, type NoteListEntry } from './list';
import { TagChanges } from './tag-changes';
import {
  type AppSyncState,
  type LocalLinks,
  type LocalNotes,
  type LocalSyncBackend,
  type LocalSyncState,
  type NoteRegistry,
  type NotesOptions,
  type StoreHooks,
  type TagChangeResult,
  isReserved,
} from './service-types';
import { OpenNote } from './open-note';
import { EmbedWatcher, type EmbeddedNote } from './embed-watcher';
import { untilStored } from './until-stored';
import { Trash, type TrashEntry } from './trash';
import { browserOnline, browserPersist, followPage } from './page-follow';

const INITIAL_SYNC: AppSyncState = { phase: 'syncing', pending: 0, detail: null };

/** The source of a closed note's in-flight snapshot kept as the page goes (A626, A640). */
const SNAPSHOT_SOURCE = 'snapshot';

/** How often another window's edits (text and time only) re-sort this window's list (T45). */
const LIST_REFRESH_MS = 1000;

export class Notes {
  /** Images in notes (T10): stored here, shown from local bytes. */
  readonly attachments: Attachments;
  /** Whether the browser agreed not to evict local storage (null until asked). */
  persisted: boolean | null = null;
  private readonly openStore: (hooks: StoreHooks) => Promise<LocalNotes>;
  private readonly registry: NoteRegistry | undefined;
  private readonly online: () => boolean;
  private readonly persistStorage: () => Promise<boolean>;
  /** Tag renames, merges and deletes, one batch at a time (T18). */
  private readonly tags = new TagChanges({
    localStore: () => this.localStore(),
    refreshLocal: () => this.refreshLocal(),
    listed: () => this.entries,
    openDoc: (id) =>
      [...this.open].find((note) => note.id === id && note.isLoaded)?.replica.doc ?? null,
    isReserved: (id) => isReserved(id),
  });
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
  private readonly pulledListeners = new Set<(ids: readonly string[]) => void>();
  /** Notes shown in embeds (T13), opened live while any embed shows them. */
  private readonly embedded = new Map<string, EmbeddedNote>();
  /** Follows notes for embeds (embed-watcher.ts). */
  private readonly embeds = new EmbedWatcher((id) => this.openNote(id), this.embedded);
  /** Deleting to Trash, restoring and deleting for good (T21, trash.ts). */
  private readonly bin = new Trash({
    localStore: () => this.localStore(),
    refreshLocal: () => this.refreshLocal(),
    listed: () => this.local.values(),
    registry: () => this.registry,
    backend: () => this.backend,
    deleted: () => this.deleted,
    openLoaded: (id) => [...this.open].find((note) => note.id === id && note.isLoaded),
    settled: (id) => this.settled(id),
    changed: () => this.changed(),
  });
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
    this.openStore = options.openStore;
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
    return periodicNoteId(kind, period, this.saltOf(kind, period));
  }

  /** The salt of a period's note in this source (what makes the note's document match its id). */
  private saltOf(kind: PeriodKind, period: string): string {
    return periodicSalt(kind, period, this.periodicSalt, this.isPurged);
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
      this.stopped = followPage({
        saveAllOnUnload: () => this.saveAllOnUnload(),
        saveAll: () => this.saveAll(),
        syncChanged: () => this.syncChanged(),
        backend: this.backend,
        localStore: () => this.localStore(),
        pullStored: (ids) => this.pullStored(ids),
      });
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
      void this.tags.resume();
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
        update: snapshot.update,
        whole: true,
        unsynced: snapshot.unsynced,
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
    if (ids) for (const listener of this.pulledListeners) listener(ids);
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

  /**
   * Tells `listener` which records another writer stored (another window, or this notebook's
   * engine after a pull), as they are read in. AI Descriptions (PEN-161) describes them too.
   */
  onPulled(listener: (ids: readonly string[]) => void): () => void {
    this.pulledListeners.add(listener);
    return () => this.pulledListeners.delete(listener);
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
    } = {},
  ): string {
    const id = ulid(now.getTime());
    const title = options.title?.replace(/[\r\n]+/g, ' ').trim() ?? '';
    const replica = createYjs14Replica();
    initNote(replica.doc, { id, created: isoWithOffset(now), kind: 'note' }, title);
    const record: NoteRecord = {
      noteId: id,
      engine: replica.engine,
      update: replica.encodeStateAsUpdate(),
      stateVector: replica.encodeStateVector(),
      text: '',
      title,
      ...linksField([]),
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
  deleteNote(id: string, options: { readonly folderId?: string | null } = {}): Promise<void> {
    return this.bin.deleteNote(id, options);
  }

  /** Notes in Trash on this device, newest deletion first (T21), from the last list read. */
  localTrash(metas?: Iterable<NoteMeta>): TrashEntry[] {
    return this.bin.localTrash(metas);
  }

  /** Trash (T21): this source's deleted notes, read from storage. */
  trash(): Promise<TrashEntry[]> {
    return this.bin.trash();
  }

  /**
   * Takes a note out of Trash and files it back in the folder it was deleted from (T21), or where
   * the person chose (`folderId`: a folder, or null for the top level).
   */
  restoreFromTrash(id: string, options: { readonly folderId?: string | null } = {}): Promise<void> {
    return this.bin.restoreFromTrash(id, options);
  }

  /** Deletes a note in Trash for good (T21, A828). */
  purgeFromTrash(id: string): Promise<void> {
    return this.bin.purgeFromTrash(id);
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
   * Follows a note's changes for embeds (T13; embed-watcher.ts): `listener` runs on every change
   * and once the note is loaded. Nothing here writes to the note.
   */
  watchNote(id: string, listener: () => void): () => void {
    return this.embeds.watchNote(id, listener);
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
    const salt = this.saltOf(kind, period);
    const id = periodicNoteId(kind, period, salt);
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
      import('@penmoss/model/periodic'),
      import('@penmoss/core'),
    ]);
    const note = periodicNote(codec, kind, period, template, salt);
    await store.update(id, (current) =>
      current ? null : recordFromUpdates(id, [note.update], { unsynced: true }),
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

  /** Tag renames, merges and deletes in this notebook's notes, with Undo (`TagChanges`). */
  changeTags(changes: readonly TagChange[]): Promise<TagChangeResult> {
    return this.tags.change(changes);
  }

  /** Resolves once no tag rename is running (tests). */
  async whenRenamed(): Promise<void> {
    await this.tags.idle();
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
