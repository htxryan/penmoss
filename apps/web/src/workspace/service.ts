/**
 * A git notebook's workspace document in the app (T7, A860; T59): the folder tree, note
 * registry, sort modes and settings. It is kept in the notebook's NoteStore under a reserved key,
 * so the tree shows at once on reload, and a `ReplicaKeeper` writes its changes back (A1031); the
 * notebook's engine commits and pushes what is stored and writes what it pulls into the store,
 * which `pullStored` reads in.
 */
import { ulid } from '@penmoss/core/ids';
import { journalFolderId, type PeriodKind } from '@penmoss/core/periodic';
import { type SortMode } from '@penmoss/core/workspace';
import { NoteStore, type ReplicaStore } from '@penmoss/sync-client';
import { ReplicaKeeper } from '@penmoss/sync-client/keeper';
import { mergeRecords } from '@penmoss/sync-client/records';
import {
  createFolder,
  deleteFolder,
  endPosition,
  fallbackFolder,
  notebookOfFolder,
  notebookPlaces,
  notebookTrashNotes,
  setDefaultNotebookName,
  setNotebook,
  moveFolder,
  moveNote,
  readFolderTrash,
  readSettings,
  readWorkspace,
  registerNote,
  renameFolder,
  restoreFolder,
  setSetting,
  setSortMode,
  setTogether,
  unregisterNote,
  WORKSPACE_RECORD_KEY,
  type DeletedFolder,
  type FolderRestore,
  type TrashedFolder,
  type WorkspaceSnapshot,
} from '@penmoss/sync-client/workspace';
import { isPurged, markPurged, unmarkPurged } from '@penmoss/git-notebook';
import { createYjs14Replica, type Yjs14Replica } from '@penmoss/sync-client/yjs14';
import type { MovePlan } from './model';

/** Where captures filed as new notes go (T30). */
export const INBOX = 'Inbox';

/** Where a note out of Trash goes (`restorePlace`), or that there is no safe place (T43). */
export type RestorePlace =
  | { readonly folderId: string | null }
  | {
      readonly refused: true;
      /** Its deleted notebook, while it is in Trash: restoring it brings the note's place back. */
      readonly notebook: { readonly id: string; readonly name: string } | null;
    };

export interface WorkspaceOptions {
  /**
   * The git notebook (T50, A860): its settings are its own (A827: the notebook's under
   * `notebook`, the device's under `device`), and its derived folder ids are salted with the
   * notebook's id (A820), or with its own `salt` (`''`: none, the notebook imported from the
   * personal workspace, A1021).
   */
  readonly gitNotebook: { readonly id: string; readonly salt?: string };
  readonly openStore?: () => Promise<ReplicaStore>;
  /**
   * Whether this window shows the folder notice (default true). One that does not (the Mac's
   * capture window) leaves the count of folder changes a closed window could not keep to the
   * next one that does (#116, A676).
   */
  readonly notices?: boolean;
}

/** A git notebook's own settings (A827): the same in every client of the notebook. */
export function isNotebookSetting(key: string): boolean {
  return key === 'timeZone' || key.startsWith('template.');
}

/** Where a git notebook keeps the notebook's settings and the device's (A827). */
export const GIT_NOTEBOOK_SETTINGS = 'notebook';
export const GIT_DEVICE_SETTINGS = 'device';

export interface WorkspaceState {
  readonly snapshot: WorkspaceSnapshot;
  /** The local copy has been read (or there was none). */
  readonly loaded: boolean;
  /**
   * Folder changes a window kept as it closed that could not be merged when the store next
   * opened (#127, A626, A676), for the notice. Absent when none.
   */
  readonly recovered?: { readonly closed: number; readonly at: number } | undefined;
}

export class Workspace {
  readonly replica: Yjs14Replica;
  /** Writes the replica back to the store (A1031). */
  readonly keeper: ReplicaKeeper;
  private readonly listeners = new Set<() => void>();
  private state: WorkspaceState;
  /** Told of each note this device moves to another notebook (A766), to record it in the note. */
  private readonly notebookListeners = new Set<(noteId: string, notebook: string) => void>();
  private loading: Promise<void> | null = null;
  private stopped: (() => void) | null = null;
  private readonly store: ReplicaStore & Required<Pick<ReplicaStore, 'update'>>;
  private readonly notices: boolean;
  /** The git notebook's id (A860). */
  readonly gitNotebookId: string;
  /** The salt of the notebook's derived folder ids (A820, A1021). */
  private readonly gitSalt: string;

  constructor(options: WorkspaceOptions) {
    this.gitNotebookId = options.gitNotebook.id;
    this.gitSalt = options.gitNotebook.salt ?? options.gitNotebook.id;
    this.notices = options.notices ?? true;
    const openStore = options.openStore ?? (() => NoteStore.open());
    let store: Promise<ReplicaStore> | null = null;
    // The store once open, for the page-hide write, which cannot wait for a promise (A626).
    let opened: ReplicaStore | null = null;
    const lazy = () =>
      (store ??= openStore().then((ready) => {
        opened = ready;
        return ready;
      }));
    this.store = {
      get: async (key) => (await lazy()).get(key),
      put: async (record) => (await lazy()).put(record),
      putOnUnload: (write) => opened?.putOnUnload?.(write) ?? false,
      forgetUnload: (key, source) => opened?.forgetUnload?.(key, source),
      takeUnloadDrops: async (key) => (await lazy()).takeUnloadDrops?.(key) ?? 0,
      // Merge-in-transaction when the store supports it, so two windows never overwrite each other.
      update: async (key, fn) => {
        const opened = await lazy();
        if (opened.update) return opened.update(key, fn);
        const next = fn(await opened.get(key));
        if (next) await opened.put(next);
        return next;
      },
    };
    this.replica = createYjs14Replica();
    this.keeper = new ReplicaKeeper({
      noteId: WORKSPACE_RECORD_KEY,
      replica: this.replica,
      store: this.store,
      mergeRecords,
    });
    this.replica.onUpdate(() => this.update({ snapshot: readWorkspace(this.replica.doc) }));
    this.watchNotebookMoves(this.replica.doc);
    this.state = { snapshot: readWorkspace(this.replica.doc), loaded: false };
  }

  /** Restores the local copy and keeps it stored. Idempotent. */
  start(): Promise<void> {
    this.loading ??= this.keeper.load().finally(() => {
      this.update({ loaded: true });
      if (this.notices) void this.noticeClosedDrops();
    });
    if (!this.stopped) {
      const flush = () => void this.keeper.flush().catch(() => undefined);
      // On page hide the change is kept in that event, synchronously (A626): a reload must keep
      // a setting just changed, and a write that waits for a callback is lost with the page.
      const saveOnUnload = () => this.keeper.saveOnUnload();
      // Hidden (the app in the background, maybe ended there): stored as on page hide, in case
      // this is the last event, and written to the record too, which other windows read.
      const onHidden = () => {
        if (document.visibilityState !== 'hidden') return;
        this.keeper.saveOnUnload();
        void this.keeper.saveNow().catch(() => undefined);
      };
      const browser = typeof window === 'undefined' ? null : window;
      browser?.addEventListener('pagehide', saveOnUnload);
      if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onHidden);
      this.stopped = () => {
        browser?.removeEventListener('pagehide', saveOnUnload);
        if (typeof document !== 'undefined') {
          document.removeEventListener('visibilitychange', onHidden);
        }
        flush();
      };
    }
    return this.loading;
  }

  /**
   * Shows the folder changes a closed window kept as it went that the store dropped when it
   * opened (#116, A676): they could not be read or merged, so they are lost, and the person
   * should know, not only the log. The store adopts them as it opens, which the load just did;
   * the count is taken once, so one window tells.
   */
  private async noticeClosedDrops(): Promise<void> {
    const closed = await this.store
      .takeUnloadDrops?.(WORKSPACE_RECORD_KEY)
      .catch((error: unknown) => {
        console.warn(
          '[workspace] could not read the folder changes a closed window dropped',
          error,
        );
        return 0;
      });
    if (closed === undefined || closed <= 0) return;
    console.warn(
      `[workspace] ${closed} folder change(s) kept as a window closed could not be merged and were dropped`,
    );
    this.update({ recovered: { closed, at: Date.now() } });
  }

  /** Resolves once the workspace's changes so far are stored locally. */
  flush(): Promise<void> {
    return this.keeper.flush();
  }

  /** Picks up what another window or the engine stored (an Inbox folder a capture made, T30). */
  pullStored(): Promise<boolean> {
    return this.keeper.pullStored().catch(() => false);
  }

  stop(): void {
    this.stopped?.();
    this.stopped = null;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** A stable reference between changes (for useSyncExternalStore). */
  getState = (): WorkspaceState => this.state;

  get doc() {
    return this.replica.doc;
  }

  /** Creates a folder at the end of `parentId` (null: top level) and returns its id. */
  createFolder(name: string, parentId: string | null): string {
    const id = ulid();
    createFolder(this.doc, { id, name, parentId });
    return id;
  }

  /** Makes a notebook at the end of the top level (T43, A750) and returns its id. */
  createNotebook(name: string): string {
    const id = ulid();
    createFolder(this.doc, { id, name, parentId: null, notebook: true });
    return id;
  }

  /**
   * Turns a top-level folder into a notebook or back (T43, A756). Throws WorkspaceError when
   * it cannot be one (not at the top level, or the Journal or Inbox).
   */
  setNotebook(id: string, on: boolean): void {
    setNotebook(this.doc, id, on);
  }

  /** Names the default notebook ('' gives back "Personal"; T43, A751). */
  setDefaultNotebookName(name: string): void {
    setDefaultNotebookName(this.doc, name);
  }

  renameFolder(id: string, name: string): void {
    renameFolder(this.doc, id, name);
  }

  /**
   * Deletes a folder and its subfolders to Trash; their notes move up (A17, T42 A560). A
   * notebook goes to Trash with its notes (T43, A755): the caller moves each of `trashed` to
   * Trash too.
   */
  deleteFolder(id: string): DeletedFolder {
    return deleteFolder(this.doc, id);
  }

  /** Notes in Trash with a deleted notebook (T43): they come back with it, never on their own. */
  notebookTrashNotes(): ReadonlyMap<string, string> {
    return notebookTrashNotes(this.doc);
  }

  /** Folders in Trash, newest first (T42, A560). Read from the document: it works offline. */
  folderTrash(): TrashedFolder[] {
    return readFolderTrash(this.doc);
  }

  /** Brings a folder back from Trash with its subfolders and the notes still where it left them. */
  restoreFolder(id: string): FolderRestore {
    return restoreFolder(this.doc, id);
  }

  setSortMode(folderId: string | null, mode: SortMode): void {
    setSortMode(this.doc, folderId, mode);
  }

  /**
   * Files a new note at the end of `folderId` (null: the top level). A folder that is gone gives
   * way to the nearest folder above it within its notebook (T43 review B2, A757: never the
   * default notebook's top level for a notebook's note); with no safe place the note is filed
   * where it was meant to go.
   */
  registerNote(id: string, folderId: string | null): void {
    const place = fallbackFolder(this.doc, folderId);
    registerNote(this.doc, { id, folderId: 'folderId' in place ? place.folderId : folderId });
  }

  /** Files a conflict copy (A5) beside its original: the same folder, so the same notebook. */
  registerCopy(id: string, originalId: string | undefined): void {
    const original = originalId
      ? this.state.snapshot.notes.find((note) => note.id === originalId)
      : undefined;
    // An original the registry does not file (in Trash with its notebook, say): its copy is
    // filed nowhere yet, so no mirror publishes it; the device files it once it knows where.
    if (originalId && !original) {
      if (notebookTrashNotes(this.doc).has(originalId)) return;
    }
    this.registerNote(id, original?.folderId ?? null);
  }

  /**
   * Where a note coming out of Trash goes (T43 review B2, A757): the folder it was deleted from,
   * or the nearest one above it within its notebook; refused when there is no safe place (its
   * notebook was deleted, or Trash forgets the folder): the person is asked.
   */
  restorePlace(noteId: string, folderId: string | null): RestorePlace {
    // Still filed (deleted on a device that had not synced the tree, A197): it stays.
    const entry = this.state.snapshot.notes.find((note) => note.id === noteId);
    if (entry) return { folderId: entry.folderId };
    const place = fallbackFolder(this.doc, folderId);
    if ('folderId' in place) return { folderId: place.folderId };
    const notebook = place.notebook
      ? (readFolderTrash(this.doc).find((folder) => folder.id === place.notebook) ?? null)
      : null;
    return {
      refused: true,
      notebook: notebook ? { id: notebook.id, name: notebook.name } : null,
    };
  }

  /**
   * Files a daily or weekly note under `Journal/<year>/<month>` or
   * `Journal/<year>/Weekly` (T19), creating the folders it needs with ids
   * derived from their paths, so two devices doing this offline make the same
   * folders. A note already filed (by any device) stays where it is.
   */
  fileJournalNote(id: string, kind: PeriodKind, period: string): void {
    if (this.state.snapshot.notes.some((entry) => entry.id === id)) return;
    const year = period.slice(0, 4);
    const levels = ['Journal', year, kind === 'daily' ? period.slice(5, 7) : 'Weekly'];
    this.doc.transact(() => {
      let parentId: string | null = null;
      for (let depth = 1; depth <= levels.length; depth++) {
        const folderId = journalFolderId(levels.slice(0, depth).join('/'), this.salt);
        if (!readWorkspace(this.doc).folders.some((folder) => folder.id === folderId)) {
          createFolder(this.doc, { id: folderId, name: levels[depth - 1]!, parentId });
        }
        parentId = folderId;
      }
      registerNote(this.doc, { id, folderId: parentId });
    });
  }

  /**
   * Files a captured note (T30) in the top-level Inbox folder: the user's own
   * "Inbox" if there is one, else one created with an id derived from its
   * name, so two devices capturing offline make one Inbox.
   */
  fileInInbox(id: string): string {
    const folders = readWorkspace(this.doc).folders;
    // Never a notebook's (T43): captures stay in the default notebook.
    const own = folders.find(
      (folder) =>
        folder.parentId === null &&
        folder.notebook !== true &&
        folder.name.trim().toLowerCase() === INBOX.toLowerCase(),
    );
    const folderId = own?.id ?? journalFolderId(INBOX, this.salt);
    this.doc.transact(() => {
      if (!own && !folders.some((folder) => folder.id === folderId)) {
        createFolder(this.doc, { id: folderId, name: INBOX, parentId: null });
      }
      registerNote(this.doc, { id, folderId });
    });
    return folderId;
  }

  /** The folder a note is filed in (null: top level or not registered). */
  folderOfNote(id: string): string | null {
    return this.state.snapshot.notes.find((note) => note.id === id)?.folderId ?? null;
  }

  /**
   * Files a note restored from Trash (T21) back in `folderId`, or the nearest folder above it
   * within its notebook when that folder is gone (`restorePlace`; the caller asked first when
   * there was none). A note the registry still has stays put.
   */
  restoreNote(id: string, folderId: string | null): void {
    const entry = this.state.snapshot.notes.find((note) => note.id === id);
    if (!entry) {
      this.registerNote(id, folderId);
      return;
    }
    // Filed at the top level while it was in Trash (a device filing notes it did not
    // know, before the deletion reached it): back where it was deleted from (B10).
    const exists = folderId !== null && this.state.snapshot.folders.some((f) => f.id === folderId);
    if (entry.folderId === null && exists) {
      moveNote(this.doc, id, folderId, endPosition(this.doc, folderId, 'notes'));
    }
  }

  /** Removes a deleted note from the registry. */
  unregisterNote(id: string): void {
    unregisterNote(this.doc, id);
  }

  /** Applies a planned move in one transaction. Throws WorkspaceError when it is refused. */
  apply(plan: MovePlan): void {
    if (plan.type !== 'move') return;
    const { item, parentId, position, respace } = plan;
    const known = new Set(this.state.snapshot.notes.map((note) => note.id));
    const placeNote = (id: string, at: string) => {
      if (known.has(id)) moveNote(this.doc, id, parentId, at);
      else registerNote(this.doc, { id, folderId: parentId, position: at });
    };
    this.doc.transact(() => {
      // One Manual order for the parent's subfolders and notes from now on (T62 item 6).
      if (plan.together) setTogether(this.doc, parentId);
      for (const sibling of respace) {
        if (sibling.kind === 'folder') moveFolder(this.doc, sibling.id, parentId, sibling.position);
        else placeNote(sibling.id, sibling.position);
      }
      if (item.kind === 'folder') moveFolder(this.doc, item.id, parentId, position);
      else placeNote(item.id, position);
    });
  }

  /** The settings: the device's, with the notebook's own over them (A827). */
  settings(): Record<string, unknown> {
    const device = readSettings(this.doc, GIT_DEVICE_SETTINGS);
    const notebook = readSettings(this.doc, GIT_NOTEBOOK_SETTINGS);
    for (const key of Object.keys(device)) if (isNotebookSetting(key)) delete device[key];
    for (const key of Object.keys(notebook)) if (!isNotebookSetting(key)) delete notebook[key];
    return { ...device, ...notebook };
  }

  /** Sets one setting (undefined removes it), straight in: the engine commits it (A827). */
  setSetting(key: string, value: unknown): void {
    setSetting(
      this.doc,
      isNotebookSetting(key) ? GIT_NOTEBOOK_SETTINGS : GIT_DEVICE_SETTINGS,
      key,
      value,
    );
  }

  /**
   * Each note this device's own change moves to another notebook (T43 review, A766): a move, a
   * folder moved, a notebook turned on or off. Changes from elsewhere are theirs to record; a
   * note filed for the first time is its maker's (or recorded by the caller that chose).
   */
  private watchNotebookMoves(doc: Yjs14Replica['doc']): () => void {
    // Read only around this device's own changes: before and after, never for remote updates.
    let before: Map<string, string> | null = null;
    const start = (transaction: { readonly local: boolean }) => {
      before = transaction.local ? notebookPlaces(doc) : null;
    };
    const end = (transaction: { readonly local: boolean }) => {
      const was = before;
      before = null;
      if (!transaction.local || !was) return;
      for (const [id, notebook] of notebookPlaces(doc)) {
        const old = was.get(id);
        if (old !== undefined && old !== notebook) {
          for (const listener of this.notebookListeners) listener(id, notebook);
        }
      }
    };
    doc.on('beforeTransaction', start);
    doc.on('afterTransaction', end);
    return () => {
      doc.off('beforeTransaction', start);
      doc.off('afterTransaction', end);
    };
  }

  /** Listens for notes this device moves to another notebook (A766). */
  onNotebookMove(listener: (noteId: string, notebook: string) => void): () => void {
    this.notebookListeners.add(listener);
    return () => this.notebookListeners.delete(listener);
  }

  /** The notebook a note filed in `folderId` belongs to (A766), or null when not certain. */
  notebookOf(folderId: string | null): string | null {
    return notebookOfFolder(this.doc, folderId);
  }

  /** The salt of derived folder ids (A820): a git notebook's id, or its own (A1021). */
  private get salt(): string {
    return this.gitSalt;
  }

  /** Whether a note was deleted for good in this git notebook (A828). */
  isPurged(id: string): boolean {
    return isPurged(this.doc, id);
  }

  /**
   * Records a note as deleted for good in this git notebook (A828): its id in `purged`, out of
   * the registry. Every engine then drops it and removes its files from the branch.
   */
  markPurged(id: string): void {
    markPurged(this.doc, id, Date.now());
  }

  /**
   * Takes a Delete for good back before it synced (Keep note, A855): the note is filed again at
   * the top level (still in Trash if it was there), and every engine reads it back from the
   * branch. Nothing is deleted, so it needs no confirmation; `markPurged` undoes it.
   */
  unmarkPurged(id: string): void {
    unmarkPurged(this.doc, id);
  }

  private update(change: Partial<WorkspaceState>): void {
    this.state = { ...this.state, ...change };
    for (const listener of this.listeners) listener();
  }
}
