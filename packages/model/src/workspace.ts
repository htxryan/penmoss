/**
 * The WorkspaceDoc's Yjs document (A1, T7): folder tree, note registry,
 * ordering and per-user settings. Each folder and note entry is a nested
 * node whose fields merge independently, so a rename on one device and a
 * move on another both survive. Readers build the tree with
 * `@penmoss/core/workspace`, which resolves concurrent-move cycles without
 * writing anything (A17).
 *
 * - `folders`: folderId → { name, parent, position, sortMode, together?, aiDescription? } (`together: true` once
 *   its subfolders and notes share one Manual order, T62 item 6). A `notebook` flag left from
 *   T43's notebooks inside a workspace is ignored (A1449).
 * - `notes`: noteId → { folder, position, path }
 * - `root`: { sortMode, together? } for the top level
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
  folderFallback,
  isWithin,
  keyBetween,
  SORT_MODES,
  type Fallback,
  type FolderRecord,
  type GoneFolder,
  type SortMode,
} from '@penmoss/core/workspace';
import {
  isNotebookSetting,
  isPlatformSetting,
  type SettingsPlatform,
} from '@penmoss/core/settings';
import { journalFolderId, journalLevels, type PeriodKind } from '@penmoss/core/periodic';
import { cleanTagDescription, normaliseTag } from '@penmoss/core/tags';
import * as Y from '@y/y';

export const WORKSPACE_FOLDERS = 'folders';
export const WORKSPACE_NOTES = 'notes';
const WORKSPACE_ROOT = 'root';
const WORKSPACE_SETTINGS = 'settings';
const WORKSPACE_FOLDER_TRASH = 'folderTrash';
/** Each tag's description, by its full path (PEN-68). */
const WORKSPACE_TAG_DESCRIPTIONS = 'tagDescriptions';
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

/** A folder's AI Descriptions value (PEN-161), as a record spreads it: absent for Inherit. */
const aiOf = (value: unknown): { aiDescription?: 'on' | 'off' } =>
  value === 'on' || value === 'off' ? { aiDescription: value } : {};

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
      // Only once a note is placed among its folders (T62 item 6): until then, folders first.
      ...(value.getAttr('together') === true ? { together: true as const } : {}),
      ...aiOf(value.getAttr('aiDescription')),
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
  const described = readTagDescriptions(doc);
  return {
    folders,
    notes,
    rootSortMode: sortMode(root.getAttr('sortMode')),
    ...(root.getAttr('together') === true ? { rootTogether: true as const } : {}),
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
  },
  origin: unknown = null,
): void {
  if (folder.parentId !== null && !child(doc, WORKSPACE_FOLDERS, folder.parentId)) {
    throw new WorkspaceError('The parent folder does not exist');
  }
  const position = folder.position ?? endPosition(doc, folder.parentId, 'folders');
  doc.transact(() => {
    const node = new Y.Node();
    doc.get(WORKSPACE_FOLDERS).setAttr(folder.id, node);
    node.setAttr('name', folder.name);
    node.setAttr('parent', folder.parentId);
    node.setAttr('position', position);
    node.setAttr('sortMode', 'manual');
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
}

interface TrashedFolderRecord {
  readonly id: string;
  readonly name: string;
  readonly parentId: string | null;
  readonly position: string;
  readonly sortMode: SortMode;
  readonly aiDescription?: 'on' | 'off';
}

interface TrashedNoteRecord {
  readonly id: string;
  /** Where it was: the deleted folder or one of its subfolders. */
  readonly folderId: string;
  readonly position: string;
  /** Where the delete put it; a note no longer there was moved since and stays put. */
  readonly movedTo: string | null;
  readonly movedPosition: string;
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
        ...aiOf(item['aiDescription']),
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
      },
    ];
  });
}

/**
 * A Trash record's key for one note it lists beside `notes` (A675): the server listed a note it
 * moved up later under a key of its own. `deleteFolder` writes its notes as one list.
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
 * A Trash record's key for one folder it lists beside `folders` (A757): a folder made on a device
 * under a folder another device deleted, which the server's repair moved up to the nearest folder
 * still there (`movedTo`), or kept in Trash with the record (`trashed`). Read, never written now.
 */
const TRASHED_FOLDER_PREFIX = 'folder:';

interface KeyedFolderRecord extends TrashedFolderRecord {
  /** In Trash with the record's folder; else moved up to `movedTo`. */
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

/** The folders Trash remembers, for `fallbackFolder`: each deleted folder and its subfolders. */
function goneFolders(doc: Y.Doc): GoneFolder[] {
  const out: GoneFolder[] = [];
  for (const [id, value] of doc.get(WORKSPACE_FOLDER_TRASH).attrEntries()) {
    if (!(value instanceof Y.Node)) continue;
    out.push({ id: String(id), parentId: str(value.getAttr('parent')) });
    for (const folder of trashedFoldersOf(value)) {
      out.push({ id: folder.id, parentId: folder.parentId });
    }
  }
  return out;
}

/**
 * Where to file something meant for `folderId`: that folder, else the nearest one above it still
 * in the tree, else the top level; refused when Trash no longer remembers a folder on the way up.
 */
export function fallbackFolder(doc: Y.Doc, folderId: string | null): Fallback {
  return folderFallback(readWorkspace(doc).folders, goneFolders(doc), folderId);
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

/**
 * Deletes a folder and its subfolders. Their notes move up to the deleted folder's parent:
 * deleting a folder never deletes notes. The folder goes to Trash (T42, A560) with its
 * subfolders, their order and sort, and where each note was, so `restoreFolder` can put it
 * all back for FOLDER_TRASH_DAYS. `by` names who deleted it, for the Trash list.
 */
export function deleteFolder(
  doc: Y.Doc,
  id: string,
  origin: unknown = null,
  options: { readonly now?: number; readonly by?: FolderDeleter | null } = {},
): void {
  const snapshot = readWorkspace(doc);
  const target = snapshot.folders.find((folder) => folder.id === id);
  if (!target) throw new WorkspaceError('No such folder');
  const doomed = snapshot.folders.filter((folder) => isWithin(snapshot.folders, folder.id, id));
  const doomedIds = new Set(doomed.map((folder) => folder.id));
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
      const entry = child(doc, WORKSPACE_NOTES, note.id);
      entry?.setAttr('folder', destination);
      entry?.setAttr('position', last);
      notes.push({
        id: note.id,
        folderId: note.folderId ?? id,
        position: note.position,
        movedTo: destination,
        movedPosition: last,
      });
      last = keyBetween(last, null);
    }
    const record = new Y.Node();
    doc.get(WORKSPACE_FOLDER_TRASH).setAttr(id, record);
    record.setAttr('name', target.name);
    record.setAttr('parent', target.parentId);
    record.setAttr('position', target.position);
    record.setAttr('sortMode', target.sortMode);
    if (target.aiDescription) record.setAttr('aiDescription', target.aiDescription);
    record.setAttr('deletedAt', now);
    record.setAttr('deletedBy', options.by?.label ?? null);
    record.setAttr('deletedByKind', options.by?.kind ?? null);
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
          ...(folder.aiDescription ? { aiDescription: folder.aiDescription } : {}),
        })),
    );
    record.setAttr('notes', notes);
    for (const folderId of doomedIds) doc.get(WORKSPACE_FOLDERS).deleteAttr(folderId);
  }, origin);
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
   * The folder it was in is gone, so it came back in the nearest folder above it (`parentId`),
   * or at the top level.
   */
  readonly parentGone: boolean;
  /** Where it came back (null: the top level). */
  readonly parentId?: string | null;
  /** Notes put back where they were. */
  readonly notes: number;
  /** Notes moved, deleted or gone since the delete: they stay where they are now. */
  readonly skipped: readonly string[];
  /**
   * Not restored: the folder it was in is gone and Trash no longer remembers where that was
   * (`fallbackFolder` refused), so no place is known.
   */
  readonly refused?: true;
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
  const nothing = { restored: false, parentGone: false, notes: 0, skipped: [] };
  const record = child(doc, WORKSPACE_FOLDER_TRASH, id);
  if (!record) return nothing;
  const snapshot = readWorkspace(doc);
  const exists = new Set(snapshot.folders.map((folder) => folder.id));
  if (exists.has(id)) {
    doc.transact(() => doc.get(WORKSPACE_FOLDER_TRASH).deleteAttr(id), origin);
    return nothing;
  }
  const recordedParent = str(record.getAttr('parent'));
  const parentGone = recordedParent !== null && !exists.has(recordedParent);
  let parentId = parentGone ? null : recordedParent;
  if (parentGone) {
    const place = folderFallback(snapshot.folders, goneFolders(doc), recordedParent);
    if ('refused' in place) return { ...nothing, refused: true };
    parentId = place.folderId;
  }
  const top: TrashedFolderRecord = {
    id,
    name: str(record.getAttr('name')) ?? 'Untitled folder',
    parentId,
    position: str(record.getAttr('position')) ?? 'a0',
    sortMode: sortMode(record.getAttr('sortMode')),
    ...aiOf(record.getAttr('aiDescription')),
  };
  const subfolders = trashedFoldersOf(record).filter((folder) => !exists.has(folder.id));
  // Folders the server's repair moved up out of this one: back in it, unless moved since.
  const movedUp = keyedFoldersOf(record).filter((folder) => !folder.trashed);
  const coming = new Set([id, ...subfolders.map((folder) => folder.id)]);
  const notes = trashedNotesOf(record);
  const current = new Map(snapshot.notes.map((note) => [note.id, note]));
  let restoredNotes = 0;
  const skipped: string[] = [];
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
      if (folder.aiDescription) node.setAttr('aiDescription', folder.aiDescription);
    }
    for (const note of notes) {
      if (options.keepOut?.(note.id)) {
        keptOut.push(note.id);
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
    parentGone,
    parentId,
    notes: restoredNotes,
    skipped,
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

/** A folder's AI Descriptions value (PEN-161); Inherit removes it. Synced, merged on its own. */
export function setFolderAiDescription(
  doc: Y.Doc,
  folderId: string,
  value: 'inherit' | 'on' | 'off',
  origin: unknown = null,
): void {
  const node = requireFolder(doc, folderId);
  const now: unknown = node.getAttr('aiDescription');
  if ((now ?? 'inherit') === value) return;
  doc.transact(() => {
    if (value === 'inherit') node.deleteAttr('aiDescription');
    else node.setAttr('aiDescription', value);
  }, origin);
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

/**
 * Files a daily or weekly note under `Journal/<year>/<month>` or `Journal/<year>/Weekly` (T19),
 * creating the folders it needs with ids derived from their paths under the notebook's `salt`
 * (A820), so two devices doing this offline make the same folders. A note already filed (by any
 * device) stays where it is.
 */
export function fileJournalNote(
  doc: Y.Doc,
  id: string,
  kind: PeriodKind,
  period: string,
  salt?: string,
): void {
  if (readWorkspace(doc).notes.some((entry) => entry.id === id)) return;
  const levels = journalLevels(kind, period);
  doc.transact(() => {
    let parentId: string | null = null;
    for (let depth = 1; depth <= levels.length; depth++) {
      const folderId = journalFolderId(levels.slice(0, depth).join('/'), salt);
      if (!readWorkspace(doc).folders.some((folder) => folder.id === folderId)) {
        createFolder(doc, { id: folderId, name: levels[depth - 1]!, parentId });
      }
      parentId = folderId;
    }
    registerNote(doc, { id, folderId: parentId });
  });
}

/** The top-level folder captures are filed in (T30). */
export const INBOX = 'Inbox';

/**
 * The Inbox captured notes are filed in (T30): the notebook's own top-level `Inbox` (any case)
 * if there is one, else one made with an id derived from its name under `salt`, so two devices
 * capturing offline make one Inbox. Returns its id.
 */
export function inboxFolder(doc: Y.Doc, salt?: string): string {
  const folders = readWorkspace(doc).folders;
  const own = folders.find(
    (folder) =>
      folder.parentId === null && folder.name.trim().toLowerCase() === INBOX.toLowerCase(),
  );
  if (own) return own.id;
  const id = journalFolderId(INBOX, salt);
  if (!folders.some((folder) => folder.id === id)) {
    createFolder(doc, { id, name: INBOX, parentId: null });
  }
  return id;
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

/** Where a git notebook keeps its own settings (A827: `timeZone`, `template.*`). */
export const NOTEBOOK_MAP = 'notebook';
/** Where a git notebook keeps the settings of the devices that use it (A827, A1014). */
export const DEVICE_MAP = 'device';

/**
 * Where a platform keeps its own copy of the look and layout (PEN-156, A1605): `desktop/<key>` for
 * the Macs and browsers, `mobile/<key>` for the phones, beside the shared `device/<key>`. A null
 * there is that platform's "back to the default", which the shared value doesn't override.
 */
const platformMap = (platform: SettingsPlatform): string => platform;

/**
 * The device map, without the notebook's own keys (a client may once have put one there). With a
 * platform, its own copy of each per-platform key lies over the shared one (A1605): its value, or
 * nothing for its null; a key it has no copy of shows the shared value.
 */
export function deviceSettings(doc: Y.Doc, platform?: SettingsPlatform): Record<string, unknown> {
  const device = readSettings(doc, DEVICE_MAP);
  for (const key of Object.keys(device)) if (isNotebookSetting(key)) delete device[key];
  if (platform === undefined) return device;
  for (const [key, value] of Object.entries(readSettings(doc, platformMap(platform)))) {
    if (!isPlatformSetting(key)) continue;
    if (value === null) delete device[key];
    else device[key] = value;
  }
  return device;
}

/** The settings as every client reads them: the device's, with the notebook's own over them. */
export function mergedSettings(doc: Y.Doc, platform?: SettingsPlatform): Record<string, unknown> {
  const notebook = readSettings(doc, NOTEBOOK_MAP);
  for (const key of Object.keys(notebook)) if (!isNotebookSetting(key)) delete notebook[key];
  return { ...deviceSettings(doc, platform), ...notebook };
}

/**
 * Sets one setting in the map it belongs to (undefined removes it). With a platform, a
 * per-platform key goes to that platform's own copy and the shared value stays as it is (A1605);
 * undefined there is kept as null, so the default shows on this platform whatever the shared
 * value is.
 */
export function writeSetting(
  doc: Y.Doc,
  key: string,
  value: unknown,
  origin: unknown = null,
  platform?: SettingsPlatform,
): void {
  if (platform !== undefined && isPlatformSetting(key)) {
    setSetting(doc, platformMap(platform), key, value === undefined ? null : value, origin);
    return;
  }
  setSetting(doc, isNotebookSetting(key) ? NOTEBOOK_MAP : DEVICE_MAP, key, value, origin);
}

function requireFolder(doc: Y.Doc, id: string): Y.Node {
  const node = child(doc, WORKSPACE_FOLDERS, id);
  if (!node) throw new WorkspaceError('No such folder');
  return node;
}
