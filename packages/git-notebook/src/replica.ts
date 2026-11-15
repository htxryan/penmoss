/**
 * What a device holds of one git notebook (T50, A820): the merged WorkspaceDoc and note docs (as
 * the app's IndexedDB holds them, in the CLI's files), plus the engine's bookkeeping. Every local
 * change, by whatever route, marks its note as changed here, through the docs' update events: the
 * engine needs no list of edits, only the docs and these marks (A821).
 */
import * as Y from '@y/y';
import type { NotebookInfo } from './layout';
import type { WriterRecord } from './writer';
import { applyKeepingId, ENGINE_ORIGIN, GIT_ORIGIN, newDoc, LOCAL_STORE_ORIGIN } from './yjs';

/** The engine's bookkeeping, saved with the docs. */
export interface NotebookMeta {
  /** `notebook.json` as last seen at head, or as this device will create it. */
  readonly info: NotebookInfo | null;
  /** This profile's writer (A821); null before its first sync. */
  readonly writer: WriterRecord | null;
  /** The head of the last sync that landed or found nothing to commit. */
  readonly lastHead: string | null;
  /** Notes changed here since the last sync that landed, with when (epoch ms). */
  readonly dirty: Readonly<Record<string, number>>;
  /** The WorkspaceDoc changed here since the last sync that landed. */
  readonly workspaceDirty: boolean;
  /** The Yjs client ids this writer used (its actor file, A829). */
  readonly ownClients: readonly number[];
  /**
   * The Yjs client id this writer's last process wrote with (A821). Never reused: each process
   * takes a new one that no doc here holds and `ownClients` does not list, since a profile rolled
   * back to older files may otherwise repeat clocks the branch already has.
   */
  readonly clientId: number | null;
  /**
   * The client id this writer's name claims are written under (A823), kept like `clientId`: a
   * claims fork is made from the workspace after head is applied, so its clock always continues.
   */
  readonly claimsClientId: number | null;
  /** Files at head this writer could not read (unreadable or too large): path → why. */
  readonly skipped: Readonly<Record<string, string>>;
  /** A counter per note, raised on every change from anywhere: the local `baseVersion`. */
  readonly revs: Readonly<Record<string, number>>;
  /** Frontmatter ids of rendered files by git blob id ('' for none), so a sync reads each once. */
  readonly mdIds: Readonly<Record<string, string>>;
  /**
   * What the repository changed here that the client has not confirmed it showed
   * (`takeGitChanges`, `confirmGitChanges`): saved with the docs, so a window that closes or
   * crashes between a fetch and showing it leaves it to the next engine. Absent: nothing.
   */
  readonly undelivered?: GitChanges | null;
  /**
   * Copies withheld from the push (A886): brought back after a store was cleared, their original
   * deleted for good on another device before they first reached the branch. Kept on this device
   * only, by copy id: never pushed until the person confirms Keep and sync. `update` is the copy's
   * whole doc (base64) where nothing else keeps it; Android's Room keeps it there instead.
   */
  readonly withheld?: Readonly<Record<string, WithheldCopy>>;
  /** Withheld copies the person confirmed keeping and syncing: pushed, until on the branch. */
  readonly keptCopies?: readonly string[];
  /**
   * The name Rename gave the notebook on this device, until a sync lands it in `notebook.json`
   * (Ryan's review of PR #192). `info.name` is already this name. Absent or null: none.
   */
  readonly pendingName?: string | null;
}

/** A copy withheld from the push (A886), as this device keeps it. */
export interface WithheldCopy {
  /** The original's id: deleted for good on another device. */
  readonly origin: string;
  readonly title: string;
  /** Where it was filed when it was withheld, for Keep and sync. */
  readonly folderId: string | null;
  /** When (epoch ms). */
  readonly at: number;
  /** Its whole doc (base64), when this device keeps it with the engine's store. */
  readonly update?: string;
}

export const EMPTY_META: NotebookMeta = {
  info: null,
  writer: null,
  lastHead: null,
  dirty: {},
  workspaceDirty: false,
  ownClients: [],
  clientId: null,
  claimsClientId: null,
  skipped: {},
  revs: {},
  mdIds: {},
  undelivered: null,
};

/** A whole saved notebook. */
export interface NotebookSnapshot {
  readonly workspace: Uint8Array | null;
  readonly notes: ReadonlyMap<string, Uint8Array>;
  readonly meta: NotebookMeta;
}

/** What changed since the last save: docs to write (null: delete) and the bookkeeping. */
export interface NotebookChange {
  readonly workspace: Uint8Array | null;
  readonly notes: ReadonlyMap<string, Uint8Array | null>;
  readonly meta: NotebookMeta;
}

/** What the repository changed on a device, for its views (`takeGitChanges`). */
export interface GitChanges {
  /** Notes other writers changed. */
  readonly changed: readonly string[];
  /** The WorkspaceDoc changed (tree, names, Trash, purges). */
  readonly workspaceChanged: boolean;
  /** Notes dropped because someone deleted them for good. */
  readonly purged: readonly string[];
}

/** Where a device keeps a notebook (the CLI's files, the app's IndexedDB, memory in tests). */
export interface NotebookStorage {
  load(): Promise<NotebookSnapshot | null>;
  save(change: NotebookChange): Promise<void>;
  /** An attachment's bytes (`<sha256>.<ext>`), when this device has them. */
  readAttachment(file: string): Promise<Uint8Array | null>;
  writeAttachment(file: string, bytes: Uint8Array): Promise<void>;
}

export class MemoryStorage implements NotebookStorage {
  snapshot: NotebookSnapshot | null = null;
  readonly attachments = new Map<string, Uint8Array>();
  saves = 0;

  load(): Promise<NotebookSnapshot | null> {
    return Promise.resolve(this.snapshot);
  }

  save(change: NotebookChange): Promise<void> {
    this.saves++;
    const notes = new Map(this.snapshot?.notes ?? []);
    for (const [id, bytes] of change.notes) {
      if (bytes === null) notes.delete(id);
      else notes.set(id, bytes);
    }
    this.snapshot = {
      workspace: change.workspace ?? this.snapshot?.workspace ?? null,
      notes,
      meta: change.meta,
    };
    return Promise.resolve();
  }

  readAttachment(file: string): Promise<Uint8Array | null> {
    return Promise.resolve(this.attachments.get(file) ?? null);
  }

  writeAttachment(file: string, bytes: Uint8Array): Promise<void> {
    this.attachments.set(file, bytes);
    return Promise.resolve();
  }

  /** A copy of everything, as a copied profile carries it (no writer secret: that is elsewhere). */
  copy(): MemoryStorage {
    const out = new MemoryStorage();
    out.snapshot = this.snapshot && {
      workspace: this.snapshot.workspace,
      notes: new Map(this.snapshot.notes),
      meta: { ...this.snapshot.meta },
    };
    for (const [file, bytes] of this.attachments) out.attachments.set(file, bytes);
    return out;
  }
}

/** The docs of one notebook in memory, with the marks the engine reads. */
export class NotebookReplica {
  readonly workspace: Y.Doc;
  private readonly docs = new Map<string, Y.Doc>();
  private meta: NotebookMeta;
  /** Docs to write at the next save (null: removed). */
  private readonly unsaved = new Map<string, Y.Doc | null>();
  private workspaceUnsaved = false;
  private metaUnsaved = false;
  /**
   * Notes the repository changed here that the client has not taken yet (`takeGitChanges`). Kept
   * across syncs: a fetch applies them before a push that may fail, and they must still reach
   * the client's views then.
   */
  readonly fromGit = new Set<string>();
  private workspaceFromGit = false;
  /** Notes a sync dropped (someone deleted them for good) that the client has not taken yet. */
  private readonly droppedByGit = new Set<string>();
  /** Taken but not yet confirmed shown (`confirmDelivery` only): given again until confirmed. */
  private readonly delivering = {
    changed: new Set<string>(),
    workspace: false,
    purged: new Set<string>(),
  };
  private readonly listeners = new Set<(ids: ReadonlySet<string>) => void>();

  private currentClientID: number;

  constructor(
    snapshot: NotebookSnapshot | null,
    /** The writer's Yjs client id for every doc (A821). */
    clientID: number,
    private readonly clock: () => number,
    /**
     * The client confirms what it showed (`confirmGitChanges`), as the Mac's engine host does
     * once its store holds it; otherwise taking a change is showing it (the CLI reads the docs).
     */
    private readonly confirmDelivery = false,
  ) {
    this.currentClientID = clientID;
    this.meta = { ...EMPTY_META, ...snapshot?.meta, clientId: clientID };
    this.metaUnsaved = snapshot?.meta.clientId !== clientID;
    this.workspace = newDoc(clientID);
    // The saved docs hold this writer's own content under its id: loaded without Yjs re-iding them.
    if (snapshot?.workspace) applyKeepingId(this.workspace, snapshot.workspace, GIT_ORIGIN);
    this.watch(this.workspace, null);
    for (const [id, bytes] of snapshot?.notes ?? []) {
      const doc = newDoc(clientID);
      applyKeepingId(doc, bytes, GIT_ORIGIN);
      this.docs.set(id, doc);
      this.watch(doc, id);
    }
    // What a previous engine fetched and no client confirmed showing: given again.
    const undelivered = snapshot?.meta.undelivered;
    for (const id of undelivered?.changed ?? []) this.fromGit.add(id);
    for (const id of undelivered?.purged ?? []) this.droppedByGit.add(id);
    if (undelivered?.workspaceChanged) this.workspaceFromGit = true;
  }

  get state(): NotebookMeta {
    return this.meta;
  }

  get clientID(): number {
    return this.currentClientID;
  }

  /** Every client id the docs hold content of (whoever wrote it). */
  usedClientIds(): Set<number> {
    const out = new Set<number>();
    for (const doc of [this.workspace, ...this.docs.values()]) {
      for (const id of Y.decodeStateVector(Y.encodeStateVector(doc)).keys()) out.add(id);
    }
    return out;
  }

  /**
   * Writes with another client id from now on (A821): a copied profile, or a clash with another
   * writer's id. `id` must hold no content in any doc yet.
   */
  setClientId(id: number): void {
    this.currentClientID = id;
    this.workspace.clientID = id;
    for (const doc of this.docs.values()) doc.clientID = id;
    this.update({ clientId: id });
  }

  update(patch: Partial<NotebookMeta>): void {
    this.meta = { ...this.meta, ...patch };
    this.metaUnsaved = true;
  }

  noteIds(): string[] {
    return [...this.docs.keys()].sort();
  }

  note(id: string): Y.Doc | undefined {
    return this.docs.get(id);
  }

  get notes(): ReadonlyMap<string, Y.Doc> {
    return this.docs;
  }

  /** The doc of a note, made empty when this device has none yet. */
  ensureNote(id: string): Y.Doc {
    let doc = this.docs.get(id);
    if (!doc) {
      doc = newDoc(this.currentClientID);
      this.docs.set(id, doc);
      this.watch(doc, id);
      this.unsaved.set(id, doc);
    }
    return doc;
  }

  /**
   * Takes in changes made to a note (or, for `null`, the WorkspaceDoc) outside this replica: the
   * Mac app's windows edit their own copies of the docs and store them, and the engine reads them
   * from the store (A851). What the replica lacks is applied as a local change, so it is marked
   * changed here and its authors' client ids become this writer's (A829). True when anything was
   * new. A note purged here is never taken back in (the caller checks, A828).
   */
  adopt(id: string | null, update: Uint8Array): boolean {
    const doc = id === null ? this.workspace : this.ensureNote(id);
    let changed = false;
    const off = (bytes: Uint8Array) => {
      if (bytes.byteLength > 2) changed = true;
    };
    doc.on('update', off);
    try {
      applyKeepingId(doc, update, LOCAL_STORE_ORIGIN);
    } finally {
      doc.off('update', off);
    }
    return changed;
  }

  /** Forgets a note (Delete for good, A828): its doc, its marks, its file. */
  dropNote(id: string): void {
    const doc = this.docs.get(id);
    if (!doc) return;
    doc.destroy();
    this.docs.delete(id);
    this.unsaved.set(id, null);
    this.update({ dirty: without(this.meta.dirty, id), revs: without(this.meta.revs, id) });
  }

  /** The note's local `baseVersion` (A821's local stand-in for the server's version ids). */
  rev(id: string): number {
    return this.meta.revs[id] ?? 1;
  }

  /** Called with the ids of notes that changed (from anywhere) since the last call. */
  onChange(listener: (ids: ReadonlySet<string>) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** A sync dropped this note: someone deleted it for good (A828). */
  dropNoteFromGit(id: string): void {
    if (!this.docs.has(id)) return;
    this.dropNote(id);
    this.fromGit.delete(id);
    this.droppedByGit.add(id);
  }

  /** The WorkspaceDoc changed in a way the client must be shown, as if from the repository. */
  showWorkspace(): void {
    this.workspaceFromGit = true;
  }

  get workspaceChangedByGit(): boolean {
    return this.workspaceFromGit;
  }

  /**
   * What the repository changed here that the client has not shown yet, whether or not the sync
   * that applied it went on to push (a failed push still fetched and applied). Without
   * `confirmDelivery` it is forgotten now; with it, it is given again until `confirmGitChanges`.
   */
  takeGitChanges(): GitChanges {
    const d = this.delivering;
    const changed = [...new Set([...d.changed, ...this.fromGit])]
      .filter((id) => this.docs.has(id))
      .sort();
    const purged = [...new Set([...d.purged, ...this.droppedByGit])]
      .filter((id) => !this.docs.has(id))
      .sort();
    const workspaceChanged = d.workspace || this.workspaceFromGit;
    this.fromGit.clear();
    this.droppedByGit.clear();
    this.workspaceFromGit = false;
    d.changed.clear();
    d.purged.clear();
    d.workspace = false;
    if (this.confirmDelivery) {
      for (const id of changed) d.changed.add(id);
      for (const id of purged) d.purged.add(id);
      d.workspace = workspaceChanged;
    }
    return { changed, workspaceChanged, purged };
  }

  /** The client showed these (its store holds them): not given again, here or after a restart. */
  confirmGitChanges(shown: GitChanges): void {
    const d = this.delivering;
    for (const id of shown.changed) d.changed.delete(id);
    for (const id of shown.purged) d.purged.delete(id);
    if (shown.workspaceChanged) d.workspace = false;
  }

  /** What no client has confirmed showing: pending and taken alike. */
  private undelivered(): GitChanges | null {
    const d = this.delivering;
    const changed = [...new Set([...d.changed, ...this.fromGit])].sort();
    const purged = [...new Set([...d.purged, ...this.droppedByGit])].sort();
    const workspaceChanged = d.workspace || this.workspaceFromGit;
    return changed.length === 0 && purged.length === 0 && !workspaceChanged
      ? null
      : { changed, workspaceChanged, purged };
  }

  /**
   * After a sync landed (or had nothing to commit) on `head`: the marks made up to `upTo` are
   * done. Marks made since (an edit during the push) stay for the next sync.
   */
  synced(head: string | null, upTo: ReadonlyMap<string, number>, workspaceAt: boolean): void {
    const dirty: Record<string, number> = { ...this.meta.dirty };
    for (const [id, at] of upTo) if (dirty[id] === at) delete dirty[id];
    this.update({
      lastHead: head,
      dirty,
      workspaceDirty: workspaceAt ? false : this.meta.workspaceDirty,
    });
  }

  /** Writes what changed since the last save. */
  async save(storage: NotebookStorage): Promise<void> {
    const undelivered = this.undelivered();
    if (JSON.stringify(undelivered) !== JSON.stringify(this.meta.undelivered ?? null)) {
      this.update({ undelivered });
    }
    if (!this.workspaceUnsaved && this.unsaved.size === 0 && !this.metaUnsaved) return;
    const notes = new Map<string, Uint8Array | null>();
    for (const [id, doc] of this.unsaved) notes.set(id, doc ? Y.encodeStateAsUpdate(doc) : null);
    const workspace = this.workspaceUnsaved ? Y.encodeStateAsUpdate(this.workspace) : null;
    this.unsaved.clear();
    this.workspaceUnsaved = false;
    this.metaUnsaved = false;
    await storage.save({ workspace, notes, meta: this.meta });
  }

  destroy(): void {
    for (const doc of this.docs.values()) doc.destroy();
    this.workspace.destroy();
  }

  private watch(doc: Y.Doc, id: string | null): void {
    doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (update.byteLength <= 2) return;
      const local = origin !== GIT_ORIGIN && origin !== ENGINE_ORIGIN;
      // Whoever wrote what did not come from the repository is this writer (A829): the replica's
      // own id, or a window's that the engine adopts from the store (A851).
      const authors = origin === GIT_ORIGIN ? [] : structClients(update, doc.clientID);
      if (id === null) {
        this.workspaceUnsaved = true;
        if (origin === GIT_ORIGIN) this.workspaceFromGit = true;
        if (local) {
          this.update({
            workspaceDirty: true,
            ownClients: withIds(this.meta.ownClients, authors),
          });
        } else if (authors.some((each) => !this.meta.ownClients.includes(each))) {
          this.update({ ownClients: withIds(this.meta.ownClients, authors) });
        }
        return;
      }
      this.unsaved.set(id, doc);
      const revs = { ...this.meta.revs, [id]: this.rev(id) + 1 };
      if (origin === GIT_ORIGIN) this.fromGit.add(id);
      if (local) {
        this.update({
          revs,
          dirty: {
            ...this.meta.dirty,
            [id]: Math.max(this.clock(), (this.meta.dirty[id] ?? 0) + 1),
          },
          ownClients: withIds(this.meta.ownClients, authors),
        });
      } else {
        this.update({ revs, ownClients: withIds(this.meta.ownClients, authors) });
      }
      for (const listener of this.listeners) listener(new Set([id]));
    });
  }
}

function without<T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> {
  const out = { ...record };
  delete out[key];
  return out;
}

function withIds(ids: readonly number[], add: readonly number[]): readonly number[] {
  const missing = add.filter((id) => !ids.includes(id));
  return missing.length === 0 ? ids : [...new Set([...ids, ...missing])].sort((a, b) => a - b);
}

/**
 * The client ids that wrote content in `update` (its structs; a delete names others' content,
 * not its own). `fallback` when it cannot be read.
 */
function structClients(update: Uint8Array, fallback: number): number[] {
  try {
    return [...Y.decodeStateVector(Y.encodeStateVectorFromUpdate(update)).keys()];
  } catch {
    return [fallback];
  }
}
