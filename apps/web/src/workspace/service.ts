/**
 * A git notebook's workspace document in the app (T7, A860; T59): the folder tree, note
 * registry, sort modes and settings. It is kept in the notebook's NoteStore under a reserved key,
 * so the tree shows at once on reload, and a `ReplicaKeeper` writes its changes back (A1031); the
 * notebook's engine commits and pushes what is stored and writes what it pulls into the store,
 * which `pullStored` reads in.
 */
import { ulid } from '@penmoss/core/ids';
import type { PeriodKind } from '@penmoss/core/periodic';
import { isLocalSetting, type SettingsPlatform } from '@penmoss/core/settings';
import { type SortMode } from '@penmoss/core/workspace';
import type { ReplicaStore } from '@penmoss/model/record';
import { ReplicaKeeper } from '../store/keeper';
import { mergeRecords } from '@penmoss/model/records';
import {
  createFolder,
  deleteFolder,
  endPosition,
  fallbackFolder,
  fileJournalNote,
  inboxFolder,
  moveFolder,
  moveNote,
  readFolderTrash,
  mergedSettings,
  readWorkspace,
  registerNote,
  renameFolder,
  restoreFolder,
  setSortMode,
  setFolderAiDescription,
  setTagDescription,
  setTogether,
  unregisterNote,
  WORKSPACE_RECORD_KEY,
  writeSetting,
  type FolderRestore,
  type TrashedFolder,
  type WorkspaceSnapshot,
} from '@penmoss/model/workspace';
import { isPurged, markPurged, unmarkPurged } from '@penmoss/git-notebook';
import { createYjs14Replica, type Yjs14Replica } from '@penmoss/model/yjs14';
import { LocalSettings } from './local-settings';
import { recordSetting } from '../analytics/track';
import type { MovePlan } from './model';

/** The web and the Mac app share the Macs' copy of the look and layout (PEN-156, A1605). */
const SETTINGS_PLATFORM: SettingsPlatform = 'desktop';

/** Where captures filed as new notes go (T30). */
export { INBOX } from '@penmoss/model/workspace';

/** Where a note out of Trash goes (`restorePlace`), or that no place is known (T43 review B2). */
export type RestorePlace = { readonly folderId: string | null } | { readonly refused: true };

export interface WorkspaceOptions {
  /**
   * The git notebook (T50, A860): its settings are its own (A827: the notebook's under
   * `notebook`, the device's under `device`), and its derived folder ids are salted with the
   * notebook's id (A820), or with its own `salt` (`''`: none, the notebook imported from the
   * personal workspace, A1021).
   */
  readonly gitNotebook: { readonly id: string; readonly salt?: string };
  /** Opens the store the WorkspaceDoc is kept in (the notebook's own database). */
  readonly openStore: () => Promise<ReplicaStore>;
  /**
   * Whether this window shows the folder notice (default true). One that does not (the Mac's
   * capture window) leaves the count of folder changes a closed window could not keep to the
   * next one that does (#116, A676).
   */
  readonly notices?: boolean;
  /**
   * Where this device keeps its own look and layout (A1626): the app's one `localStorage` copy;
   * a test's own, in memory, when not given.
   */
  readonly localSettings?: LocalSettings;
}

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
  private loading: Promise<void> | null = null;
  private stopped: (() => void) | null = null;
  private readonly local: LocalSettings;
  private readonly unfollowLocal: () => void;
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
    this.local = options.localSettings ?? new LocalSettings(null);
    this.unfollowLocal = this.local.subscribe(() => this.update({}));
    const { openStore } = options;
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
    this.unfollowLocal();
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

  renameFolder(id: string, name: string): void {
    renameFolder(this.doc, id, name);
  }

  /** Deletes a folder and its subfolders to Trash; their notes move up (A17, T42 A560). */
  deleteFolder(id: string): void {
    deleteFolder(this.doc, id);
  }

  /** Folders in Trash, newest first (T42, A560). Read from the document: it works offline. */
  folderTrash(): TrashedFolder[] {
    return readFolderTrash(this.doc);
  }

  /** Brings a folder back from Trash with its subfolders and the notes still where it left them. */
  restoreFolder(id: string): FolderRestore {
    return restoreFolder(this.doc, id);
  }

  /** A folder's AI Descriptions value (PEN-161): Inherit, On or Off. Synced. */
  setFolderAiDescription(folderId: string, value: 'inherit' | 'on' | 'off'): void {
    setFolderAiDescription(this.doc, folderId, value);
  }

  setSortMode(folderId: string | null, mode: SortMode): void {
    setSortMode(this.doc, folderId, mode);
  }

  /**
   * Files a new note at the end of `folderId` (null: the top level). A folder that is gone gives
   * way to the nearest folder above it still in the tree (T43 review B2, A757); with no place
   * known the note is filed where it was meant to go.
   */
  registerNote(id: string, folderId: string | null): void {
    const place = fallbackFolder(this.doc, folderId);
    registerNote(this.doc, { id, folderId: 'folderId' in place ? place.folderId : folderId });
  }

  /** Files a conflict copy (A5) beside its original: the same folder. */
  registerCopy(id: string, originalId: string | undefined): void {
    const original = originalId
      ? this.state.snapshot.notes.find((note) => note.id === originalId)
      : undefined;
    this.registerNote(id, original?.folderId ?? null);
  }

  /**
   * Where a note coming out of Trash goes (T43 review B2, A757): the folder it was deleted from,
   * or the nearest one above it still in the tree; refused when Trash forgets a folder on the way
   * up: the person is asked.
   */
  restorePlace(noteId: string, folderId: string | null): RestorePlace {
    // Still filed (deleted on a device that had not synced the tree, A197): it stays.
    const entry = this.state.snapshot.notes.find((note) => note.id === noteId);
    if (entry) return { folderId: entry.folderId };
    const place = fallbackFolder(this.doc, folderId);
    return 'folderId' in place ? { folderId: place.folderId } : { refused: true };
  }

  /**
   * Files a daily or weekly note under `Journal/<year>/<month>` or
   * `Journal/<year>/Weekly` (T19), creating the folders it needs with ids
   * derived from their paths, so two devices doing this offline make the same
   * folders. A note already filed (by any device) stays where it is.
   */
  fileJournalNote(id: string, kind: PeriodKind, period: string): void {
    fileJournalNote(this.doc, id, kind, period, this.salt);
  }

  /**
   * Files a captured note (T30) in the top-level Inbox folder: the user's own
   * "Inbox" if there is one, else one created with an id derived from its
   * name, so two devices capturing offline make one Inbox.
   */
  fileInInbox(id: string): string {
    return this.doc.transact(() => {
      const folderId = inboxFolder(this.doc, this.salt);
      registerNote(this.doc, { id, folderId });
      return folderId;
    });
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

  /** Sets what `tag` means (PEN-68); a description with no text removes it. */
  setTagDescription(tag: string, text: string): void {
    setTagDescription(this.doc, tag, text);
  }

  /**
   * The settings: the device's, with the notebook's own over them (A827), the Macs' own copy of
   * the look and layout over the shared one (PEN-156, A1605), and this device's own over that
   * (A1626).
   */
  settings(): Record<string, unknown> {
    return this.local.over(mergedSettings(this.doc, SETTINGS_PLATFORM));
  }

  /**
   * Sets one setting (undefined removes it), straight in: the engine commits it (A827). The look
   * and layout stay on this device and never reach the notebook (A1626).
   */
  setSetting(key: string, value: unknown): void {
    // An allowlisted setting's change, by name (PEN-137): never a text setting's text.
    recordSetting(key, value);
    if (isLocalSetting(key)) {
      this.local.set(key, value);
      return;
    }
    writeSetting(this.doc, key, value, null, SETTINGS_PLATFORM);
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
