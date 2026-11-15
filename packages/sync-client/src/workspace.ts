/**
 * The WorkspaceDoc's Yjs document (A1, T7): folder tree, note registry,
 * ordering and per-user settings. Each folder and note entry is a nested
 * node whose fields merge independently, so a rename on one device and a
 * move on another both survive. Readers build the tree with
 * `@penmoss/core/workspace`, which resolves concurrent-move cycles without
 * writing anything (A17).
 *
 * - `folders`: folderId → { name, parent, position, sortMode, notebook?, together? } (`notebook:
 *   true` on a notebook's top-level folder, T43, A750; `together: true` once its subfolders and
 *   notes share one Manual order, T62 item 6)
 * - `notes`: noteId → { folder, position, path }
 * - `root`: { sortMode, notebookName?, together? } for the top level; `notebookName` is the
 *   default notebook's name (T43, A751)
 * - `folderTrash`: folderId → a deleted folder, kept for FOLDER_TRASH_DAYS so it can be
 *   restored with its subfolders and its notes (T42, A560)
 * - `tagDescriptions`: tag (its full path, `project/penmoss`) → what it means, as text (PEN-68).
 *   A plain string per tag, so each tag's description merges on its own (the last edit wins);
 *   an empty description is no entry.
 * - `settings`: `<userId>/<key>` → JSON value (keybindings, theme, time zone, capture default…).
 *   Flat on purpose: a lazily created per-user node would be one map entry,
 *   so two devices writing a user's first setting concurrently would each
 *   create one and the losing device's whole node (every key) would vanish.
 */
import {
  compareOrder,
  DEFAULT_NOTEBOOK,
  DEFAULT_NOTEBOOK_NAME,
  folderMoveRefusal,
  isWithin,
  keyBetween,
  notebookFlagRefusal,
  notebookKey,
  notebookLineage,
  SORT_MODES,
  type Fallback,
  type FolderRecord,
  type GoneFolder,
  type NotebookLineage,
  type SortMode,
} from '@penmoss/core/workspace';
import { cleanTagDescription, normaliseTag } from '@penmoss/core/tags';
import * as Y from '@y/y';

export const WORKSPACE_FOLDERS = 'folders';
export const WORKSPACE_NOTES = 'notes';
export const WORKSPACE_ROOT = 'root';
export const WORKSPACE_SETTINGS = 'settings';
export const WORKSPACE_FOLDER_TRASH = 'folderTrash';
/** Each tag's description, by its full path (PEN-68). */
export const WORKSPACE_TAG_DESCRIPTIONS = 'tagDescriptions';
/** How long a deleted folder can be restored, as a deleted note (A83). */
export const FOLDER_TRASH_DAYS = 30;
const FOLDER_TRASH_MS = FOLDER_TRASH_DAYS * 24 * 60 * 60 * 1000;
/** The WorkspaceDoc's key in the local NoteStore (A7); never a note id (those are ULIDs). */
export const WORKSPACE_RECORD_KEY = 'workspace';

export interface RegistryEntry {
  readonly id: string;
  readonly folderId: string | null;
  readonly position: string;
  /** Assigned once by the git mirror (A10); null until then. */
  readonly path: string | null;
}

export interface WorkspaceSnapshot {
  readonly folders: FolderRecord[];
  readonly notes: RegistryEntry[];
  readonly rootSortMode: SortMode;
  /** The top level's folders and notes share one Manual order (T62 item 6); absent until then. */
  readonly rootTogether?: true;
  /** The default notebook's name (T43, A751); absent until someone names it. */
  readonly defaultNotebookName?: string;
  /** Each described tag's description (PEN-68); absent while no tag has one. */
  readonly tagDescriptions?: Readonly<Record<string, string>>;
}

export class WorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceError';
  }
}

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const sortMode = (value: unknown): SortMode =>
  SORT_MODES.includes(value as SortMode) ? (value as SortMode) : 'manual';

function child(doc: Y.Doc, root: string, id: string): Y.Node | null {
  const value: unknown = doc.get(root).getAttr(id);
  return value instanceof Y.Node ? value : null;
}

export function readWorkspace(doc: Y.Doc): WorkspaceSnapshot {
  const folders: FolderRecord[] = [];
  for (const [id, value] of doc.get(WORKSPACE_FOLDERS).attrEntries()) {
    if (!(value instanceof Y.Node)) continue;
    folders.push({
      id: String(id),
      name: str(value.getAttr('name')) ?? 'Untitled folder',
      parentId: str(value.getAttr('parent')),
      position: str(value.getAttr('position')) ?? 'a0',
      sortMode: sortMode(value.getAttr('sortMode')),
      // Only when set: a tree without notebooks reads exactly as before (A750).
      ...(value.getAttr('notebook') === true ? { notebook: true as const } : {}),
      // Only once a note is placed among its folders (T62 item 6): until then, folders first.
      ...(value.getAttr('together') === true ? { together: true as const } : {}),
    });
  }
  const notes: RegistryEntry[] = [];
  for (const [id, value] of doc.get(WORKSPACE_NOTES).attrEntries()) {
    if (!(value instanceof Y.Node)) continue;
    notes.push({
      id: String(id),
      folderId: str(value.getAttr('folder')),
      position: str(value.getAttr('position')) ?? 'a0',
      path: str(value.getAttr('path')),
    });
  }
  const root = doc.get(WORKSPACE_ROOT);
  const name = str(root.getAttr('notebookName'))?.trim();
  const described = readTagDescriptions(doc);
  return {
    folders,
    notes,
    rootSortMode: sortMode(root.getAttr('sortMode')),
    ...(root.getAttr('together') === true ? { rootTogether: true as const } : {}),
    ...(name ? { defaultNotebookName: name } : {}),
    ...(Object.keys(described).length > 0 ? { tagDescriptions: described } : {}),
  };
}

/** Each described tag's description (PEN-68), by the tag's full path. */
export function readTagDescriptions(doc: Y.Doc): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [tag, value] of doc.get(WORKSPACE_TAG_DESCRIPTIONS).attrEntries()) {
    if (typeof value === 'string' && value.trim() !== '') out[String(tag)] = value;
  }
  return out;
}

/**
 * Sets what `tag` means (PEN-68), as typed (cut to `TAG_DESCRIPTION_MAX`); a description with no
 * text removes the entry. Throws WorkspaceError for a name that is not a tag's canonical form.
 */
export function setTagDescription(
  doc: Y.Doc,
  tag: string,
  text: string,
  origin: unknown = null,
): void {
  if (normaliseTag(tag) !== tag) throw new WorkspaceError('Not a tag');
  const kept = cleanTagDescription(text);
  const map = doc.get(WORKSPACE_TAG_DESCRIPTIONS);
  if ((map.getAttr(tag) ?? null) === kept) return;
  doc.transact(() => {
    if (kept === null) map.deleteAttr(tag);
    else map.setAttr(tag, kept);
  }, origin);
}

/** The default notebook's name: the one set in Settings, else "Personal" (T43, A751). */
export function defaultNotebookName(
  snapshot: Pick<WorkspaceSnapshot, 'defaultNotebookName'>,
): string {
  return snapshot.defaultNotebookName ?? DEFAULT_NOTEBOOK_NAME;
}

/** Names the default notebook (T43, A751); an empty name goes back to "Personal". */
export function setDefaultNotebookName(doc: Y.Doc, name: string, origin: unknown = null): void {
  const trimmed = name.trim().slice(0, 200);
  doc.transact(() => {
    const root = doc.get(WORKSPACE_ROOT);
    if (trimmed) root.setAttr('notebookName', trimmed);
    else root.deleteAttr('notebookName');
  }, origin);
}

/** An order key after every current sibling folder of `parentId` (or note, for `kind` 'notes'). */
export function endPosition(
  doc: Y.Doc,
  parentId: string | null,
  kind: 'folders' | 'notes',
): string {
  const snapshot = readWorkspace(doc);
  const siblings =
    kind === 'folders'
      ? snapshot.folders.filter((folder) => folder.parentId === parentId)
      : snapshot.notes.filter((note) => note.folderId === parentId);
  const last =
    siblings
      .map((item) => item.position)
      .sort()
      .at(-1) ?? null;
  return keyBetween(last, null);
}

export function createFolder(
  doc: Y.Doc,
  folder: {
    id: string;
    name: string;
    parentId: string | null;
    position?: string;
    /** A new notebook (T43): only at the top level. */
    notebook?: boolean;
  },
  origin: unknown = null,
): void {
  // The default notebook's id names it wherever notebooks are named (T43): never a folder's.
  if (folder.id === DEFAULT_NOTEBOOK) throw new WorkspaceError('That folder id is reserved');
  if (folder.parentId !== null && !child(doc, WORKSPACE_FOLDERS, folder.parentId)) {
    throw new WorkspaceError('The parent folder does not exist');
  }
  if (folder.notebook && folder.parentId !== null) {
    throw new WorkspaceError(
      'A notebook stays at the top level: notebooks cannot go inside folders',
    );
  }
  const position = folder.position ?? endPosition(doc, folder.parentId, 'folders');
  doc.transact(() => {
    const node = new Y.Node();
    doc.get(WORKSPACE_FOLDERS).setAttr(folder.id, node);
    node.setAttr('name', folder.name);
    node.setAttr('parent', folder.parentId);
    node.setAttr('position', position);
    node.setAttr('sortMode', 'manual');
    if (folder.notebook) node.setAttr('notebook', true);
  }, origin);
}

/**
 * Turns a top-level folder into a notebook, or a notebook back into a folder (T43, A756): one
 * flag, in one step. Journal and the Inbox never become one (A751). Its notes stay where they
 * are; which repository mirrors them follows from the flag.
 */
export function setNotebook(doc: Y.Doc, id: string, on: boolean, origin: unknown = null): void {
  const node = requireFolder(doc, id);
  const refusal = notebookFlagRefusal(readWorkspace(doc).folders, id, on);
  if (refusal) throw new WorkspaceError(refusal);
  doc.transact(() => {
    if (on) node.setAttr('notebook', true);
    else node.deleteAttr('notebook');
  }, origin);
}

export function renameFolder(doc: Y.Doc, id: string, name: string, origin: unknown = null): void {
  const node = requireFolder(doc, id);
  doc.transact(() => node.setAttr('name', name), origin);
}

/** Moves a folder; refuses to put it inside itself (concurrent moves are resolved on read). */
export function moveFolder(
  doc: Y.Doc,
  id: string,
  parentId: string | null,
  position: string,
  origin: unknown = null,
): void {
  const node = requireFolder(doc, id);
  if (parentId !== null) requireFolder(doc, parentId);
  const { folders } = readWorkspace(doc);
  if (isWithin(folders, parentId, id)) {
    throw new WorkspaceError('A folder cannot move into itself or one of its subfolders');
  }
  // A notebook stays at the top level; Journal and the Inbox stay in the default (T43, A750).
  const refusal = folderMoveRefusal(folders, id, parentId);
  if (refusal) throw new WorkspaceError(refusal);
  doc.transact(() => {
    node.setAttr('parent', parentId);
    node.setAttr('position', position);
  }, origin);
}

/** A folder in Trash as the apps list it. */
export interface TrashedFolder {
  readonly id: string;
  readonly name: string;
  /** Where it was; restoring it there, or at the top level if that folder is gone. */
  readonly parentId: string | null;
  readonly deletedAt: number;
  /** Who deleted it, when the delete said (the server says for every actor); else null. */
  readonly deletedBy: FolderDeleter | null;
  /** Its subfolders, at any depth. */
  readonly folders: number;
  /** The notes it and its subfolders held. */
  readonly notes: number;
  /** A notebook (T43): its notes went to Trash with it, and Restore brings them back. */
  readonly notebook: boolean;
}

interface TrashedFolderRecord {
  readonly id: string;
  readonly name: string;
  readonly parentId: string | null;
  readonly position: string;
  readonly sortMode: SortMode;
}

interface TrashedNoteRecord {
  readonly id: string;
  /** Where it was: the deleted folder or one of its subfolders. */
  readonly folderId: string;
  readonly position: string;
  /** Where the delete put it; a note no longer there was moved since and stays put. */
  readonly movedTo: string | null;
  readonly movedPosition: string;
  /**
   * The note went to Trash with its notebook (T43, A750) and left the registry, rather than
   * moving up; Restore files it again where it was if nothing filed it since.
   */
  readonly trashed: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function trashedFolders(value: unknown): TrashedFolderRecord[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).flatMap((item) => {
    const id = str(item['id']);
    if (!id) return [];
    return [
      {
        id,
        name: str(item['name']) ?? 'Untitled folder',
        parentId: str(item['parentId']),
        position: str(item['position']) ?? 'a0',
        sortMode: sortMode(item['sortMode']),
      },
    ];
  });
}

function trashedNotes(value: unknown): TrashedNoteRecord[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).flatMap((item) => {
    const id = str(item['id']);
    const folderId = str(item['folderId']);
    if (!id || !folderId) return [];
    return [
      {
        id,
        folderId,
        position: str(item['position']) ?? 'a0',
        movedTo: str(item['movedTo']),
        movedPosition: str(item['movedPosition']) ?? 'a0',
        trashed: item['trashed'] === true,
      },
    ];
  });
}

/**
 * A Trash record's key for one note it lists beside `notes` (A675): a note moved up later
 * (`rehomeNotes`) is listed under a key of its own, so two devices listing two notes at once
 * both keep theirs. `deleteFolder` still writes its notes as one list, as before.
 */
const TRASHED_NOTE_PREFIX = 'note:';

/**
 * The notes a Trash record lists: its `notes` list, and each note listed under a key of its own
 * (A675), which wins over the list for the same note. Older records hold only the list.
 */
function trashedNotesOf(record: Y.Node): TrashedNoteRecord[] {
  const byId = new Map(trashedNotes(record.getAttr('notes')).map((note) => [note.id, note]));
  for (const [key, value] of record.attrEntries()) {
    const name = String(key);
    if (!name.startsWith(TRASHED_NOTE_PREFIX) || !isRecord(value)) continue;
    const [note] = trashedNotes([{ ...value, id: name.slice(TRASHED_NOTE_PREFIX.length) }]);
    if (note) byId.set(note.id, note);
  }
  return [...byId.values()];
}

/**
 * A Trash record's key for one folder it lists beside `folders` (T43, A757): a folder made on a
 * device under a folder another device deleted, which the repair (`rehomeNotes`) moved up to the
 * nearest folder still there (`movedTo`), or put in Trash with a deleted notebook (`trashed`).
 */
const TRASHED_FOLDER_PREFIX = 'folder:';

interface KeyedFolderRecord extends TrashedFolderRecord {
  /** In Trash with the record's folder (a deleted notebook's); else moved up to `movedTo`. */
  readonly trashed: boolean;
  readonly movedTo: string | null;
  readonly movedPosition: string;
}

function keyedFoldersOf(record: Y.Node): KeyedFolderRecord[] {
  const out: KeyedFolderRecord[] = [];
  for (const [key, value] of record.attrEntries()) {
    const name = String(key);
    if (!name.startsWith(TRASHED_FOLDER_PREFIX) || !isRecord(value)) continue;
    const [folder] = trashedFolders([{ ...value, id: name.slice(TRASHED_FOLDER_PREFIX.length) }]);
    if (!folder) continue;
    out.push({
      ...folder,
      trashed: value['trashed'] === true,
      movedTo: str(value['movedTo']),
      movedPosition: str(value['movedPosition']) ?? 'a0',
    });
  }
  return out;
}

/** The subfolders a Trash record holds: its `folders` list and those put in Trash with it later. */
function trashedFoldersOf(record: Y.Node): TrashedFolderRecord[] {
  const byId = new Map(trashedFolders(record.getAttr('folders')).map((f) => [f.id, f]));
  for (const folder of keyedFoldersOf(record)) if (folder.trashed) byId.set(folder.id, folder);
  return [...byId.values()];
}

/**
 * The folders Trash remembers (T43, A757), for `notebookLineage`: each deleted folder, and the
 * subfolders that went with it, with where each was. A notebook's own folder says so.
 */
export function goneFolders(doc: Y.Doc): GoneFolder[] {
  const out: GoneFolder[] = [];
  for (const [id, value] of doc.get(WORKSPACE_FOLDER_TRASH).attrEntries()) {
    if (!(value instanceof Y.Node)) continue;
    out.push({
      id: String(id),
      parentId: str(value.getAttr('parent')),
      notebook: value.getAttr('notebook') === true,
    });
    for (const folder of trashedFoldersOf(value)) {
      out.push({ id: folder.id, parentId: folder.parentId, notebook: false });
    }
  }
  return out;
}

/** A note a folder delete moved up, still where the delete put it (T43, A769). */
export interface MovedUpNote {
  readonly noteId: string;
  /** The deleted folder whose Trash record lists it. */
  readonly deletedFolder: string;
  readonly deletedAt: number;
}

/**
 * The notes folder deletes moved up and that are still where the delete put them (T43, A769):
 * the server holds such a note with no record of its notebook for a while, since a device that
 * had turned the folder into a notebook may not have synced yet. Notebook records are left out:
 * their notes went to Trash.
 */
export function movedUpNotes(doc: Y.Doc): MovedUpNote[] {
  const filed = new Map(readWorkspace(doc).notes.map((note) => [note.id, note.folderId]));
  const out: MovedUpNote[] = [];
  for (const [id, value] of doc.get(WORKSPACE_FOLDER_TRASH).attrEntries()) {
    if (!(value instanceof Y.Node) || value.getAttr('notebook') === true) continue;
    const deletedAt: unknown = value.getAttr('deletedAt');
    for (const note of trashedNotesOf(value)) {
      if (note.trashed || !filed.has(note.id) || filed.get(note.id) !== note.movedTo) continue;
      out.push({
        noteId: note.id,
        deletedFolder: String(id),
        deletedAt: typeof deletedAt === 'number' ? deletedAt : 0,
      });
    }
  }
  return out;
}

/** Which notebook each folder belongs to, read through Trash for the folders that are gone. */
export function lineageOf(doc: Y.Doc): NotebookLineage {
  return notebookLineage(readWorkspace(doc).folders, goneFolders(doc));
}

/**
 * Each filed note's notebook (`notebookKey`: a notebook's id, or `default`) where it is certain
 * (T43, A766): what a client compares before and after its own change, to record a move to
 * another notebook in the note's own document.
 */
export function notebookPlaces(doc: Y.Doc): Map<string, string> {
  const snapshot = readWorkspace(doc);
  const lineage = notebookLineage(snapshot.folders, goneFolders(doc));
  const out = new Map<string, string>();
  for (const note of snapshot.notes) {
    const place = lineage.placement(note.folderId);
    if (place.certain) out.set(note.id, notebookKey(place.notebook));
  }
  return out;
}

/** The notebook a note filed in `folderId` belongs to (`notebookKey`), or null when not certain. */
export function notebookOfFolder(doc: Y.Doc, folderId: string | null): string | null {
  const place = lineageOf(doc).placement(folderId);
  return place.certain ? notebookKey(place.notebook) : null;
}

/**
 * Where to file something meant for `folderId` (T43, A757): that folder, else the nearest one
 * above it still in the tree, within its notebook; refused when there is no safe place (its
 * notebook was deleted, or Trash no longer remembers the folder). Never from a notebook into the
 * default notebook.
 */
export function fallbackFolder(doc: Y.Doc, folderId: string | null): Fallback {
  return lineageOf(doc).fallback(folderId);
}

/**
 * Makes a folder straight into Trash with a deleted notebook (T43, A757): what the phone asked
 * for under a folder of that notebook, deleted elsewhere since. It comes back with the
 * notebook on Restore; notes filed in it meanwhile go to Trash with the notebook too.
 */
export function trashWithNotebook(
  doc: Y.Doc,
  notebookId: string,
  folder: Pick<FolderRecord, 'id' | 'name' | 'parentId' | 'position' | 'sortMode'>,
  origin: unknown = null,
): void {
  const record = child(doc, WORKSPACE_FOLDER_TRASH, notebookId);
  if (!record || record.getAttr('notebook') !== true) {
    throw new WorkspaceError('That notebook is not in Trash');
  }
  doc.transact(() => {
    record.setAttr(`${TRASHED_FOLDER_PREFIX}${folder.id}`, {
      name: folder.name,
      parentId: folder.parentId,
      position: folder.position,
      sortMode: folder.sortMode,
      trashed: true,
    });
  }, origin);
}

/** Drops folders deleted more than FOLDER_TRASH_DAYS ago (inside the caller's transaction). */
function purgeFolderTrash(doc: Y.Doc, now: number): void {
  const trash = doc.get(WORKSPACE_FOLDER_TRASH);
  for (const [id, value] of [...trash.attrEntries()]) {
    const deletedAt: unknown = value instanceof Y.Node ? value.getAttr('deletedAt') : null;
    if (typeof deletedAt !== 'number' || now - deletedAt > FOLDER_TRASH_MS) {
      trash.deleteAttr(String(id));
    }
  }
}

/** What `deleteFolder` did. */
export interface DeletedFolder {
  /** It was a notebook: its notes left the registry for Trash with it (T43, A750). */
  readonly notebook: boolean;
  /** Those notes, which the caller moves to Trash (the server does too, A757). */
  readonly trashed: readonly string[];
}

/**
 * Deletes a folder and its subfolders. Their notes move up to the deleted folder's parent:
 * deleting a folder never deletes notes. A notebook is the exception (T43, A750): its notes
 * go to Trash with it, never up into the default notebook, whose repository would publish
 * them; they leave the registry here and the caller moves each to Trash. The folder goes to Trash (T42, A560) with its
 * subfolders, their order and sort, and where each note was, so `restoreFolder` can put it
 * all back for FOLDER_TRASH_DAYS. `by` names who deleted it, for the Trash list.
 */
export function deleteFolder(
  doc: Y.Doc,
  id: string,
  origin: unknown = null,
  options: { readonly now?: number; readonly by?: FolderDeleter | null } = {},
): DeletedFolder {
  const snapshot = readWorkspace(doc);
  const target = snapshot.folders.find((folder) => folder.id === id);
  if (!target) throw new WorkspaceError('No such folder');
  const doomed = snapshot.folders.filter((folder) => isWithin(snapshot.folders, folder.id, id));
  const doomedIds = new Set(doomed.map((folder) => folder.id));
  const notebook = target.notebook === true;
  const destination =
    target.parentId !== null && !doomedIds.has(target.parentId) ? target.parentId : null;
  // The notes keep their manual order: the folder's own first, then each subfolder's, depth first.
  const moving: RegistryEntry[] = [];
  const visit = (folderId: string) => {
    moving.push(...snapshot.notes.filter((note) => note.folderId === folderId).sort(compareOrder));
    for (const sub of doomed.filter((folder) => folder.parentId === folderId).sort(compareOrder)) {
      if (sub.id !== id) visit(sub.id);
    }
  };
  visit(id);
  const now = options.now ?? Date.now();
  doc.transact(() => {
    purgeFolderTrash(doc, now);
    const notes: TrashedNoteRecord[] = [];
    let last = endPosition(doc, destination, 'notes');
    for (const note of moving) {
      if (notebook) {
        // To Trash with the notebook: out of the registry, never up (A750).
        doc.get(WORKSPACE_NOTES).deleteAttr(note.id);
        notes.push({
          id: note.id,
          folderId: note.folderId ?? id,
          position: note.position,
          movedTo: null,
          movedPosition: '',
          trashed: true,
        });
        continue;
      }
      const entry = child(doc, WORKSPACE_NOTES, note.id);
      entry?.setAttr('folder', destination);
      entry?.setAttr('position', last);
      notes.push({
        id: note.id,
        folderId: note.folderId ?? id,
        position: note.position,
        movedTo: destination,
        movedPosition: last,
        trashed: false,
      });
      last = keyBetween(last, null);
    }
    const record = new Y.Node();
    doc.get(WORKSPACE_FOLDER_TRASH).setAttr(id, record);
    record.setAttr('name', target.name);
    record.setAttr('parent', target.parentId);
    record.setAttr('position', target.position);
    record.setAttr('sortMode', target.sortMode);
    record.setAttr('deletedAt', now);
    record.setAttr('deletedBy', options.by?.label ?? null);
    record.setAttr('deletedByKind', options.by?.kind ?? null);
    if (notebook) record.setAttr('notebook', true);
    record.setAttr(
      'folders',
      doomed
        .filter((folder) => folder.id !== id)
        .map((folder) => ({
          id: folder.id,
          name: folder.name,
          parentId: folder.parentId,
          position: folder.position,
          sortMode: folder.sortMode,
        })),
    );
    record.setAttr('notes', notes);
    for (const folderId of doomedIds) doc.get(WORKSPACE_FOLDERS).deleteAttr(folderId);
  }, origin);
  return { notebook, trashed: notebook ? moving.map((note) => note.id) : [] };
}

/**
 * The notes in Trash with a deleted notebook (T43, A750), each with its notebook's id, while the
 * notebook can be restored. A device that still holds one of them as a live copy never files it
 * at the top level (it would publish it to the default repository), and the git mirror's default
 * notebook never writes them.
 */
export function notebookTrashNotes(doc: Y.Doc, now: number = Date.now()): Map<string, string> {
  const out = new Map<string, string>();
  for (const [id, value] of doc.get(WORKSPACE_FOLDER_TRASH).attrEntries()) {
    if (!(value instanceof Y.Node) || value.getAttr('notebook') !== true) continue;
    const deletedAt: unknown = value.getAttr('deletedAt');
    if (typeof deletedAt !== 'number' || now - deletedAt > FOLDER_TRASH_MS) continue;
    for (const note of trashedNotesOf(value)) if (note.trashed) out.set(note.id, String(id));
  }
  return out;
}

/**
 * A folder deleted on a device that did not know it had become a notebook (T43 review of #160):
 * its Trash record becomes a notebook's, and the notes that delete moved up, still where it put
 * them, go to Trash with it (out of the registry, `trashed`), never staying in the default
 * notebook. A note moved again since stays where it is. Returns the notes it put in Trash.
 */
export function trashAsNotebook(doc: Y.Doc, folderId: string, origin: unknown = null): string[] {
  const record = child(doc, WORKSPACE_FOLDER_TRASH, folderId);
  if (!record || record.getAttr('notebook') === true) return [];
  const filed = new Map(readWorkspace(doc).notes.map((note) => [note.id, note]));
  const trashed: string[] = [];
  doc.transact(() => {
    record.setAttr('notebook', true);
    for (const note of trashedNotesOf(record)) {
      if (note.trashed) continue;
      const entry = filed.get(note.id);
      if (!entry || entry.folderId !== note.movedTo) continue;
      doc.get(WORKSPACE_NOTES).deleteAttr(note.id);
      record.setAttr(`${TRASHED_NOTE_PREFIX}${note.id}`, {
        folderId: note.folderId,
        position: note.position,
        movedTo: null,
        movedPosition: '',
        trashed: true,
      });
      trashed.push(note.id);
    }
  }, origin);
  return trashed;
}

/**
 * The folder ids the folders map holds anything at: a node, or a value the tree skips. Such an
 * id is not missing, so a note filed there never moves (#132 review N-d).
 */
function heldFolders(doc: Y.Doc): Set<string> {
  const held = new Set<string>();
  for (const [id, value] of doc.get(WORKSPACE_FOLDERS).attrEntries()) {
    if (value !== undefined) held.add(String(id));
  }
  return held;
}

/**
 * Whether any note is filed in a folder that no longer exists, or any folder sits in one (what
 * `rehomeNotes` repairs).
 */
export function hasStrayNotes(doc: Y.Doc): boolean {
  const held = heldFolders(doc);
  for (const [, value] of doc.get(WORKSPACE_NOTES).attrEntries()) {
    if (!(value instanceof Y.Node)) continue;
    const folder = str(value.getAttr('folder'));
    if (folder !== null && !held.has(folder)) return true;
  }
  for (const [, value] of doc.get(WORKSPACE_FOLDERS).attrEntries()) {
    if (!(value instanceof Y.Node)) continue;
    const parent = str(value.getAttr('parent'));
    if (parent !== null && !held.has(parent)) return true;
  }
  return false;
}

/** What `rehomeNotes` did. */
export interface RehomeOutcome {
  /** Notes moved up out of a folder that no longer exists, or into Trash with their notebook. */
  readonly moved: number;
  /**
   * Of the stray notes, those no Trash record lists: where they belong is not known, so they
   * stay where they are and every git mirror holds them (T43, A757: fail closed).
   */
  readonly untracked: number;
  /** Folders moved up out of a folder that no longer exists, or into Trash with their notebook. */
  readonly folders: number;
}

/**
 * Repairs what a delete on one device leaves behind on another (A673, A674, T43 A757): a note
 * filed, or a folder made, in a folder that no longer exists. That happens when one device files
 * a note or makes a subfolder while another deletes the folder: each delete moves only what it
 * knew of. Each goes where the folder delete would have put it, by the rule every fallback uses
 * (`notebookLineage`'s `fallback`): the nearest folder above it still in the tree, or the top
 * level when the whole way up was the default notebook's. Never from a notebook into the default
 * notebook: when the way up passes a notebook that was deleted, it goes to Trash with that
 * notebook (out of the tree, listed in its record, back with it on Restore); when Trash no longer
 * knows the folder, it stays put and the mirrors hold it. The Trash record lists where each was
 * and where it went, under a key of its own (A675), so Restore puts it back.
 *
 * Idempotent and deterministic: run again it changes nothing, and run on the same state anywhere
 * it writes the same values. `which` limits it to some notes (a rebase: those it affected); with
 * it, folders are left to the server.
 */
export function rehomeNotes(
  doc: Y.Doc,
  which?: (note: RegistryEntry) => boolean,
  origin: unknown = null,
): RehomeOutcome {
  const snapshot = readWorkspace(doc);
  const held = heldFolders(doc);
  const orphans =
    which === undefined
      ? snapshot.folders
          .filter((folder) => folder.parentId !== null && !held.has(folder.parentId))
          .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      : [];
  const stray = snapshot.notes
    .filter(
      (note) => note.folderId !== null && !held.has(note.folderId) && (which ?? (() => true))(note),
    )
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (stray.length === 0 && orphans.length === 0) return { moved: 0, untracked: 0, folders: 0 };
  const trash = doc.get(WORKSPACE_FOLDER_TRASH);
  /** The Trash record of `folderId`, or of the deleted folder that lists it as a subfolder. */
  const recordOf = (folderId: string): Y.Node | null => {
    const own = child(doc, WORKSPACE_FOLDER_TRASH, folderId);
    if (own) return own;
    for (const [, value] of trash.attrEntries()) {
      if (!(value instanceof Y.Node)) continue;
      if (trashedFoldersOf(value).some((folder) => folder.id === folderId)) return value;
    }
    return null;
  };
  const lineage = notebookLineage(snapshot.folders, goneFolders(doc));
  let untracked = 0;
  let moved = 0;
  let folders = 0;
  doc.transact(() => {
    const trashNote = (record: Y.Node, noteId: string, folderId: string, position: string) => {
      doc.get(WORKSPACE_NOTES).deleteAttr(noteId);
      record.setAttr(`${TRASHED_NOTE_PREFIX}${noteId}`, {
        folderId,
        position,
        movedTo: null,
        movedPosition: '',
        trashed: true,
      });
    };
    for (const orphan of orphans) {
      const node = child(doc, WORKSPACE_FOLDERS, orphan.id);
      if (!node) continue; // Gone already: in Trash with an earlier orphan's notebook.
      const parentId = orphan.parentId!;
      const place = lineage.fallback(parentId);
      if ('refused' in place) {
        const record = place.notebook ? child(doc, WORKSPACE_FOLDER_TRASH, place.notebook) : null;
        if (place.refused === 'unknown' || !record) continue;
        // Made in a notebook another device deleted: it goes to Trash with the notebook, with
        // everything in it, never up into the default (T43, A757).
        const now = readWorkspace(doc);
        const subtree = now.folders.filter((folder) => isWithin(now.folders, folder.id, orphan.id));
        const inside = new Set(subtree.map((folder) => folder.id));
        for (const folder of subtree) {
          record.setAttr(`${TRASHED_FOLDER_PREFIX}${folder.id}`, {
            name: folder.name,
            parentId: folder.parentId,
            position: folder.position,
            sortMode: folder.sortMode,
            trashed: true,
          });
        }
        for (const note of now.notes) {
          if (note.folderId !== null && inside.has(note.folderId)) {
            trashNote(record, note.id, note.folderId, note.position);
            moved++;
          }
        }
        for (const id of inside) doc.get(WORKSPACE_FOLDERS).deleteAttr(id);
        folders += inside.size;
        continue;
      }
      const movedTo = place.folderId;
      if (movedTo !== null && isWithin(readWorkspace(doc).folders, movedTo, orphan.id)) continue;
      const movedPosition = endPosition(doc, movedTo, 'folders');
      node.setAttr('parent', movedTo);
      node.setAttr('position', movedPosition);
      folders++;
      recordOf(parentId)?.setAttr(`${TRASHED_FOLDER_PREFIX}${orphan.id}`, {
        name: orphan.name,
        parentId,
        position: orphan.position,
        sortMode: orphan.sortMode,
        trashed: false,
        movedTo,
        movedPosition,
      });
    }
    for (const note of stray) {
      const folderId = note.folderId!;
      const entry = child(doc, WORKSPACE_NOTES, note.id);
      if (!entry) continue;
      const place = lineage.fallback(folderId);
      if ('refused' in place) {
        const record = place.notebook ? child(doc, WORKSPACE_FOLDER_TRASH, place.notebook) : null;
        if (place.refused === 'unknown' || !record) {
          // Nobody knows where it belongs: it stays, held by every mirror (A757).
          untracked++;
          continue;
        }
        // Filed in a deleted notebook (another device filed it as the notebook went): it goes
        // to Trash with the notebook, never up into the default (T43, A750).
        trashNote(record, note.id, folderId, note.position);
        moved++;
        continue;
      }
      const movedTo = place.folderId;
      const movedPosition = endPosition(doc, movedTo, 'notes');
      entry.setAttr('folder', movedTo);
      entry.setAttr('position', movedPosition);
      moved++;
      // A key of its own (A675): another device listing another note at once keeps its listing.
      recordOf(folderId)?.setAttr(`${TRASHED_NOTE_PREFIX}${note.id}`, {
        folderId,
        position: note.position,
        movedTo,
        movedPosition,
      });
    }
  }, origin);
  return { moved, untracked, folders };
}

/** Folders in Trash, newest first: those deleted in the last FOLDER_TRASH_DAYS. */
export function readFolderTrash(doc: Y.Doc, now: number = Date.now()): TrashedFolder[] {
  const out: TrashedFolder[] = [];
  for (const [id, value] of doc.get(WORKSPACE_FOLDER_TRASH).attrEntries()) {
    if (!(value instanceof Y.Node)) continue;
    const deletedAt: unknown = value.getAttr('deletedAt');
    if (typeof deletedAt !== 'number' || now - deletedAt > FOLDER_TRASH_MS) continue;
    out.push({
      id: String(id),
      name: str(value.getAttr('name')) ?? 'Untitled folder',
      parentId: str(value.getAttr('parent')),
      deletedAt,
      deletedBy: deleterOf(value),
      folders: trashedFoldersOf(value).length,
      notes: trashedNotesOf(value).length,
      notebook: value.getAttr('notebook') === true,
    });
  }
  return out.sort((a, b) => b.deletedAt - a.deletedAt || a.id.localeCompare(b.id));
}

/** Who deleted a folder: a device or an agent, by the name the apps show. */
export interface FolderDeleter {
  readonly label: string;
  readonly kind: 'agent' | 'device';
}

function deleterOf(record: Y.Node): FolderDeleter | null {
  const label = str(record.getAttr('deletedBy'));
  if (label === null) return null;
  return { label, kind: record.getAttr('deletedByKind') === 'device' ? 'device' : 'agent' };
}

/** What `restoreFolder` did. */
export interface FolderRestore {
  /** False: the folder was not in Trash (restored already, or purged). */
  readonly restored: boolean;
  /**
   * The folder it was in is gone, so it came back in the nearest folder above it within its
   * notebook (`parentId`), or at the top level when that was the default notebook's (T43).
   */
  readonly parentGone: boolean;
  /** Where it came back (null: the top level). */
  readonly parentId?: string | null;
  /** Notes put back where they were. */
  readonly notes: number;
  /** Notes moved, deleted or gone since the delete: they stay where they are now. */
  readonly skipped: readonly string[];
  /** A notebook (T43): `filed` are its notes filed again, which the caller takes out of Trash. */
  readonly notebook: boolean;
  readonly filed: readonly string[];
  /**
   * Not restored (T43 review B2, A757): the folder it was in is gone and the way up passes a
   * deleted notebook (`notebook`, null when Trash forgets it), so there is no safe place; never
   * the default notebook's top level. Restore the notebook first.
   */
  readonly refused?: { readonly notebook: string | null };
  /**
   * Notes the caller kept out (`keepOut`): a git notebook's notes deleted for good (A828), whose
   * ids must never be filed again (#174 review). They stay out of the tree.
   */
  readonly keptOut?: readonly string[];
}

/**
 * Brings a folder back from Trash (T42, A560) with its subfolders, their order and sort,
 * into the folder it was in (the top level if that folder is gone). Each of its notes comes
 * back too, unless it was moved or deleted since: a note no longer where the delete put it
 * stays where it is now (`skipped`). Idempotent: a folder not in Trash restores nothing.
 */
export function restoreFolder(
  doc: Y.Doc,
  id: string,
  origin: unknown = null,
  options: { readonly keepOut?: (noteId: string) => boolean } = {},
): FolderRestore {
  const nothing = {
    restored: false,
    parentGone: false,
    notes: 0,
    skipped: [],
    notebook: false,
    filed: [],
  };
  const record = child(doc, WORKSPACE_FOLDER_TRASH, id);
  if (!record) return nothing;
  const snapshot = readWorkspace(doc);
  const exists = new Set(snapshot.folders.map((folder) => folder.id));
  if (exists.has(id)) {
    doc.transact(() => doc.get(WORKSPACE_FOLDER_TRASH).deleteAttr(id), origin);
    return nothing;
  }
  const recordedParent = str(record.getAttr('parent'));
  const notebookRecord = record.getAttr('notebook') === true;
  const parentGone = recordedParent !== null && !exists.has(recordedParent);
  let parentId = parentGone ? null : recordedParent;
  if (parentGone && !notebookRecord) {
    // The nearest folder above it within its notebook (A757): never from a notebook into the
    // default notebook's top level.
    const place = notebookLineage(snapshot.folders, goneFolders(doc)).fallback(recordedParent);
    if ('refused' in place) return { ...nothing, refused: { notebook: place.notebook } };
    parentId = place.folderId;
  }
  const top: TrashedFolderRecord = {
    id,
    name: str(record.getAttr('name')) ?? 'Untitled folder',
    parentId,
    position: str(record.getAttr('position')) ?? 'a0',
    sortMode: sortMode(record.getAttr('sortMode')),
  };
  const subfolders = trashedFoldersOf(record).filter((folder) => !exists.has(folder.id));
  // Folders the repair moved up out of this one (T43): back in it, unless moved since.
  const movedUp = keyedFoldersOf(record).filter((folder) => !folder.trashed);
  const coming = new Set([id, ...subfolders.map((folder) => folder.id)]);
  const notes = trashedNotesOf(record);
  const notebook = record.getAttr('notebook') === true;
  const current = new Map(snapshot.notes.map((note) => [note.id, note]));
  let restoredNotes = 0;
  const skipped: string[] = [];
  const filed: string[] = [];
  const keptOut: string[] = [];
  doc.transact(() => {
    for (const folder of [top, ...subfolders]) {
      const node = new Y.Node();
      doc.get(WORKSPACE_FOLDERS).setAttr(folder.id, node);
      node.setAttr('name', folder.name);
      // A folder put in Trash with it later whose own folder is not coming back: in this one.
      const parent =
        folder.id === id || folder.parentId === null || coming.has(folder.parentId)
          ? folder.parentId
          : exists.has(folder.parentId)
            ? folder.parentId
            : id;
      node.setAttr('parent', parent);
      node.setAttr('position', folder.position);
      node.setAttr('sortMode', folder.sortMode);
      // A notebook comes back a notebook, at the top level (T43, A750).
      if (notebook && folder.id === id) {
        node.setAttr('notebook', true);
        node.setAttr('parent', null);
      }
    }
    for (const note of notes) {
      if (options.keepOut?.(note.id)) {
        keptOut.push(note.id);
        continue;
      }
      if (note.trashed) {
        // Filed again where it was, unless something filed it since (restored on its own).
        if (current.has(note.id)) {
          skipped.push(note.id);
          continue;
        }
        const entry = new Y.Node();
        doc.get(WORKSPACE_NOTES).setAttr(note.id, entry);
        entry.setAttr('folder', note.folderId);
        entry.setAttr('position', note.position);
        filed.push(note.id);
        restoredNotes += 1;
        continue;
      }
      const now = current.get(note.id);
      const entry = child(doc, WORKSPACE_NOTES, note.id);
      if (!now || !entry || now.folderId !== note.movedTo || now.position !== note.movedPosition) {
        skipped.push(note.id);
        continue;
      }
      entry.setAttr('folder', note.folderId);
      entry.setAttr('position', note.position);
      restoredNotes += 1;
    }
    for (const folder of movedUp) {
      const node = child(doc, WORKSPACE_FOLDERS, folder.id);
      if (!node || !coming.has(folder.parentId ?? '')) continue;
      if (str(node.getAttr('parent')) !== folder.movedTo) continue;
      if (str(node.getAttr('position')) !== folder.movedPosition) continue;
      node.setAttr('parent', folder.parentId);
      node.setAttr('position', folder.position);
    }
    doc.get(WORKSPACE_FOLDER_TRASH).deleteAttr(id);
  }, origin);
  return {
    restored: true,
    parentGone: notebook ? false : parentGone,
    parentId: notebook ? null : parentId,
    notes: restoredNotes,
    skipped,
    notebook,
    filed,
    ...(options.keepOut ? { keptOut } : {}),
  };
}

/** Sort mode of a folder, or of the top level when `folderId` is null. Synced (T7). */
export function setSortMode(
  doc: Y.Doc,
  folderId: string | null,
  mode: SortMode,
  origin: unknown = null,
): void {
  const node = folderId === null ? doc.get(WORKSPACE_ROOT) : requireFolder(doc, folderId);
  doc.transact(() => node.setAttr('sortMode', mode), origin);
}

/**
 * Puts a folder's subfolders and notes (null: the top level's) in one Manual order (T62 item 6),
 * so a note may sit above or between them. Their order keys are then compared across both kinds;
 * the caller re-keys them in the same transaction. Never unset: an order once mixed stays mixed.
 */
export function setTogether(doc: Y.Doc, folderId: string | null, origin: unknown = null): void {
  const node = folderId === null ? doc.get(WORKSPACE_ROOT) : requireFolder(doc, folderId);
  doc.transact(() => node.setAttr('together', true), origin);
}

/**
 * Adds a note to the registry (idempotent: an existing entry is left alone).
 * Two devices registering the same note concurrently each create an entry
 * node; one wins whole, so the note keeps one consistent folder and position
 * (the other device's choice is lost, which is acceptable for a first filing).
 */
export function registerNote(
  doc: Y.Doc,
  note: { id: string; folderId: string | null; position?: string },
  origin: unknown = null,
): void {
  if (child(doc, WORKSPACE_NOTES, note.id)) return;
  const position = note.position ?? endPosition(doc, note.folderId, 'notes');
  doc.transact(() => {
    const node = new Y.Node();
    doc.get(WORKSPACE_NOTES).setAttr(note.id, node);
    node.setAttr('folder', note.folderId);
    node.setAttr('position', position);
  }, origin);
}

export function moveNote(
  doc: Y.Doc,
  noteId: string,
  folderId: string | null,
  position: string,
  origin: unknown = null,
): void {
  const node = child(doc, WORKSPACE_NOTES, noteId);
  if (!node) throw new WorkspaceError('No such note');
  if (folderId !== null) requireFolder(doc, folderId);
  doc.transact(() => {
    node.setAttr('folder', folderId);
    node.setAttr('position', position);
  }, origin);
}

export function unregisterNote(doc: Y.Doc, noteId: string, origin: unknown = null): void {
  doc.transact(() => doc.get(WORKSPACE_NOTES).deleteAttr(noteId), origin);
}

const settingKey = (userId: string, key: string) => `${userId}/${key}`;

export function readSettings(doc: Y.Doc, userId: string): Record<string, unknown> {
  const prefix = settingKey(userId, '');
  const settings: Record<string, unknown> = {};
  for (const [name, value] of doc.get(WORKSPACE_SETTINGS).attrEntries()) {
    const id = String(name);
    if (id.startsWith(prefix) && !(value instanceof Y.Node))
      settings[id.slice(prefix.length)] = value;
  }
  return settings;
}

/** Sets one per-user setting (undefined removes it). Each key merges on its own. */
export function setSetting(
  doc: Y.Doc,
  userId: string,
  key: string,
  value: unknown,
  origin: unknown = null,
): void {
  if (userId.includes('/')) throw new WorkspaceError('Invalid user id');
  const settings = doc.get(WORKSPACE_SETTINGS);
  doc.transact(() => {
    if (value === undefined) settings.deleteAttr(settingKey(userId, key));
    else settings.setAttr(settingKey(userId, key), value);
  }, origin);
}

function requireFolder(doc: Y.Doc, id: string): Y.Node {
  const node = child(doc, WORKSPACE_FOLDERS, id);
  if (!node) throw new WorkspaceError('No such folder');
  return node;
}
