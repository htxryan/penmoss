/**
 * The personal workspace into one git notebook (T56, D48; A1020–A1025). Before the Penmoss server
 * goes, every note of the workspace moves into a git notebook made for it: one notebook with the
 * workspace's folders, note and folder ids kept (so wikilinks, embeds, backlinks, Quick Access and
 * agents' references still resolve), its history flattened into one import commit.
 *
 * - `importPersonal` writes what the server gave (`PersonalWorkspace`) into a new notebook's
 *   engine, as one writer's local change; the next sync commits it all at once (A1020).
 * - `dryRunPersonal` does the same into a repository in memory and reports what the commit would
 *   hold, writing nothing anywhere.
 * - `openAtHead` and `verifyPersonal` read the notebook back from its branch, through the engine
 *   with a transport that never commits, and compare each note with the server (A1024).
 *
 * Platform-free: the CLI reads the server and runs git (`penmoss export-personal`).
 */
import { attachmentFiles, noteBody } from '@penmoss/editor/markdown';
import { effectiveParents, folderPath, type FolderRecord } from '@penmoss/core/workspace';
import { GIT_MAX_ATTACHMENT_BYTES } from '@penmoss/core/attachments';
import {
  locateThreads,
  NOTE_COMMENTS,
  readThreads,
  type ThreadData,
} from '@penmoss/sync-client/comments';
import { isDeleted, readTrashInfo } from '@penmoss/sync-client/note';
import { decodeMessage, encodeMessage } from '@penmoss/sync-client/protocol';
import {
  defaultNotebookName,
  endPosition,
  readSettings,
  readWorkspace,
  WORKSPACE_FOLDER_TRASH,
  WORKSPACE_FOLDERS,
  WORKSPACE_NOTES,
  WORKSPACE_ROOT,
  WORKSPACE_SETTINGS,
} from '@penmoss/sync-client/workspace';
import * as Y from '@y/y';
import { GitNotebookEngine, type SyncReport } from './engine';
import { Layout } from './layout';
import { LocalNotebook, LocalError, type LocalNoteContent } from './local/notebook';
import { MemoryRemote, MemoryTransport } from './memory';
import { NotebookOps, NOTEBOOK_SETTINGS } from './ops';
import { MemoryStorage } from './replica';
import type { GitTransport } from './transport';
import { MemorySecrets } from './writer';
import { freshClientId } from './yjs';

/** A binary WebSocket, as the CLI opens one (`Io.socket`). */
export interface WorkspaceSocket {
  send(bytes: Uint8Array): void;
  close(): void;
  onMessage(listener: (bytes: Uint8Array) => void): void;
  onClose(listener: (code: number, reason: string) => void): void;
}

/**
 * The WorkspaceDoc's whole state over its sync socket (`/sync/workspace`): this side asks with an
 * empty state vector and takes the server's answer, sending nothing else (A1020). Read-only by
 * construction: no update ever leaves.
 */
export function workspaceOverSocket(
  socket: WorkspaceSocket,
  timeoutMs = 60_000,
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`the WorkspaceDoc did not answer within ${timeoutMs / 1000} s`));
    }, timeoutMs);
    let done = false;
    socket.onMessage((bytes) => {
      if (done) return;
      let message;
      try {
        message = decodeMessage(bytes);
      } catch {
        return;
      }
      if (message.type !== 'sync-step2') return;
      done = true;
      clearTimeout(timer);
      socket.close();
      resolve(message.update);
    });
    socket.onClose((code, reason) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(
        new Error(`the WorkspaceDoc closed the connection (${code}${reason ? `: ${reason}` : ''})`),
      );
    });
    socket.send(
      encodeMessage({ type: 'sync-step1', stateVector: Y.encodeStateVector(new Y.Doc()) }),
    );
  });
}

/** One note as the server holds it. */
export interface PersonalNote {
  readonly id: string;
  /** Its whole Yjs state (`/sync/batch` with no state vector). */
  readonly update: Uint8Array;
  /** When it last changed (the index's `updatedAt`, epoch ms): its `updated` (A1020). */
  readonly updatedAt: number;
}

/** An attachment the notes use, as the export found it (A1022). */
export type PersonalAttachment =
  | { readonly kind: 'bytes'; readonly bytes: Uint8Array }
  /** Over the git notebook's 10 MB cap (A213, A828): listed for the person, never written. */
  | { readonly kind: 'too_large'; readonly bytes: number }
  /** The server has no such file (it answered 404). */
  | { readonly kind: 'missing' };

/** What the server gave of the personal workspace. */
export interface PersonalWorkspace {
  /** The account's user id: its settings are `<userId>/<key>` in the WorkspaceDoc. */
  readonly userId: string;
  /** The WorkspaceDoc's whole Yjs state (`/sync/workspace`). */
  readonly workspace: Uint8Array;
  /** Every note that is not deleted for good, in Trash or not. */
  readonly notes: readonly PersonalNote[];
  /** By file (`<sha256>.<ext>`), every attachment `personalAttachments` lists. */
  readonly attachments: ReadonlyMap<string, PersonalAttachment>;
}

/** The git notebook's writer for the import: History names every imported edit by it (A1020). */
export const IMPORT_WRITER = { kind: 'device', label: 'Personal workspace import' } as const;

/** The salt the imported notebook keeps (A1021): none, so its derived ids are the workspace's. */
export const IMPORT_SALT = '';

/** A setting that is the notebook's own in a git notebook (A827), not the device's. */
export function isNotebookSetting(key: string): boolean {
  return key === 'timeZone' || key.startsWith('template.');
}

/** Where a git notebook keeps the device's settings (A827): what the apps read with the Journal. */
export const DEVICE_SETTINGS = 'device';

/** The attachments a note's body uses (`<sha256>.<ext>`), as the engine commits them. */
export function noteAttachments(update: Uint8Array): string[] {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, update);
    return attachmentFiles(noteBody(doc)).map((file) => `${file.sha256}.${file.ext}`);
  } finally {
    doc.destroy();
  }
}

/** The workspace's default notebook's name (T43, A751): the imported notebook's own. */
export function personalNotebookName(workspace: Uint8Array): string {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, workspace);
    return defaultNotebookName(readWorkspace(doc));
  } finally {
    doc.destroy();
  }
}

/** The ids of the notes a WorkspaceDoc state files (its registry). */
export function registryIds(workspace: Uint8Array): string[] {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, workspace);
    return readWorkspace(doc).notes.map((entry) => entry.id);
  } finally {
    doc.destroy();
  }
}

/** Every attachment the notes use, with the notes that use it (the export fetches each once). */
export function personalAttachments(
  notes: readonly Pick<PersonalNote, 'id' | 'update'>[],
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const note of notes) {
    for (const file of noteAttachments(note.update)) {
      const users = out.get(file) ?? [];
      users.push(note.id);
      out.set(file, users);
    }
  }
  return new Map([...out].sort(([a], [b]) => (a < b ? -1 : 1)));
}

/** What an import wrote, and what it could not, for the person (A1022, A1023). */
export interface ImportReport {
  readonly notes: number;
  readonly inTrash: number;
  readonly folders: number;
  /** Deleted folders kept for Restore (A560), copied as they are. */
  readonly folderTrash: number;
  /** Settings by where they went (A827): the notebook's own, and the device's. */
  readonly settings: { readonly notebook: number; readonly device: number };
  /** Symbols defined (`symbols.list`) and notes in Quick Access (`quickAccess.notes`). */
  readonly symbols: number;
  readonly quickAccess: number;
  /** Notes the registry did not file (in Trash, or never filed): filed now, by id. */
  readonly filed: readonly string[];
  /** Registry entries with no note behind them: left out. */
  readonly unknownEntries: readonly string[];
  /** Notes with no content at all: left out. */
  readonly empty: readonly string[];
  /** Folders that were notebooks, now plain folders of the one notebook (A1023). */
  readonly notebooksFlattened: readonly string[];
  /** Comment threads sent to an agent session, whose sending is dropped (A1023). */
  readonly sendingDropped: number;
  /** Settings of other users of the workspace, by user id: not copied. */
  readonly otherUsers: Readonly<Record<string, number>>;
  readonly attachments: {
    readonly written: number;
    readonly bytes: number;
    /** Over the 10 MB cap, with the notes that use each: never written (A1022). */
    readonly tooLarge: ReadonlyArray<{
      readonly file: string;
      readonly bytes: number;
      readonly notes: readonly string[];
    }>;
    /** Not on the server. */
    readonly missing: ReadonlyArray<{ readonly file: string; readonly notes: readonly string[] }>;
  };
  /** The Yjs client ids the import writer's actor file lists (A829, A850). */
  readonly clientIds: number;
}

export class PersonalImportError extends Error {
  constructor(
    readonly code: 'not_empty' | 'no_notebook',
    message: string,
  ) {
    super(message);
    this.name = 'PersonalImportError';
  }
}

/** A Y attribute's value as plain data, or undefined for a nested type (never in these maps). */
function plain(value: unknown): unknown {
  return value instanceof Y.Node || value instanceof Y.Doc ? undefined : value;
}

/** Copies a map's entries (`folders`, `notes`, `folderTrash`) node by node, minus `drop` attrs. */
function copyEntries(
  from: Y.Doc,
  to: Y.Doc,
  root: string,
  drop: ReadonlySet<string>,
  keep: (id: string) => boolean = () => true,
): number {
  let copied = 0;
  for (const [key, value] of from.get(root).attrEntries()) {
    const id = String(key);
    if (!(value instanceof Y.Node) || !keep(id)) continue;
    const node = new Y.Node();
    to.get(root).setAttr(id, node);
    for (const [name, attr] of value.attrEntries()) {
      const field = String(name);
      const data = plain(attr);
      if (drop.has(field) || data === undefined) continue;
      node.setAttr(field, data);
    }
    copied++;
  }
  return copied;
}

/**
 * Writes the personal workspace into `engine`, a new notebook with no notes yet (A1020): every
 * note's own Yjs state as it is (so comment anchors, which are positions in it, still resolve),
 * a WorkspaceDoc made of the workspace's tree, the account's settings in the notebook's maps
 * (A827), and the attachments under the cap into the engine's store. Nothing is pushed: the
 * caller's next sync commits it all, in one commit. Each note's `updated` stays the server's.
 */
export async function importPersonal(
  engine: GitNotebookEngine,
  source: PersonalWorkspace,
): Promise<ImportReport> {
  const replica = engine.replica;
  if (!engine.info) throw new PersonalImportError('no_notebook', 'The notebook is not made yet.');
  if (replica.noteIds().length > 0 || readWorkspace(replica.workspace).folders.length > 0) {
    throw new PersonalImportError(
      'not_empty',
      'This notebook holds notes already: the personal workspace goes only into a new one.',
    );
  }
  const server = new Y.Doc();
  Y.applyUpdate(server, source.workspace);
  const tree = readWorkspace(server);
  const folderIds = new Set(tree.folders.map((folder) => folder.id));
  const filedIds = new Set(tree.notes.map((entry) => entry.id));

  // 1. The notes, each its own state as the server holds it (A1020).
  const empty: string[] = [];
  const kept = new Map<string, PersonalNote>();
  for (const note of source.notes) {
    const probe = new Y.Doc();
    Y.applyUpdate(probe, note.update);
    const hasContent = Y.encodeStateVector(probe).byteLength > 1;
    probe.destroy();
    if (!hasContent) {
      empty.push(note.id);
      continue;
    }
    replica.adopt(note.id, note.update);
    kept.set(note.id, note);
  }
  // The writer's own client id must be one no imported doc holds (A821, A850).
  const used = replica.usedClientIds();
  if (used.has(replica.clientID)) {
    replica.setClientId(freshClientId(new Set([...used, ...replica.state.ownClients])));
  }

  // 2. Sending to agent sessions is the server's (A774, A908): dropped, the threads kept.
  let sendingDropped = 0;
  for (const id of kept.keys()) {
    const doc = replica.note(id)!;
    const threads = [...doc.get(NOTE_COMMENTS).attrEntries()].filter(
      ([, node]) => node instanceof Y.Node && (node.hasAttr('target') || node.hasAttr('delivery')),
    );
    if (threads.length === 0) continue;
    doc.transact(() => {
      for (const [, node] of threads) {
        const thread = node as Y.Node;
        if (thread.hasAttr('target')) thread.deleteAttr('target');
        if (thread.hasAttr('delivery')) thread.deleteAttr('delivery');
        sendingDropped++;
      }
    });
  }

  // 3. The tree: folders, registry, top level and deleted folders, as the workspace has them,
  // without what is the server's alone: notebook flags (one notebook now, A1023), the default
  // notebook's name, and the mirror's paths (A10). Settings move to the notebook's maps (A827).
  const notebooksFlattened = tree.folders.filter((folder) => folder.notebook).map((f) => f.id);
  const filed: string[] = [];
  const unknownEntries = tree.notes.filter((entry) => !kept.has(entry.id)).map((e) => e.id);
  const settingsCount = { notebook: 0, device: 0 };
  const otherUsers: Record<string, number> = {};
  const workspace = replica.workspace;
  workspace.transact(() => {
    copyEntries(server, workspace, WORKSPACE_FOLDERS, new Set(['notebook']));
    copyEntries(server, workspace, WORKSPACE_NOTES, new Set(['path']), (id) => kept.has(id));
    copyEntries(server, workspace, WORKSPACE_FOLDER_TRASH, new Set());
    const root = server.get(WORKSPACE_ROOT);
    for (const [name, value] of root.attrEntries()) {
      const data = plain(value);
      if (String(name) === 'notebookName' || data === undefined) continue;
      workspace.get(WORKSPACE_ROOT).setAttr(String(name), data);
    }
    const prefix = `${source.userId}/`;
    for (const [name, value] of server.get(WORKSPACE_SETTINGS).attrEntries()) {
      const key = String(name);
      const data = plain(value);
      if (data === undefined) continue;
      if (!key.startsWith(prefix)) {
        const user = key.slice(0, Math.max(0, key.indexOf('/'))) || key;
        otherUsers[user] = (otherUsers[user] ?? 0) + 1;
        continue;
      }
      const setting = key.slice(prefix.length);
      const map = isNotebookSetting(setting) ? NOTEBOOK_SETTINGS : DEVICE_SETTINGS;
      workspace.get(WORKSPACE_SETTINGS).setAttr(`${map}/${setting}`, data);
      settingsCount[map === NOTEBOOK_SETTINGS ? 'notebook' : 'device']++;
    }
    // Every note the registry does not file: a note in Trash (the server takes it out of the
    // tree, a git notebook keeps it there, A566) goes back where it was deleted from, else the top
    // level, where the server files notes it finds unfiled (registerMissing).
    for (const id of [...kept.keys()].sort()) {
      if (filedIds.has(id)) continue;
      const doc = replica.note(id)!;
      const from = isDeleted(doc) ? (readTrashInfo(doc).folderId ?? null) : null;
      const folderId = from !== null && folderIds.has(from) ? from : null;
      const node = new Y.Node();
      workspace.get(WORKSPACE_NOTES).setAttr(id, node);
      node.setAttr('folder', folderId);
      node.setAttr('position', endPosition(workspace, folderId, 'notes'));
      filed.push(id);
    }
  });

  // 4. Attachments under the cap into the store: the sync commits those the notes use (A828).
  const users = personalAttachments([...kept.values()]);
  let written = 0;
  let bytes = 0;
  const tooLarge: Array<{ file: string; bytes: number; notes: string[] }> = [];
  const missing: Array<{ file: string; notes: string[] }> = [];
  for (const [file, notes] of users) {
    const found = source.attachments.get(file) ?? { kind: 'missing' as const };
    if (found.kind === 'bytes' && found.bytes.byteLength > GIT_MAX_ATTACHMENT_BYTES) {
      tooLarge.push({ file, bytes: found.bytes.byteLength, notes });
    } else if (found.kind === 'bytes') {
      await engine.storage.writeAttachment(file, found.bytes);
      written++;
      bytes += found.bytes.byteLength;
    } else if (found.kind === 'too_large') {
      tooLarge.push({ file, bytes: found.bytes, notes });
    } else {
      missing.push({ file, notes });
    }
  }

  // 5. Each note's `updated` is the server's (A823's stamp, made at the sync with this time).
  const dirty: Record<string, number> = {};
  for (const [id, note] of kept) dirty[id] = Math.max(1, note.updatedAt);
  replica.update({ dirty });

  const settings = readSettings(server, source.userId);
  const symbols = settings['symbols.list'];
  const quickAccess = settings['quickAccess.notes'];
  server.destroy();
  return {
    notes: kept.size,
    inTrash: [...kept.keys()].filter((id) => isDeleted(replica.note(id)!)).length,
    folders: tree.folders.length,
    folderTrash: [...workspace.get(WORKSPACE_FOLDER_TRASH).attrKeys()].length,
    settings: settingsCount,
    symbols: Array.isArray(symbols) ? symbols.length : 0,
    quickAccess: Array.isArray(quickAccess) ? quickAccess.length : 0,
    filed,
    unknownEntries,
    empty,
    notebooksFlattened,
    sendingDropped,
    otherUsers,
    attachments: { written, bytes, tooLarge, missing },
    clientIds: replica.state.ownClients.length,
  };
}

/** What a dry run would commit (A1020): the files by kind and the commit's subject. */
export interface DryRunReport {
  readonly report: ImportReport;
  readonly commit: { readonly subject: string; readonly files: number; readonly bytes: number };
  readonly files: {
    readonly logs: number;
    readonly rendered: number;
    readonly attachments: number;
    readonly other: number;
  };
  /** The rendered markdown files (paths in the repository), sorted. */
  readonly paths: readonly string[];
}

/**
 * The import into a repository in memory (A1020): exactly what `importPersonal` and the next sync
 * would commit, with nothing written to disk, git or the server.
 */
export async function dryRunPersonal(
  source: PersonalWorkspace,
  notebook: { readonly name: string; readonly dir?: string },
): Promise<DryRunReport> {
  const remote = new MemoryRemote();
  const root = notebook.dir ? `${notebook.dir.replace(/\/+$/, '')}/` : '';
  const transport = new MemoryTransport({ remote, branch: 'main', root });
  const engine = await GitNotebookEngine.open({
    transport,
    storage: new MemoryStorage(),
    secrets: new MemorySecrets(),
    writer: IMPORT_WRITER,
    create: { name: notebook.name, salt: IMPORT_SALT },
  });
  const report = await importPersonal(engine, source);
  const sync: SyncReport = await engine.sync();
  engine.replica.destroy();
  const head = sync.commit ? remote.commits.get(sync.commit) : undefined;
  const layout = new Layout(root);
  const counts = { logs: 0, rendered: 0, attachments: 0, other: 0 };
  const paths: string[] = [];
  let bytes = 0;
  for (const [path, blob] of head?.tree ?? []) {
    bytes += remote.blobs.get(blob)?.byteLength ?? 0;
    if (path.startsWith(layout.base)) counts.logs++;
    else if (path.startsWith(`${root}attachments/`)) counts.attachments++;
    else if (path.endsWith('.md')) {
      counts.rendered++;
      paths.push(path);
    } else counts.other++;
  }
  return {
    report,
    commit: {
      subject: head?.message.split('\n')[0] ?? '',
      files: head?.tree.size ?? 0,
      bytes,
    },
    files: counts,
    paths: paths.sort(),
  };
}

// --- reading the notebook back (A1024) ---

/** A notebook as its branch holds it, read through the engine without committing anything. */
export interface NotebookAtHead {
  readonly head: string | null;
  readonly notebook: LocalNotebook;
  /** An attachment's bytes at head, or null when the branch has none. */
  attachment(file: string): Promise<Uint8Array | null>;
  /** Files the engine would have written over head: rendered differently than Penmoss renders. */
  readonly unrendered: readonly string[];
  close(): void;
}

/**
 * A transport over `inner` that never writes: a commit is noted and not made, and nothing is
 * pushed. The engine reading through it sees the branch as it is.
 */
class ReadOnlyTransport implements GitTransport {
  readonly wouldWrite = new Set<string>();
  readonly sizes?: NonNullable<GitTransport['sizes']>;
  constructor(private readonly inner: GitTransport) {
    if (inner.sizes) this.sizes = (head, paths) => inner.sizes!(head, paths);
  }
  get root() {
    return this.inner.root;
  }
  fetch() {
    return this.inner.fetch();
  }
  list(head: string) {
    return this.inner.list(head);
  }
  changed(from: string, to: string) {
    return this.inner.changed(from, to);
  }
  read(head: string, paths: readonly string[]) {
    return this.inner.read(head, paths);
  }
  commit(_head: string | null, changes: ReadonlyMap<string, Uint8Array | null>) {
    for (const path of changes.keys()) this.wouldWrite.add(path);
    return Promise.resolve(null);
  }
  push(): Promise<'rejected'> {
    return Promise.reject(new Error('Reading a notebook never pushes'));
  }
  log(options?: { readonly paths?: readonly string[]; readonly limit?: number }) {
    return this.inner.log(options);
  }
  readAt(commit: string, path: string) {
    return this.inner.readAt(commit, path);
  }
}

/** Opens the notebook at `transport`'s branch head, read-only, in memory (A1024). */
export async function openAtHead(transport: GitTransport): Promise<NotebookAtHead> {
  const readOnly = new ReadOnlyTransport(transport);
  const engine = await GitNotebookEngine.open({
    transport: readOnly,
    storage: new MemoryStorage(),
    secrets: new MemorySecrets(),
    writer: { kind: 'device', label: 'Personal workspace check' },
  });
  const report = await engine.sync();
  const layout = new Layout(transport.root);
  return {
    head: report.head,
    notebook: new LocalNotebook(new NotebookOps(engine)),
    async attachment(file) {
      if (!report.head) return null;
      const path = layout.attachment(file);
      return (await transport.read(report.head, [path])).get(path) ?? null;
    },
    unrendered: [...readOnly.wouldWrite].sort(),
    close: () => engine.replica.destroy(),
  };
}

// --- the comparison (A1024) ---

/** A note as the server shows it, for the check. */
export interface ServerNote {
  readonly id: string;
  /** Its Yjs state, read again for the check. */
  readonly update: Uint8Array;
  /** `GET /api/notes/:id/content`: what an agent reads; null when the server has none. */
  readonly content: Pick<
    LocalNoteContent,
    'title' | 'tags' | 'markdown' | 'body' | 'deleted'
  > | null;
}

/** The server's side of the check. */
export interface ServerSide {
  readonly userId: string;
  readonly workspace: Uint8Array;
  readonly notes: readonly ServerNote[];
  /** Each attachment's SHA-256 of the bytes the server serves, else `too_large` or `missing`. */
  readonly attachments: ReadonlyMap<string, string>;
}

/** One difference between the server and the notebook. */
export interface Difference {
  /** The note (or folder) it is about; null for the workspace's settings. */
  readonly id: string | null;
  readonly field:
    | 'note'
    | 'title'
    | 'tags'
    | 'markdown'
    | 'body'
    | 'trash'
    | 'folder'
    | 'comments'
    | 'attachment'
    | 'folders'
    | 'settings'
    | 'render';
  readonly server: unknown;
  readonly notebook: unknown;
}

export interface VerifyReport {
  readonly notes: number;
  readonly attachments: number;
  readonly differences: readonly Difference[];
  /** Attachments over the cap: listed at the import, never in the notebook (A1022). */
  readonly tooLarge: readonly string[];
}

/** A thread as the check compares it: what it says and where it is now, not who it was sent to. */
function comparableThreads(doc: Y.Doc): unknown[] {
  const threads: ThreadData[] = [...readThreads(doc)].sort((a, b) => (a.id < b.id ? -1 : 1));
  const places = locateThreads(doc, threads);
  return threads.map((thread, index) => {
    // Not where it was sent (the server's, A1023), nor its anchor's ids: where it is now.
    const kept: Record<string, unknown> = { ...thread };
    delete kept['target'];
    delete kept['delivery'];
    delete kept['anchor'];
    const place = places[index]!;
    return { ...kept, place: { found: place.found, text: place.text } };
  });
}

const docOf = (update: Uint8Array): Y.Doc => {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, update);
  return doc;
};

/** Where the server shows a note (A17's effective parents), or where Restore puts one in Trash. */
function serverFolder(
  doc: Y.Doc,
  id: string,
  registry: ReadonlyMap<string, string | null>,
  parents: ReadonlyMap<string, string | null>,
): string | null {
  const filed = registry.has(id)
    ? registry.get(id)!
    : isDeleted(doc)
      ? (readTrashInfo(doc).folderId ?? null)
      : null;
  return filed !== null && parents.has(filed) ? filed : null;
}

/** A folder's place as names, `Work/Plans`, for the report. */
function placeName(folders: readonly FolderRecord[], id: string | null): string {
  return id === null ? '' : (folderPath(folders, id) ?? id);
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Compares every note of the server with the notebook at head (A1024): its markdown as agents
 * read it (title, tags, body and frontmatter), Trash, folder, comment threads and the hash of
 * every attachment, then the folders and the account's settings. An empty `differences` is the
 * check passing.
 */
export async function verifyPersonal(
  server: ServerSide,
  notebook: NotebookAtHead,
): Promise<VerifyReport> {
  const differences: Difference[] = [];
  const add = (difference: Difference) => differences.push(difference);
  const local = notebook.notebook;
  const ops = local.ops;

  const serverDoc = docOf(server.workspace);
  const serverTree = readWorkspace(serverDoc);
  const serverParents = effectiveParents(serverTree.folders);
  const serverRegistry = new Map(serverTree.notes.map((entry) => [entry.id, entry.folderId]));
  const gitTree = readWorkspace(ops.workspace);
  const gitParents = effectiveParents(gitTree.folders);
  const gitRegistry = new Map(gitTree.notes.map((entry) => [entry.id, entry.folderId]));

  // Folders: the same ids, names and places.
  const folderView = (folders: readonly FolderRecord[], parents: Map<string, string | null>) =>
    folders
      .map((folder) => ({ id: folder.id, name: folder.name, parentId: parents.get(folder.id) }))
      .sort((a, b) => (a.id < b.id ? -1 : 1));
  const serverFolders = folderView(serverTree.folders, serverParents);
  const gitFolders = folderView(gitTree.folders, gitParents);
  if (!same(serverFolders, gitFolders)) {
    const ids = new Set([...serverFolders, ...gitFolders].map((folder) => folder.id));
    for (const id of [...ids].sort()) {
      const a = serverFolders.find((folder) => folder.id === id) ?? null;
      const b = gitFolders.find((folder) => folder.id === id) ?? null;
      if (!same(a, b)) add({ id, field: 'folders', server: a, notebook: b });
    }
  }

  // The account's settings, symbols and Quick Access, as the apps read them in the notebook.
  const serverSettings = readSettings(serverDoc, server.userId);
  const device = readSettings(ops.workspace, DEVICE_SETTINGS);
  const own = readSettings(ops.workspace, NOTEBOOK_SETTINGS);
  const gitSettings: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(device)) {
    if (!isNotebookSetting(key)) gitSettings[key] = value;
  }
  for (const [key, value] of Object.entries(own)) {
    if (isNotebookSetting(key)) gitSettings[key] = value;
  }
  for (const key of [...new Set([...Object.keys(serverSettings), ...Object.keys(gitSettings)])]) {
    if (!same(serverSettings[key], gitSettings[key])) {
      add({
        id: null,
        field: 'settings',
        server: { [key]: serverSettings[key] },
        notebook: { [key]: gitSettings[key] },
      });
    }
  }

  // Each note.
  const seen = new Set<string>();
  let attachments = 0;
  const tooLarge = new Set<string>();
  for (const note of [...server.notes].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    seen.add(note.id);
    const doc = docOf(note.update);
    const gitDoc = ops.note(note.id);
    let content: LocalNoteContent | null = null;
    try {
      content = gitDoc && gitRegistry.has(note.id) ? local.content(note.id) : null;
    } catch (error) {
      if (!(error instanceof LocalError)) throw error;
    }
    if (!gitDoc || !content) {
      add({ id: note.id, field: 'note', server: 'present', notebook: 'missing' });
      doc.destroy();
      continue;
    }
    if (note.content) {
      for (const field of ['title', 'tags', 'markdown', 'body'] as const) {
        if (!same(note.content[field], content[field])) {
          add({ id: note.id, field, server: note.content[field], notebook: content[field] });
        }
      }
    }
    if (isDeleted(doc) !== content.deleted) {
      add({ id: note.id, field: 'trash', server: isDeleted(doc), notebook: content.deleted });
    }
    const wanted = serverFolder(doc, note.id, serverRegistry, serverParents);
    const filed = gitRegistry.get(note.id) ?? null;
    const has = filed !== null && gitParents.has(filed) ? filed : null;
    if (wanted !== has) {
      add({
        id: note.id,
        field: 'folder',
        server: { id: wanted, path: placeName(serverTree.folders, wanted) },
        notebook: { id: has, path: placeName(gitTree.folders, has) },
      });
    }
    const threadsHere = comparableThreads(doc);
    const threadsThere = comparableThreads(gitDoc);
    if (!same(threadsHere, threadsThere)) {
      add({ id: note.id, field: 'comments', server: threadsHere, notebook: threadsThere });
    }
    const files = new Set([
      ...attachmentFiles(noteBody(doc)).map((f) => `${f.sha256}.${f.ext}`),
      ...attachmentFiles(noteBody(gitDoc)).map((f) => `${f.sha256}.${f.ext}`),
    ]);
    for (const file of [...files].sort()) {
      attachments++;
      const expected = server.attachments.get(file) ?? 'missing';
      if (expected === 'too_large') {
        tooLarge.add(file);
        continue;
      }
      const bytes = await notebook.attachment(file);
      const actual = bytes ? await sha256Bytes(bytes) : 'missing';
      if (expected !== actual) {
        add({
          id: note.id,
          field: 'attachment',
          server: { file, sha256: expected },
          notebook: { file, sha256: actual },
        });
      }
    }
    doc.destroy();
  }
  // Notes in the notebook the server does not have.
  for (const entry of gitTree.notes) {
    if (!seen.has(entry.id) && ops.note(entry.id)) {
      add({ id: entry.id, field: 'note', server: 'missing', notebook: 'present' });
    }
  }
  for (const path of notebook.unrendered) {
    add({ id: null, field: 'render', server: null, notebook: path });
  }
  serverDoc.destroy();
  return { notes: server.notes.length, attachments, differences, tooLarge: [...tooLarge].sort() };
}

/** SHA-256 of bytes, in hex. */
export async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
