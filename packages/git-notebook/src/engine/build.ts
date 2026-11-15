/**
 * One build of a sync (A822): everything between the fetch and the push, in the order of the
 * engine's steps. `Build.run` reads the target, applies what the branch changed, names and
 * renders, recomputes this writer's own files and commits them on top of the head; the engine
 * pushes the commit, and builds again from a new fetch when the push is rejected.
 */
import { gitBlobSha } from '@penmoss/core/mirror';
import { attachmentFiles, noteBodyForDisplay } from '@penmoss/editor/markdown';
import { NOTE_META } from '@penmoss/sync-client/note';
import * as Y from '@y/y';
import { actorFile, parseActor, type ActorFile } from '../actors';
import {
  encodeNotebookInfo,
  FORMAT,
  type Layout,
  parseNotebookInfo,
  RENDER_VERSION,
  type NotebookInfo,
} from '../layout';
import { frontmatterId, storeClaims, type Foreign } from '../names';
import { isPurged, markPurged, purgedIds, WORKSPACE_PURGED_FROM } from '../purge';
import { commitPurges } from '../purge-check';
import { CHANGED_AT_PREFIX, renderNoteFile, renderSet, UNSUPPORTED_RENDER } from '../render';
import type { NotebookReplica } from '../replica';
import { GitRefused, GitTransportError, type GitTransport } from '../transport';
import type { WriterKind, WriterRecord } from '../writer';
import {
  applyKeepingId,
  ENGINE_ORIGIN,
  forkDoc,
  freshClientId,
  GIT_ORIGIN,
  hasPending,
  ownFile,
} from '../yjs';
import type { BlobReader } from './blobs';
import {
  contentless,
  dropOrphans,
  pendingKeptCopies,
  unpushedCopies,
  withholdRaced,
} from './copies';
import { NotebookError, WriterFull } from './errors';
import { foreignAt, headPaths, namesAt, renderedPaths } from './names-at';
import { MAX_ACTOR_BYTES, MAX_LOG_BYTES, type EngineOptions } from './options';

/**
 * Commits name how many notes they carry; `[skip ci]` keeps a code repo's CI quiet (A825). The
 * author is the device's git identity; the trailer names the writer, so History can tell an
 * agent's commit from its person's.
 */
export function commitMessage(
  notes: number,
  writer?: { readonly id: string; readonly kind: WriterKind; readonly label: string },
): string {
  const subject = `Penmoss: ${notes} ${notes === 1 ? 'note' : 'notes'} [skip ci]`;
  if (!writer) return subject;
  const label = writer.label.replace(/["\r\n]/g, ' ').trim();
  return `${subject}\n\nPenmoss-Writer: ${writer.id} (${writer.kind} "${label}")\n`;
}

/** What a build gives the engine: a commit to push, or nothing to commit. */
export interface Built {
  readonly head: string | null;
  readonly commit: string | null;
  readonly notes: number;
  readonly handEdits: string[];
  readonly foreign: readonly string[];
  readonly copies: readonly string[];
  readonly renderSkipped: boolean;
  /** Joins the claims into the local WorkspaceDoc: called once the commit landed. */
  readonly landed: () => void;
  readonly dirtyAt: ReadonlyMap<string, number>;
  readonly workspaceDirty: boolean;
  readonly info: NotebookInfo;
}

/** What a build works with: the engine's for this sync. */
export interface BuildContext {
  /** The transport this sync uses (refusing every call once its signal is aborted). */
  readonly git: GitTransport;
  readonly replica: NotebookReplica;
  readonly layout: Layout;
  readonly writer: WriterRecord;
  readonly options: EngineOptions;
  readonly blobs: BlobReader;
  readonly random: () => number;
  /** Recompute every note's own file, not only changed ones. */
  readonly full: boolean;
}

export class Build {
  private readonly git: GitTransport;
  private readonly replica: NotebookReplica;
  private readonly layout: Layout;
  private readonly writer: WriterRecord;
  private readonly options: EngineOptions;

  // The target (`readTarget`).
  private head: string | null = null;
  private files: ReadonlyMap<string, string> = new Map();
  /** Files at head this writer could not read or apply this build: path → why. */
  private readonly skipped = new Map<string, string>();
  private info!: NotebookInfo;
  private writeInfo = false;
  private actorPaths: string[] = [];
  /** notebook.json and the actor files, read together. */
  private firstRead: Map<string, Uint8Array> | null = null;

  // What the branch changed (`applyWorkspaceLogs` and on).
  private changed: ReadonlySet<string> = new Set();
  /** No known last head (a first sync, or history rewritten): read and render everything. */
  private everything = false;
  /** Every log at head by doc ('' for the WorkspaceDoc): [path, writer]. */
  private readonly byDoc = new Map<string, Array<[string, string]>>();
  /** This writer's own content arrived from the branch (a restored backup, A821). */
  private behind = false;
  private landedPurges = new Set<string>();
  private purged: ReadonlySet<string> = new Set();
  /** Copies the person confirmed keeping that are not on the branch yet (A886). */
  private keptCopies: readonly string[] = [];
  /** Copies not on the branch yet (A886). */
  private unpushed: readonly string[] = [];
  /** Notes whose logs this build applied. */
  private readonly applied = new Set<string>();
  private dirtyAt: ReadonlyMap<string, number> = new Map();
  private workspaceDirty = false;

  // The commit's content.
  private readonly changes = new Map<string, Uint8Array | null>();
  private readonly touchedNotes = new Set<string>();
  private readonly handEdits: string[] = [];
  /** Frontmatter ids of the rendered files at head, by blob id. */
  private mdIds: Record<string, string> = {};
  private foreign!: Foreign;
  /** Other writers' client ids, from their actor files. */
  private others = new Set<number>();
  private renders = true;
  private claimsDoc!: Y.Doc;
  private claims = 0;
  /** A log of this writer's own it could not read: never written over (the writer retires). */
  private ownLogUnread = false;
  private ownClients = new Set<number>();

  constructor(private readonly context: BuildContext) {
    this.git = context.git;
    this.replica = context.replica;
    this.layout = context.layout;
    this.writer = context.writer;
    this.options = context.options;
  }

  async run(): Promise<Built> {
    await this.readTarget();
    // 1. Apply the logs that changed (all of them without a known last head).
    const noteLogs = await this.applyWorkspaceLogs();
    await this.reassertLandedPurges();
    this.dropPurged();
    await this.holdBackCopies();
    await this.applyNoteLogs(noteLogs);
    await this.reapplyStuck();
    this.moveOnIfBehind();
    // 2. `updated` (A823): this writer's key on the notes it changed.
    this.stampChangedAt();
    // 3. Names and the render, unless a newer client owns the render (A823).
    await this.readNamesAtHead();
    this.checkOtherWriters();
    await this.renderChanges();
    // 4. Own files (A821): the WorkspaceDoc (with this render's claims) and the notes.
    await this.ownFileChanges();
    // 5. Attachments the notes use that the branch lacks, from this device's store.
    await this.attachmentChanges();
    // 6. The actor file (A829) and notebook.json.
    this.actorAndInfo();
    await this.recordMdIds();
    return this.commitBuilt();
  }

  private readLogs(paths: Iterable<string>): Promise<Map<string, Uint8Array>> {
    return this.context.blobs.logs(this.git, this.head!, this.files, paths, this.skipped);
  }

  /** The branch's head, its files, and the notebook there (`notebook.json`). */
  private async readTarget(): Promise<void> {
    const { replica, layout } = this;
    const head = await this.git.fetch();
    if (head === null && replica.state.lastHead !== null) {
      // Pushing now would start a new history on a branch someone deleted or renamed.
      throw new NotebookError(
        'branch_gone',
        `The branch is gone from the repository (it was at ${replica.state.lastHead.slice(0, 7)} at the last sync). Nothing was pushed; your changes are kept. Restore the branch, or point the notebook at another.`,
      );
    }
    this.head = head;
    const files: ReadonlyMap<string, string> = head ? await this.git.list(head) : new Map();
    this.files = files;

    // notebook.json and the actor files (small, read together: one fetch for both).
    this.actorPaths = [...files.keys()].filter((path) => layout.parse(path)?.kind === 'actor');
    this.firstRead =
      head && (files.has(layout.notebook) || this.actorPaths.length > 0)
        ? await this.context.blobs.read(this.git, head, files, [
            layout.notebook,
            ...this.actorPaths,
          ])
        : null;
    const infoBytes = this.firstRead && files.has(layout.notebook) ? this.firstRead : null;
    const atHead = infoBytes?.get(layout.notebook)
      ? parseNotebookInfo(infoBytes.get(layout.notebook)!)
      : null;
    if (infoBytes && !atHead) {
      throw new NotebookError(
        'format',
        `${layout.notebook} is not a notebook file Penmoss can read.`,
      );
    }
    let info: NotebookInfo;
    if (atHead) {
      if (atHead.format > FORMAT) {
        throw new NotebookError(
          'format',
          `This notebook is format ${atHead.format}; this Penmoss reads format ${FORMAT}. Update Penmoss.`,
        );
      }
      const mine = replica.state.info;
      if (mine && mine.id !== atHead.id) {
        throw new NotebookError(
          'other_notebook',
          `The target holds the notebook “${atHead.name}” (${atHead.id}), not “${mine.name}” (${mine.id}).`,
        );
      }
      info = atHead;
      if (atHead.renderVersion < RENDER_VERSION) {
        info = { ...atHead, renderVersion: RENDER_VERSION };
        this.writeInfo = true;
      }
    } else {
      const mine = replica.state.info;
      if (!mine) {
        throw new NotebookError('no_notebook', 'There is no Penmoss notebook at this target yet.');
      }
      info = mine;
      this.writeInfo = true;
    }
    // A Rename made here (Ryan's review of PR #192) goes into notebook.json with this commit.
    const pendingName = replica.state.pendingName;
    if (pendingName !== null && pendingName !== info.name) {
      info = { ...info, name: pendingName };
      this.writeInfo = true;
    }
    this.info = info;
  }

  /** Applies a log to `doc`; one Yjs cannot apply is skipped and reported. */
  private apply(doc: Y.Doc, path: string, bytes: Uint8Array): void {
    try {
      // This writer's own content arriving from the branch means this profile's files are older
      // than what it pushed (a restored backup): its client clocks may repeat, so it moves on to
      // a new client id before it writes more (A821).
      if (applyKeepingId(doc, bytes, GIT_ORIGIN)) this.behind = true;
    } catch (error) {
      this.skipped.set(path, `could not be applied (${(error as Error).message})`);
    }
  }

  /**
   * Indexes the logs at head by doc and applies the WorkspaceDoc's that changed (it carries
   * `purged`, A828, so it goes first); gives the notes' changed logs, for `applyNoteLogs`.
   */
  private async applyWorkspaceLogs(): Promise<Array<[string, string]>> {
    const { replica, layout, head, files } = this;
    const lastHead = replica.state.lastHead;
    let changedList: readonly string[] | null;
    if (head === null || lastHead === head) changedList = [];
    else if (lastHead === null) changedList = null;
    else changedList = await this.git.changed(lastHead, head);
    this.everything = head !== null && changedList === null;
    const changed = new Set(changedList ?? files.keys());
    this.changed = changed;
    const workspaceLogs: string[] = [];
    const noteLogs: Array<[string, string]> = [];
    for (const path of files.keys()) {
      const parsed = layout.parse(path);
      if (!parsed || (parsed.kind !== 'note' && parsed.kind !== 'workspace')) continue;
      const key = parsed.kind === 'note' ? parsed.noteId : '';
      let list = this.byDoc.get(key);
      if (!list) this.byDoc.set(key, (list = []));
      list.push([path, parsed.writer]);
      if (!changed.has(path)) continue;
      if (parsed.kind === 'workspace') workspaceLogs.push(path);
      else noteLogs.push([path, parsed.noteId]);
    }
    if (head && workspaceLogs.length > 0) {
      const read = await this.readLogs(workspaceLogs);
      replica.workspace.transact(() => {
        for (const path of workspaceLogs) {
          const bytes = read.get(path);
          if (bytes) this.apply(replica.workspace, path, bytes);
        }
      }, GIT_ORIGIN);
    }
    return noteLogs;
  }

  /**
   * A Delete for good that landed is never taken back (A855): a mark the head holds and this
   * WorkspaceDoc dropped (a stale Keep note, or a page script) is set again, so the note's
   * content cannot come back from a writer that still holds an old copy.
   */
  private async reassertLandedPurges(): Promise<void> {
    const { replica } = this;
    if (!this.head) return;
    const atHead = await this.readLogs((this.byDoc.get('') ?? []).map(([path]) => path));
    const merged = new Y.Doc();
    for (const bytes of atHead.values()) Y.applyUpdate(merged, bytes);
    this.landedPurges = purgedIds(merged);
    merged.destroy();
    for (const id of this.landedPurges) {
      if (isPurged(replica.workspace, id)) continue;
      this.options.log?.(`Note ${id} is already deleted for good: it stays deleted`);
      // A change of this writer's (its own log carries it), shown to the client like the
      // repository's changes, so the client's copy is marked again too.
      markPurged(replica.workspace, id, (this.options.clock ?? Date.now)());
      replica.showWorkspace();
    }
    // Where a landed purge's note was filed is only for Keep note, which a landed purge never
    // has (A855): the entry goes, in this writer's next commit.
    const from = replica.workspace.get(WORKSPACE_PURGED_FROM);
    const spent = [...this.landedPurges].filter((id) => from.hasAttr(id));
    if (spent.length > 0) {
      replica.workspace.transact(() => {
        for (const id of spent) from.deleteAttr(id);
      });
      replica.showWorkspace();
    }
  }

  /** Purged notes go before any of their logs are applied (G0's change 7). */
  private dropPurged(): void {
    this.purged = purgedIds(this.replica.workspace);
    for (const id of this.purged) if (this.replica.note(id)) this.replica.dropNoteFromGit(id);
  }

  /** Copies brought back after a store was cleared (A886): withheld, or dropped when empty. */
  private async holdBackCopies(): Promise<void> {
    const atHead = (id: string) => this.byDoc.has(id);
    this.keptCopies = pendingKeptCopies(this.replica, atHead);
    await withholdRaced(this.replica, this.options, {
      landed: this.landedPurges,
      purged: this.purged,
      atHead,
      kept: this.keptCopies,
    });
    this.unpushed = unpushedCopies(this.replica, atHead, this.purged);
    dropOrphans(this.replica, this.options.log, this.unpushed);
  }

  /**
   * Applies the notes' changed logs. A note at head this device has no copy of, not purged, is a
   * purge taken back before it landed (Keep note, A855): all of its logs are read, changed or not.
   */
  private async applyNoteLogs(noteLogs: ReadonlyArray<[string, string]>): Promise<void> {
    const { replica, purged, byDoc } = this;
    const back = new Set(
      [...byDoc.keys()].filter((id) => id !== '' && !purged.has(id) && !replica.note(id)),
    );
    const toApply = [
      ...noteLogs.filter(([, id]) => !purged.has(id) && !back.has(id)),
      ...[...back].flatMap((id) =>
        (byDoc.get(id) ?? []).map(([path]): [string, string] => [path, id]),
      ),
    ];
    if (this.head && toApply.length > 0) {
      const read = await this.readLogs(toApply.map(([path]) => path));
      for (const [path, id] of toApply) {
        const bytes = read.get(path);
        if (bytes) this.apply(replica.ensureNote(id), path, bytes);
      }
    }
    for (const [, id] of toApply) this.applied.add(id);
  }

  /**
   * A doc left with content Yjs could not apply gets every one of its files at head again
   * (A1148): @y/y rc.29 can drop a struct whose dependency came in a file applied after its own,
   * and the files at head hold every dependency, so this writer ends where the others do.
   */
  private async reapplyStuck(): Promise<void> {
    const { replica, purged, byDoc } = this;
    if (!this.head) return;
    const stuck = [
      ...(hasPending(replica.workspace) ? [''] : []),
      ...replica.noteIds().filter((id) => !purged.has(id) && hasPending(replica.note(id)!)),
    ].filter((id) => byDoc.has(id));
    if (stuck.length === 0) return;
    const paths = stuck.flatMap((id) => byDoc.get(id)!.map(([path]) => path));
    const read = await this.readLogs(paths);
    for (const id of stuck) {
      const doc = id === '' ? replica.workspace : replica.note(id)!;
      const again = () => {
        for (const [path] of byDoc.get(id)!) {
          const bytes = read.get(path);
          if (bytes) this.apply(doc, path, bytes);
        }
      };
      if (id === '') replica.workspace.transact(again, GIT_ORIGIN);
      else again();
      if (id !== '') this.applied.add(id);
    }
    if (stuck.includes('')) replica.showWorkspace();
  }

  /** A profile older than what it pushed writes as a new client id from now on (A821). */
  private moveOnIfBehind(): void {
    const { replica } = this;
    if (!this.behind || this.options.clientID !== undefined) return;
    const next = freshClientId(
      new Set([...replica.usedClientIds(), ...replica.state.ownClients]),
      this.context.random,
    );
    this.options.log?.(
      `This profile was older than what it had pushed: writing as client ${next} from now on`,
    );
    replica.setClientId(next);
  }

  /** `updated` (A823): this writer's key on the notes it changed, at most once per commit. */
  private stampChangedAt(): void {
    const { replica } = this;
    this.dirtyAt = new Map(Object.entries(replica.state.dirty));
    this.workspaceDirty = replica.state.workspaceDirty;
    const key = `${CHANGED_AT_PREFIX}${this.writer.id}`;
    for (const [id, at] of this.dirtyAt) {
      const doc = replica.note(id);
      if (!doc || this.purged.has(id)) continue;
      const meta = doc.get(NOTE_META);
      const current: unknown = meta.getAttr(key);
      if (typeof current !== 'number' || current < at) {
        doc.transact(() => meta.setAttr(key, at), ENGINE_ORIGIN);
      }
    }
  }

  /** The rendered files at head: their frontmatter ids (each blob read once), and whose they are. */
  private async readNamesAtHead(): Promise<void> {
    const { replica, layout, head, files } = this;
    this.renders = this.info.renderVersion <= RENDER_VERSION;
    const mdPaths = renderedPaths(layout, files);
    const unreadMd = mdPaths.filter((path) => replica.state.mdIds[files.get(path)!] === undefined);
    const readMd: ReadonlyMap<string, Uint8Array> =
      head && unreadMd.length > 0
        ? await this.context.blobs.read(this.git, head, files, unreadMd)
        : new Map();
    for (const path of mdPaths) {
      const blob = files.get(path)!;
      this.mdIds[blob] = replica.state.mdIds[blob] ?? frontmatterId(readMd.get(path)) ?? '';
    }
    this.foreign = foreignAt(
      replica,
      layout,
      files,
      (path) => this.mdIds[files.get(path)!] || null,
      this.purged,
    );
  }

  /** Other writers' actor files: no two writers may write with one client id (A821). */
  private checkOtherWriters(): void {
    const { replica } = this;
    for (const path of this.actorPaths) {
      if (path === this.layout.actor(this.writer.id)) continue;
      const bytes = this.firstRead?.get(path);
      if (!bytes || bytes.byteLength > MAX_ACTOR_BYTES) continue;
      for (const id of parseActor(bytes)?.clientIds ?? []) this.others.add(id);
    }
    if (this.others.has(replica.clientID) && this.options.clientID === undefined) {
      const used = new Set([
        ...this.others,
        ...replica.usedClientIds(),
        ...replica.state.ownClients,
      ]);
      const next = freshClientId(used, this.context.random);
      this.options.log?.(
        `Another writer uses client id ${replica.clientID}: writing as ${next} from now on`,
      );
      replica.setClientId(next);
    }
  }

  /**
   * Names (claimed in a fork of the WorkspaceDoc, joined only once the commit lands) and the
   * render set's files, unless a newer client owns the render (A823).
   */
  private async renderChanges(): Promise<void> {
    const { replica, layout, files, foreign, changes, touchedNotes } = this;
    this.claimsDoc = replica.workspace;
    if (!this.renders) return;
    // The claims' own client id, kept per writer: a new one only for a new writer, or when
    // another writer lists it; then one no doc and no writer has used (A821).
    let claimsId = replica.state.claimsClientId;
    if (claimsId === null || claimsId === replica.clientID || this.others.has(claimsId)) {
      claimsId = freshClientId(
        new Set([
          ...this.others,
          ...replica.usedClientIds(),
          ...replica.state.ownClients,
          replica.clientID,
        ]),
        this.context.random,
      );
      replica.update({ claimsClientId: claimsId });
    }
    this.claimsDoc = forkDoc(replica.workspace, claimsId);
    const named = namesAt(replica, layout, this.purged, foreign);
    this.claims =
      this.options.mutation === 'no-claims'
        ? 0
        : storeClaims(named, this.claimsDoc, ENGINE_ORIGIN, layout.root);
    const headPath = headPaths(foreign);
    const touched = new Set<string>();
    for (const path of this.changed) {
      const id = foreign.penmoss.get(path);
      if (id) touched.add(id);
    }
    const changedNotes = [...this.applied, ...this.dirtyAt.keys()];
    const all = this.everything || this.writeInfo;
    const set = all
      ? null
      : this.options.mutation === 'narrow-render'
        ? new Set(changedNotes)
        : renderSet({ named, notes: replica.notes, changed: changedNotes, headPath, touched });
    const own = set
      ? renderSet({ named, notes: replica.notes, changed: changedNotes, headPath })
      : new Set<string>();
    const wanted = new Set<string>();
    for (const [id, path] of named.paths) {
      if (set && !set.has(id) && headPath.get(id) === path) {
        wanted.add(path);
        continue;
      }
      const markdown = renderNoteFile(replica.note(id)!, id, path, named, layout.root);
      if (markdown === null) {
        // A body from a newer Penmoss (A1493): its file at head stays as it is, where it is,
        // and none is written for it, never one rendered from the part this build can read.
        const atHead = headPath.get(id);
        if (atHead !== undefined) wanted.add(atHead);
        this.skipped.set(atHead ?? path, UNSUPPORTED_RENDER);
        continue;
      }
      wanted.add(path);
      const bytes = new TextEncoder().encode(markdown);
      const blob = files.get(path);
      if (blob !== undefined && blob === (await gitBlobSha(bytes))) continue;
      changes.set(path, bytes);
      touchedNotes.add(id);
      if (!all && touched.has(id) && !own.has(id) && headPath.get(id) === path) {
        this.handEdits.push(path.slice(layout.root.length));
      }
    }
    // Penmoss's files no longer wanted: moved, in Trash, purged. Nothing else is removed.
    for (const [path, id] of foreign.penmoss) {
      if (!wanted.has(path)) {
        changes.set(path, null);
        touchedNotes.add(id);
      }
    }
  }

  /** This writer's own files (A821), recomputed from content ids; a purged note's files go. */
  private async ownFileChanges(): Promise<void> {
    const { replica, layout, writer, purged, byDoc, changes, touchedNotes } = this;
    const candidates =
      this.context.full || this.everything
        ? new Set(replica.noteIds())
        : new Set([...this.applied, ...this.dirtyAt.keys()]);
    // A copy not on the branch yet is always written with its entry (A886).
    const firstPushes = this.unpushed.filter((id) => !contentless(replica, id));
    for (const id of firstPushes) candidates.add(id);
    const ownPath = (docKey: string) =>
      docKey === '' ? layout.workspace(writer.id) : layout.note(docKey, writer.id);
    const docKeys = [
      '',
      ...[...candidates].filter((id) => replica.note(id) && !purged.has(id)).sort(),
    ];
    const needed = new Set<string>();
    for (const docKey of docKeys) for (const [path] of byDoc.get(docKey) ?? []) needed.add(path);
    const parts = this.head ? await this.readLogs(needed) : new Map<string, Uint8Array>();
    // A log of this writer's own that it cannot read (too large, or not a Yjs update) is never
    // written over: what it holds would be lost, and main refuses a log replaced with less. The
    // writer retires instead, and the new one writes its own log beside it.
    for (const docKey of docKeys) {
      const doc = docKey === '' ? this.claimsDoc : replica.note(docKey)!;
      const logs = byDoc.get(docKey) ?? [];
      const mine = logs.find(([, w]) => w === writer.id);
      if (mine && !parts.has(mine[0])) {
        this.ownLogUnread = true;
        continue;
      }
      const next = ownFile(
        Y.encodeStateAsUpdate(doc),
        logs.map(([path]) => parts.get(path)).filter((bytes): bytes is Uint8Array => !!bytes),
        mine ? (parts.get(mine[0]) ?? null) : null,
      );
      if (next) {
        changes.set(ownPath(docKey), next);
        if (docKey !== '') touchedNotes.add(docKey);
      }
    }
    // A purged note's logs and file go, whoever wrote them (the one exception, A828).
    for (const id of purged) {
      for (const [path] of byDoc.get(id) ?? []) changes.set(path, null);
    }
    const unwritten = firstPushes.filter((id) => !changes.has(ownPath(id)));
    if (unwritten.length > 0 && !this.ownLogUnread) {
      throw new NotebookError(
        'copy_unwritten',
        'A note brought back after the store was cleared could not be written, so nothing was pushed; your changes are kept.',
      );
    }
  }

  /** Attachments the notes use that the branch lacks, from this device's store. */
  private async attachmentChanges(): Promise<void> {
    const { files, changes } = this;
    for (const id of this.touchedNotes) {
      const doc = this.replica.note(id);
      if (!doc) continue;
      for (const file of attachmentFiles(noteBodyForDisplay(doc))) {
        const path = this.layout.attachment(`${file.sha256}.${file.ext}`);
        if (files.has(path) || changes.has(path)) continue;
        const bytes = await this.options.storage.readAttachment(`${file.sha256}.${file.ext}`);
        if (bytes) changes.set(path, bytes);
      }
    }
  }

  /**
   * The actor file (A829), retiring a full writer (A850), notebook.json, and what this writer
   * could not read, kept while the file is unchanged so Status shows it.
   */
  private actorAndInfo(): void {
    const { replica, writer, changes, skipped } = this;
    const actorPath = this.layout.actor(writer.id);
    const ownActor = this.firstRead?.get(actorPath);
    const maxActor = this.options.maxActorBytes ?? MAX_ACTOR_BYTES;
    const actorAtHead: ActorFile | null =
      ownActor && ownActor.byteLength <= maxActor ? parseActor(ownActor) : null;
    this.ownClients = new Set(replica.state.ownClients);
    if (this.claims > 0) this.ownClients.add(this.claimsDoc.clientID);
    const stillSkipped: Record<string, string> = {};
    for (const [path, why] of Object.entries(replica.state.skipped)) {
      if (this.files.has(path) && !this.changed.has(path)) stillSkipped[path] = why;
    }
    for (const [path, why] of skipped) stillSkipped[path] = why;
    for (const [path, why] of skipped) {
      if (replica.state.skipped[path] !== why) this.options.log?.(`Skipped ${path}: ${why}`);
    }
    const headFull = (ownActor?.byteLength ?? 0) > maxActor;
    const actor = actorFile(writer, actorAtHead, this.ownClients);
    if (this.ownLogUnread || headFull || (actor && actor.bytes.byteLength > maxActor)) {
      if (this.ownLogUnread || headFull || this.ownClients.size > 1) {
        // Retire it: the new writer lists what this one never pushed. A file at head too large
        // for other clients is still read here, up to the log limit, to tell what it lists; past
        // that, all of it is carried, or only this process's id if even that would not fit.
        const listed =
          actorAtHead ??
          (ownActor && ownActor.byteLength <= (this.options.maxLogBytes ?? MAX_LOG_BYTES)
            ? parseActor(ownActor)
            : null);
        const atHead = new Set(listed?.clientIds ?? []);
        const unpushed = [...this.ownClients].filter((id) => !atHead.has(id));
        const carried = actorFile(writer, null, new Set(unpushed));
        throw new WriterFull(
          carried && carried.bytes.byteLength <= maxActor ? unpushed : [replica.clientID],
        );
      }
      throw new NotebookError(
        'actor_full',
        `Even a new writer's actor file would pass ${maxActor / 1024 / 1024} MB. Nothing was pushed; your changes are kept.`,
      );
    }
    if (actor) changes.set(actorPath, actor.bytes);
    if (this.writeInfo) changes.set(this.layout.notebook, encodeNotebookInfo(this.info));
    this.stillSkipped = stillSkipped;
  }

  private stillSkipped: Record<string, string> = {};

  /** Bookkeeping: frontmatter ids of the files at head (and of what this commit writes). */
  private async recordMdIds(): Promise<void> {
    const nextMdIds: Record<string, string> = { ...this.mdIds };
    for (const [path, bytes] of this.changes) {
      if (bytes && path.endsWith('.md'))
        nextMdIds[await gitBlobSha(bytes)] = frontmatterId(bytes) ?? '';
    }
    this.replica.update({ mdIds: nextMdIds, skipped: this.stillSkipped });
  }

  /** The commit on top of the head, or nothing to commit (an actor file alone waits). */
  private async commitBuilt(): Promise<Built> {
    const { replica, writer, changes, head, claimsDoc } = this;
    const actorPath = this.layout.actor(writer.id);
    const onlyActor = [...changes.keys()].every((path) => path === actorPath);
    const claims = this.claims;
    const ownClients = this.ownClients;
    const landed = () => {
      if (claims === 0) return;
      Y.applyUpdate(
        replica.workspace,
        Y.encodeStateAsUpdate(claimsDoc, Y.encodeStateVector(replica.workspace)),
        ENGINE_ORIGIN,
      );
      replica.update({ ownClients: [...ownClients].sort((a, b) => a - b) });
    };
    const base = {
      head,
      handEdits: this.handEdits,
      foreign: this.foreign.paths,
      copies: this.foreign.copies,
      renderSkipped: !this.renders,
      dirtyAt: this.dirtyAt,
      workspaceDirty: this.workspaceDirty,
      info: this.info,
      notes: this.touchedNotes.size,
    };
    // An actor file alone waits for the next commit with content in it: a device that only
    // reads never commits.
    if (changes.size === 0 || onlyActor) {
      if (claimsDoc !== replica.workspace) claimsDoc.destroy();
      return { ...base, commit: null, landed: () => undefined };
    }
    // An agent's clone (the CLI's `--agent`, `penmoss mcp`) never commits an undo mark: only a
    // person's writer marks an agent's change undone (#174 merge check). Agent activity believes
    // a mark only when nothing is left to undo; this is defence in depth, where agents commit.
    if (writer.kind === 'agent') {
      const { undoneMarks } = await commitPurges(this.git, this.layout.root, head, changes);
      if (undoneMarks.length > 0) {
        // As a commit main refuses: the error goes up, and the sync stops.
        throw new GitTransportError(
          'refused',
          'Sync stopped: this agent clone would mark an agent’s change undone, but only a person marks an agent’s change undone, so nothing was committed.',
        );
      }
    }
    let commit: string | null;
    try {
      commit = await this.git.commit(head, changes, commitMessage(this.touchedNotes.size, writer));
    } catch (error) {
      // Main refused a copy whose original is deleted for good (A886): a Keep and sync whose
      // confirmation ran out. The copy is withheld again at the next sync, for the person.
      if (
        error instanceof GitRefused &&
        error.code === 'purge_raced' &&
        this.keptCopies.length > 0
      ) {
        replica.update({ keptCopies: [] });
      }
      throw error;
    }
    if (commit === null) {
      if (claimsDoc !== replica.workspace) claimsDoc.destroy();
      return { ...base, commit: null, landed: () => undefined };
    }
    return {
      ...base,
      commit,
      landed: () => {
        landed();
        if (claimsDoc !== replica.workspace) claimsDoc.destroy();
      },
    };
  }
}
