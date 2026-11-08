/**
 * Agent activity for git notebooks (#172, A920): the server's Agent activity (T42, A561) without
 * a server. What an agent changed in the notebook's folders, note places and settings is read
 * from the branch: each commit whose `Penmoss-Writer` trailer names an agent writer (A825) and
 * that touched the workspace logs is one entry, as each of its syncs is one version in a note's
 * History (A858). Its change is the workspace merged from every writer's log at the commit
 * against the same at its parent: a commit only ever writes its own writer's log, and pushes are
 * fast-forwards, so that is exactly what the agent did.
 *
 * Undo is the server's inverse (`applyInverse`): each part is applied only while things are as
 * the agent left them, else 409 `changed_since` and nothing changes; all of an entry or none. It
 * is an ordinary change to the live WorkspaceDoc by the person, which the next sync commits:
 * history is never rewritten, and nothing of a purge is touched (a note deleted for good is "in
 * Trash or gone"; `purged` is never written). An entry undone is marked in the WorkspaceDoc
 * (`agentUndone`), so every device shows it undone. Notes' edits, their tags and Trash moves are
 * versions in each note's History, where Revert this edit undoes an agent's (A81, A858), as on
 * the server (A566, A574).
 *
 * The answers have the server's shapes (`GET /api/agent-activity`, `POST …/:id/undo`); ids are
 * whole numbers made from the commit (its first 13 hex digits), the same on every clone.
 */
import { folderPath, isWithin, type FolderRecord, type SortMode } from '@penmoss/core/workspace';
import {
  deleteFolder,
  moveFolder,
  moveNote,
  readFolderTrash,
  readSettings,
  readWorkspace,
  renameFolder,
  restoreFolder,
  setSetting,
  setSortMode,
  FOLDER_TRASH_DAYS,
  type TrashedFolder,
  type WorkspaceSnapshot,
} from '@penmoss/sync-client/workspace';
import { readTitle } from '@penmoss/sync-client/note';
import * as Y from '@y/y';
import { commitWriter } from './history';
import type { Layout } from './layout';
import { isPurged, purgedIds } from './purge';
import type { CommitInfo, GitTransport } from './transport';
import { contentIds, grownBy, isUpdate, mergeUpdates } from './yjs';

/** As the server keeps them (A561). */
export const ACTIVITY_DAYS = 30;
export const ACTIVITY_LIST_MAX = 500;
/** The most workspace commits read back for the list. */
const LOG_LIMIT = 1000;
/** The WorkspaceDoc root that marks entries undone: commit → `{ at, by }`. */
export const WORKSPACE_AGENT_UNDONE = 'agentUndone';
/** The notebook's own settings (A827), as `NotebookOps` keeps them. */
const SETTINGS_USER = 'notebook';

export type ActivityKind =
  | 'folder.create'
  | 'folder.rename'
  | 'folder.move'
  | 'folder.reorder'
  | 'folder.sort'
  | 'folder.delete'
  | 'root.sort'
  | 'note.move'
  | 'note.reorder'
  | 'settings';

/** `GET /api/agent-activity`'s entries, as the server's. */
export interface ActivityEntry {
  readonly id: number;
  readonly at: number;
  readonly actor: { readonly id: string; readonly label: string };
  readonly kinds: readonly ActivityKind[];
  readonly summary: string;
  readonly undoneAt: number | null;
  readonly undoneBy: string | null;
}

export type UndoResult =
  | { readonly ok: true; readonly alreadyUndone: boolean; readonly notice: string | null }
  | {
      readonly ok: false;
      readonly status: 404 | 409 | 422;
      readonly code: string;
      readonly message: string;
    };

type Inverse =
  | { readonly op: 'deleteFolder'; readonly id: string; readonly name: string }
  | {
      readonly op: 'folder';
      readonly id: string;
      readonly name?: { readonly now: string; readonly back: string };
      readonly place?: {
        readonly nowParent: string | null;
        readonly nowPosition: string;
        readonly backParent: string | null;
        readonly backPosition: string;
      };
      readonly sort?: { readonly now: SortMode; readonly back: SortMode };
    }
  | { readonly op: 'rootSort'; readonly now: SortMode; readonly back: SortMode }
  | {
      readonly op: 'noteMove';
      readonly id: string;
      readonly title: string;
      readonly nowFolder: string | null;
      readonly nowPosition: string;
      readonly backFolder: string | null;
      readonly backPosition: string;
    }
  | { readonly op: 'restoreFolder'; readonly id: string; readonly name: string }
  | {
      readonly op: 'settings';
      readonly set: Record<string, unknown>;
      readonly base: Record<string, unknown>;
    };

interface Change {
  readonly entry: ActivityEntry;
  readonly commit: string;
  readonly inverses: readonly Inverse[];
}

const changedSince = (message: string): UndoResult => ({
  ok: false,
  status: 409,
  code: 'changed_since',
  message: `${message} Nothing was undone.`,
});

/** A setting's value for a summary: short and readable (the server's `shownValue`). */
function shownValue(value: unknown): string {
  if (value === null || value === undefined) return 'its default';
  const text = typeof value === 'string' ? `“${value}”` : JSON.stringify(value);
  return text.length > 60 ? `${text.slice(0, 57)}…` : text;
}

/** An entry's id: the commit's first 13 hex digits, a whole number below 2^53. */
export const activityId = (commit: string): number => Number.parseInt(commit.slice(0, 13), 16);

/**
 * Who undid which commit's change, and when (`agentUndone`), as marked: believed only when
 * nothing of the change is left to undo (`leftToUndo`, #174 delta review).
 */
function undoneOf(live: Y.Doc, commit: string): { at: number; by: string } | null {
  const value: unknown = live.get(WORKSPACE_AGENT_UNDONE).getAttr(commit);
  if (typeof value !== 'object' || value === null) return null;
  const { at, by } = value as { at?: unknown; by?: unknown };
  return typeof at === 'number' && typeof by === 'string' ? { at, by } : null;
}

/** A commit's workspace as `changesOf` reads it, decoded once (#174 merge check). */
interface Reading {
  readonly workspace: WorkspaceSnapshot;
  readonly settings: Record<string, unknown>;
  /** Folders in Trash at the commit (each with when), however long ago. */
  readonly trash: readonly TrashedFolder[];
  /** Notes deleted for good at the commit (A828). */
  readonly purged: ReadonlySet<string>;
}

function readingOf(doc: Y.Doc): Reading {
  return {
    workspace: readWorkspace(doc),
    settings: readSettings(doc, SETTINGS_USER),
    // Every entry, whenever deleted: `changesOf` keeps those in Trash at the change's time.
    trash: readFolderTrash(doc, Number.NEGATIVE_INFINITY),
    purged: purgedIds(doc),
  };
}

/**
 * The workspace at one commit, kept to read the next one from (#174 merge check): the files
 * under `workspace/` by blob id, the updates among them, and the document they make.
 */
interface Cursor {
  readonly commit: string;
  readonly doc: Y.Doc;
  readonly oids: ReadonlyMap<string, string>;
  readonly parts: ReadonlyMap<string, Part>;
  readonly reading: Reading;
}

/** One writer's file, an update, with its content ids. */
interface Part {
  readonly bytes: Uint8Array;
  readonly ids: Y.ContentIds;
}

/**
 * What the files `now` add to the files `was` (#174 merge check): for each changed one only what
 * it gained, for each new one all of it. Null when one lost something or is gone (a purge took a
 * file out, or `now` is an older commit's): the workspace is then made again from every file.
 */
function addedSince(
  was: ReadonlyMap<string, Part>,
  now: ReadonlyMap<string, Part>,
): Uint8Array[] | null {
  const added: Uint8Array[] = [];
  for (const [path, before] of was) {
    const after = now.get(path);
    if (after === before) continue;
    const grown = after ? grownBy(after.bytes, after.ids, before.ids) : null;
    if (!grown) return null;
    added.push(grown);
  }
  for (const [path, part] of now) if (!was.has(path)) added.push(part.bytes);
  return added;
}

/** What one agent commit changed, kept by commit, with the titles it was worded with. */
interface Derived {
  readonly kinds: ActivityKind[];
  readonly parts: string[];
  readonly inverses: Inverse[];
  readonly titles: ReadonlyMap<string, string>;
}

/** What one commit of an agent changed, as the server records it, with each part's inverse. */
function changesOf(
  before: Reading,
  after: Reading,
  at: number,
  titles: ReadonlyMap<string, string>,
): { kinds: ActivityKind[]; parts: string[]; inverses: Inverse[] } {
  const was = before.workspace;
  const now = after.workspace;
  const kinds: ActivityKind[] = [];
  const parts: string[] = [];
  const inverses: Inverse[] = [];
  const wasFolder = new Map(was.folders.map((folder) => [folder.id, folder]));
  const nowFolder = new Map(now.folders.map((folder) => [folder.id, folder]));
  const named = (snapshot: WorkspaceSnapshot, id: string | null) =>
    id === null ? 'the top level' : `“${folderPath(snapshot.folders, id) ?? id}”`;

  // Made: a folder at the commit that was not there before.
  for (const folder of now.folders) {
    if (wasFolder.has(folder.id)) continue;
    kinds.push('folder.create');
    parts.push(`Made the folder ${named(now, folder.id)}`);
    inverses.push({ op: 'deleteFolder', id: folder.id, name: folder.name });
  }
  // Renamed, moved, reordered, sorted.
  for (const after of now.folders) {
    const before = wasFolder.get(after.id);
    if (!before) continue;
    const renamed = before.name !== after.name;
    const moved = before.parentId !== after.parentId;
    const reordered = !moved && before.position !== after.position;
    const sorted = before.sortMode !== after.sortMode;
    if (!renamed && !moved && !reordered && !sorted) continue;
    if (renamed) {
      kinds.push('folder.rename');
      parts.push(`Renamed the folder “${before.name}” to “${after.name}”`);
    }
    if (moved) {
      kinds.push('folder.move');
      parts.push(`Moved the folder “${after.name}” into ${named(now, after.parentId)}`);
    }
    if (reordered) {
      kinds.push('folder.reorder');
      parts.push(`Reordered the folder “${after.name}”`);
    }
    if (sorted) {
      kinds.push('folder.sort');
      parts.push(`Sorted the folder “${after.name}” by ${after.sortMode}`);
    }
    inverses.push({
      op: 'folder',
      id: after.id,
      ...(renamed ? { name: { now: after.name, back: before.name } } : {}),
      ...(moved || reordered
        ? {
            place: {
              nowParent: after.parentId,
              nowPosition: after.position,
              backParent: before.parentId,
              backPosition: before.position,
            },
          }
        : {}),
      ...(sorted ? { sort: { now: after.sortMode, back: before.sortMode } } : {}),
    });
  }
  if (was.rootSortMode !== now.rootSortMode) {
    kinds.push('root.sort');
    parts.push(`Sorted the top level by ${now.rootSortMode}`);
    inverses.push({ op: 'rootSort', now: now.rootSortMode, back: was.rootSortMode });
  }
  // Moved and reordered notes: not those a deleted folder moved up (its Restore puts them back),
  // nor notes filed or taken out (made, to Trash, deleted for good: History's or Trash's).
  const gone = new Set(was.folders.filter((f) => !nowFolder.has(f.id)).map((f) => f.id));
  const wasNote = new Map(was.notes.map((note) => [note.id, note]));
  for (const after of now.notes) {
    const before = wasNote.get(after.id);
    if (!before || (before.folderId !== null && gone.has(before.folderId))) continue;
    if (before.folderId === after.folderId && before.position === after.position) continue;
    const title = titles.get(after.id)?.trim() || 'Untitled';
    const moved = before.folderId !== after.folderId;
    kinds.push(moved ? 'note.move' : 'note.reorder');
    parts.push(
      moved
        ? `Moved “${title}” from ${named(was, before.folderId)} to ${named(now, after.folderId)}`
        : `Reordered “${title}” in ${named(now, after.folderId)}`,
    );
    inverses.push({
      op: 'noteMove',
      id: after.id,
      title,
      nowFolder: after.folderId,
      nowPosition: after.position,
      backFolder: before.folderId,
      backPosition: before.position,
    });
  }
  // Settings: the notebook's own (A827).
  const wasSettings = before.settings;
  const nowSettings = after.settings;
  const keys = [...new Set([...Object.keys(wasSettings), ...Object.keys(nowSettings)])].sort();
  const written = keys.filter(
    (key) => JSON.stringify(wasSettings[key] ?? null) !== JSON.stringify(nowSettings[key] ?? null),
  );
  if (written.length > 0) {
    kinds.push('settings');
    parts.push(written.map((key) => `Set ${key} to ${shownValue(nowSettings[key])}`).join('; '));
    inverses.push({
      op: 'settings',
      set: Object.fromEntries(written.map((key) => [key, wasSettings[key] ?? null])),
      base: Object.fromEntries(written.map((key) => [key, nowSettings[key] ?? null])),
    });
  }
  // Deleted: only the top one of a deleted tree (its subfolders went to Trash with it).
  const trashed = new Set(
    after.trash
      .filter((entry) => at - entry.deletedAt <= FOLDER_TRASH_DAYS * 24 * 60 * 60 * 1000)
      .map((entry) => entry.id),
  );
  for (const folder of was.folders) {
    if (!gone.has(folder.id) || (folder.parentId !== null && gone.has(folder.parentId))) continue;
    kinds.push('folder.delete');
    parts.push(
      trashed.has(folder.id)
        ? `Deleted the folder ${named(was, folder.id)} (it is in Trash)`
        : `Deleted the folder ${named(was, folder.id)}`,
    );
    inverses.push({ op: 'restoreFolder', id: folder.id, name: folder.name });
  }
  return { kinds, parts, inverses };
}

/** The order an entry's parts are undone in: notes back first, then folders, made ones last. */
const ORDER: Record<Inverse['op'], number> = {
  noteMove: 0,
  restoreFolder: 1,
  folder: 2,
  rootSort: 3,
  settings: 4,
  deleteFolder: 5,
};

/**
 * Applies `inverses` to `doc`, checking each against `doc` as the ones before left it; the first
 * that cannot be applied says why. Run on a copy first, so a refusal changes nothing.
 */
function applyInverses(
  doc: Y.Doc,
  inverses: readonly Inverse[],
  at: number,
  /** Deleted for good here or at head (A828): never filed again, only said (#174 review). */
  purged: ReadonlySet<string>,
): {
  readonly refused: UndoResult | null;
  readonly notices: string[];
  readonly keptOut: string[];
} {
  const notices: string[] = [];
  const keptOut: string[] = [];
  const gone = (id: string) => purged.has(id) || isPurged(doc, id);
  const sorted = [...inverses].sort((a, b) => ORDER[a.op] - ORDER[b.op]);
  // One read of the workspace while only notes move (each moves itself alone), read again
  // before anything else (#174 merge check: an undo of 100 moves read it 100 times).
  let snapshot = readWorkspace(doc);
  let notesById = new Map(snapshot.notes.map((note) => [note.id, note]));
  let notesMoved = false;
  let otherChanged = false;
  for (const inverse of sorted) {
    if (otherChanged || (notesMoved && inverse.op !== 'noteMove')) {
      snapshot = readWorkspace(doc);
      notesById = new Map(snapshot.notes.map((note) => [note.id, note]));
      notesMoved = otherChanged = false;
    }
    if (inverse.op === 'noteMove') notesMoved = true;
    else otherChanged = true;
    const folderOf = (id: string) => snapshot.folders.find((folder) => folder.id === id);
    switch (inverse.op) {
      case 'deleteFolder': {
        const folder = folderOf(inverse.id);
        if (!folder) {
          // A folder made inside another made one went to Trash with it.
          if (readFolderTrash(doc, at).some((entry) => entry.id === inverse.id)) break;
          return {
            refused: changedSince(`The folder “${inverse.name}” is gone already.`),
            notices,
            keptOut,
          };
        }
        if (folder.name !== inverse.name) {
          return {
            refused: changedSince(
              `The folder “${inverse.name}” was renamed “${folder.name}” since.`,
            ),
            notices,
            keptOut,
          };
        }
        // Made ones inside it go with it; anything else in it keeps it.
        const made = new Set(
          inverses.flatMap((each) => (each.op === 'deleteFolder' ? [each.id] : [])),
        );
        const used =
          snapshot.folders.some(
            (other) =>
              other.parentId === folder.id && !(made.has(other.id) && !hasContent(snapshot, other)),
          ) || snapshot.notes.some((note) => note.folderId === folder.id);
        if (used) {
          return {
            refused: changedSince(
              `The folder “${folder.name}” has notes or folders in it now; delete it yourself if you want it gone.`,
            ),
            notices,
            keptOut,
          };
        }
        deleteFolder(doc, folder.id, null, { now: at });
        break;
      }
      case 'folder': {
        const folder = folderOf(inverse.id);
        if (!folder)
          return { refused: changedSince('The folder is gone (deleted since).'), notices, keptOut };
        if (inverse.name && folder.name !== inverse.name.now) {
          return {
            refused: changedSince(
              `The folder “${inverse.name.now}” was renamed “${folder.name}” since.`,
            ),
            notices,
            keptOut,
          };
        }
        const place = inverse.place;
        if (
          place &&
          (folder.parentId !== place.nowParent || folder.position !== place.nowPosition)
        ) {
          return {
            refused: changedSince(`The folder “${folder.name}” was moved since.`),
            notices,
            keptOut,
          };
        }
        if (inverse.sort && folder.sortMode !== inverse.sort.now) {
          return {
            refused: changedSince(`The folder “${folder.name}” was sorted differently since.`),
            notices,
            keptOut,
          };
        }
        if (place && place.backParent !== null && !folderOf(place.backParent)) {
          return {
            refused: changedSince(`The folder that “${folder.name}” was in is gone.`),
            notices,
            keptOut,
          };
        }
        if (place && isWithin(snapshot.folders, place.backParent, folder.id)) {
          return {
            refused: changedSince(
              `Moving “${folder.name}” back would put it inside one of its own subfolders.`,
            ),
            notices,
            keptOut,
          };
        }
        if (inverse.name) renameFolder(doc, folder.id, inverse.name.back);
        if (place) moveFolder(doc, folder.id, place.backParent, place.backPosition);
        if (inverse.sort) setSortMode(doc, folder.id, inverse.sort.back);
        break;
      }
      case 'rootSort': {
        if (snapshot.rootSortMode !== inverse.now) {
          return {
            refused: changedSince('The top level was sorted differently since.'),
            notices,
            keptOut,
          };
        }
        setSortMode(doc, null, inverse.back);
        break;
      }
      case 'noteMove': {
        // Deleted for good (A828): never filed again; the rest of the undo goes on.
        if (gone(inverse.id)) {
          keptOut.push(inverse.id);
          break;
        }
        const note = notesById.get(inverse.id);
        // In Trash: never filed again from here.
        if (!note) {
          return {
            refused: changedSince(`“${inverse.title}” is in Trash or gone.`),
            notices,
            keptOut,
          };
        }
        if (note.folderId !== inverse.nowFolder || note.position !== inverse.nowPosition) {
          return { refused: changedSince(`“${inverse.title}” was moved since.`), notices, keptOut };
        }
        if (inverse.backFolder !== null && !folderOf(inverse.backFolder)) {
          return {
            refused: changedSince(`The folder “${inverse.title}” was in is gone.`),
            notices,
            keptOut,
          };
        }
        moveNote(doc, inverse.id, inverse.backFolder, inverse.backPosition);
        break;
      }
      case 'restoreFolder': {
        if (folderOf(inverse.id)) {
          notices.push(`“${inverse.name}” is back already.`);
          break;
        }
        if (!readFolderTrash(doc, at).some((entry) => entry.id === inverse.id)) {
          return {
            refused: changedSince(`“${inverse.name}” is no longer in Trash.`),
            notices,
            keptOut,
          };
        }
        // Notes deleted for good since are not in the tree: Restore skips them (never filed again).
        const restored = restoreFolder(doc, inverse.id, null, { keepOut: gone });
        keptOut.push(...(restored.keptOut ?? []));
        if (restored.refused || !restored.restored) {
          return {
            refused: changedSince(`“${inverse.name}” cannot come back where it was.`),
            notices,
            keptOut,
          };
        }
        const said: string[] = [];
        if (restored.parentGone)
          said.push('the folder it was in is gone, so it is at the top level');
        if (restored.skipped.length > 0) {
          const one = restored.skipped.length === 1;
          said.push(
            `${restored.skipped.length} ${one ? 'note was' : 'notes were'} moved or deleted since and stayed where ${one ? 'it is' : 'they are'}`,
          );
        }
        if (said.length > 0) notices.push(`Restored “${inverse.name}”: ${said.join('; ')}.`);
        break;
      }
      case 'settings': {
        const live = readSettings(doc, SETTINGS_USER);
        const moved = Object.keys(inverse.base).filter(
          (key) => JSON.stringify(live[key] ?? null) !== JSON.stringify(inverse.base[key] ?? null),
        );
        if (moved.length > 0) {
          return {
            refused: changedSince(`Changed again since: ${moved.join(', ')}.`),
            notices,
            keptOut,
          };
        }
        for (const [key, value] of Object.entries(inverse.set)) {
          setSetting(doc, SETTINGS_USER, key, value === null ? undefined : value);
        }
        break;
      }
    }
  }
  return { refused: null, notices, keptOut };
}

/**
 * The live workspace as one read-only snapshot (#174 merge check): read once per list or undo,
 * so checking a mark decodes nothing per part.
 */
interface LiveView {
  readonly folders: ReadonlyMap<string, FolderRecord>;
  readonly notes: ReadonlyMap<
    string,
    { readonly folderId: string | null; readonly position: string }
  >;
  /** Notes directly in each folder (null: the top level). */
  readonly notesIn: ReadonlyMap<string | null, number>;
  /** Folders directly in each folder. */
  readonly foldersIn: ReadonlyMap<string | null, readonly FolderRecord[]>;
  readonly rootSortMode: SortMode;
  readonly trashedFolders: ReadonlySet<string>;
  readonly settings: Readonly<Record<string, unknown>>;
  /** Deleted for good here or at head. */
  readonly purged: ReadonlySet<string>;
}

function liveView(live: Y.Doc, at: number, purged: ReadonlySet<string>): LiveView {
  const snapshot = readWorkspace(live);
  const notesIn = new Map<string | null, number>();
  for (const note of snapshot.notes)
    notesIn.set(note.folderId, (notesIn.get(note.folderId) ?? 0) + 1);
  const foldersIn = new Map<string | null, FolderRecord[]>();
  for (const folder of snapshot.folders) {
    const list = foldersIn.get(folder.parentId) ?? [];
    list.push(folder);
    foldersIn.set(folder.parentId, list);
  }
  return {
    folders: new Map(snapshot.folders.map((folder) => [folder.id, folder])),
    notes: new Map(snapshot.notes.map((note) => [note.id, note])),
    notesIn,
    foldersIn,
    rootSortMode: snapshot.rootSortMode,
    trashedFolders: new Set(readFolderTrash(live, at).map((entry) => entry.id)),
    settings: readSettings(live, SETTINGS_USER),
    purged,
  };
}

/** Bytes as hex, for a cache key. */
function hex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

/** Whether `folder` is inside `ancestor` (or is it), by the view's parents. */
function within(view: LiveView, ancestor: string | null, folder: string): boolean {
  for (let at = ancestor, steps = 0; at !== null && steps <= view.folders.size; steps++) {
    if (at === folder) return true;
    at = view.folders.get(at)?.parentId ?? null;
  }
  return false;
}

/**
 * Whether one part of an undo would still change something: it is as the agent left it and
 * its inverse would apply (`applyInverses`' own conditions, read from the view). Where that
 * cannot be told for sure (a folder restore), it counts as left: a mark is believed only when
 * nothing is.
 */
function partLeft(view: LiveView, inverse: Inverse, inverses: readonly Inverse[]): boolean {
  switch (inverse.op) {
    case 'deleteFolder': {
      const folder = view.folders.get(inverse.id);
      if (!folder || folder.name !== inverse.name) return false;
      const made = new Set(
        inverses.flatMap((each) => (each.op === 'deleteFolder' ? [each.id] : [])),
      );
      const usedBy = (view.foldersIn.get(folder.id) ?? []).some(
        (other) =>
          !(
            made.has(other.id) &&
            (view.notesIn.get(other.id) ?? 0) === 0 &&
            !view.foldersIn.get(other.id)?.length
          ),
      );
      return !usedBy && (view.notesIn.get(folder.id) ?? 0) === 0;
    }
    case 'folder': {
      const folder = view.folders.get(inverse.id);
      if (!folder) return false;
      if (inverse.name && folder.name !== inverse.name.now) return false;
      const place = inverse.place;
      if (place && (folder.parentId !== place.nowParent || folder.position !== place.nowPosition)) {
        return false;
      }
      if (inverse.sort && folder.sortMode !== inverse.sort.now) return false;
      if (place && place.backParent !== null && !view.folders.has(place.backParent)) return false;
      if (place && within(view, place.backParent, folder.id)) return false;
      return (
        (inverse.name !== undefined && inverse.name.now !== inverse.name.back) ||
        (place !== undefined &&
          (place.nowParent !== place.backParent || place.nowPosition !== place.backPosition)) ||
        (inverse.sort !== undefined && inverse.sort.now !== inverse.sort.back)
      );
    }
    case 'rootSort':
      return view.rootSortMode === inverse.now && inverse.now !== inverse.back;
    case 'noteMove': {
      if (view.purged.has(inverse.id)) return false;
      const note = view.notes.get(inverse.id);
      if (!note || note.folderId !== inverse.nowFolder || note.position !== inverse.nowPosition) {
        return false;
      }
      if (inverse.backFolder !== null && !view.folders.has(inverse.backFolder)) return false;
      return (
        inverse.nowFolder !== inverse.backFolder || inverse.nowPosition !== inverse.backPosition
      );
    }
    case 'restoreFolder':
      return !view.folders.has(inverse.id) && view.trashedFolders.has(inverse.id);
    case 'settings': {
      const same = (key: string, value: unknown) =>
        JSON.stringify(view.settings[key] ?? null) === JSON.stringify(value ?? null);
      if (!Object.keys(inverse.base).every((key) => same(key, inverse.base[key]))) return false;
      return Object.entries(inverse.set).some(([key, value]) => !same(key, value));
    }
  }
}

/**
 * Whether undoing `inverses` would still change something (#174 delta review): one part that
 * is as the agent left it is enough. An entry's `agentUndone` mark counts only when nothing is:
 * an agent can write a mark (its own, "by Ryan") into its log, so the mark alone never says a
 * change was undone. Checked against one snapshot (#174 merge check), nothing decoded per part.
 */
function leftToUndo(view: LiveView, inverses: readonly Inverse[]): boolean {
  return inverses.some((inverse) => partLeft(view, inverse, inverses));
}

function hasContent(snapshot: WorkspaceSnapshot, folder: FolderRecord): boolean {
  return (
    snapshot.notes.some((note) => note.folderId === folder.id) ||
    snapshot.folders.some((other) => other.parentId === folder.id)
  );
}

export class AgentActivity {
  /**
   * The workspace at the commit read last (#174 merge check). A list reads its commits oldest
   * first, and between two of them most writers' files are the same blobs (an agent's commit
   * writes only its own log, A821): only the files that changed are read and applied, never the
   * whole workspace decoded again per commit.
   */
  private cursor: Cursor | null = null;
  /** The cursor's moves, one at a time: two lists at once never interleave on its document. */
  private queue: Promise<unknown> = Promise.resolve();
  /**
   * Whether a marked commit's change is left to undo, by the live workspace's state (its state
   * vector and what is purged): the same list asked again checks nothing (#174 merge check).
   */
  private readonly marksChecked = new Map<string, Map<string, boolean>>();
  /** Each agent commit's change, by commit, with the titles it was worded with. */
  private readonly derived = new Map<string, Derived>();

  private remember(state: string, commit: string, left: boolean): void {
    let byCommit = this.marksChecked.get(state);
    if (!byCommit) {
      // Only the newest state is asked about again; an older one never is.
      this.marksChecked.clear();
      byCommit = new Map();
      this.marksChecked.set(state, byCommit);
    }
    byCommit.set(commit, left);
  }

  constructor(
    private readonly transport: Pick<GitTransport, 'log' | 'list' | 'read'>,
    private readonly layout: Layout,
    /** A note's title for the summaries (the live replica's); null: "Untitled". */
    private readonly titleOf: (noteId: string) => string | null = () => null,
  ) {}

  private serially<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /**
   * The workspace as every writer's file had it at `commit`, read from the cursor (#174 merge
   * check): only the files whose blob changed since the cursor's commit are read. When each of
   * those holds all it held (a writer's file only grows, A821) and none is gone, they are applied
   * over the cursor's document, which is then exactly the workspace at `commit`; else (a purge
   * that took a file out, a step back to an older commit) it is made again from every file.
   */
  private async moveTo(commit: string): Promise<Reading> {
    const cursor = this.cursor;
    if (cursor?.commit === commit) return cursor.reading;
    const dir = `${this.layout.base}workspace/`;
    const oids = new Map(
      [...(await this.transport.list(commit))].filter(([path]) => path.startsWith(dir)),
    );
    const changed = [...oids.keys()].filter((path) => cursor?.oids.get(path) !== oids.get(path));
    // Every update at `commit`: the cursor's own for a blob it has (a file gone is not), else
    // read now.
    const parts = new Map<string, Part>();
    for (const [path, part] of cursor?.parts ?? []) {
      if (cursor?.oids.get(path) === oids.get(path)) parts.set(path, part);
    }
    if (changed.length > 0) {
      for (const [path, bytes] of await this.transport.read(commit, changed)) {
        // Its content ids say whether it is an update at all (as `isUpdate`), in the same decode.
        const ids = contentIds(bytes);
        if (ids) parts.set(path, { bytes, ids });
      }
    }
    const added = cursor ? addedSince(cursor.parts, parts) : null;
    const doc = cursor && added ? cursor.doc : new Y.Doc();
    if (doc !== cursor?.doc) cursor?.doc.destroy();
    // Until the document is all of `commit`, there is no cursor: one that failed half way is
    // never read from again.
    this.cursor = null;
    try {
      // One by one in one transaction: the document their merge makes, without merging first.
      doc.transact(() => {
        for (const bytes of added ?? [...parts.values()].map((part) => part.bytes)) {
          Y.applyUpdate(doc, bytes);
        }
      });
      const reading = readingOf(doc);
      this.cursor = { commit, doc, oids, parts, reading };
      return reading;
    } catch (error) {
      doc.destroy();
      throw error;
    }
  }

  /** The notes deleted for good at the newest commit that changed the workspace. */
  private async purgedAtHead(readings: Map<string, Reading> = new Map()): Promise<Set<string>> {
    const [newest] = await this.transport.log({
      paths: [`${this.layout.base}workspace/`],
      limit: 1,
    });
    if (!newest) return new Set();
    return new Set((await this.readingAt(newest.id, readings)).purged);
  }

  /** A note's title: the live replica's, else as the branch had it at `commit`. */
  private async titleAt(commit: string, noteId: string): Promise<string | null> {
    const known = this.titleOf(noteId);
    if (known !== null) return known;
    const dir = this.layout.noteDir(noteId);
    const files = await this.transport.list(commit);
    const paths = [...files.keys()].filter((path) => path.startsWith(dir));
    if (paths.length === 0) return null;
    const parts = [...(await this.transport.read(commit, paths)).values()].filter(isUpdate);
    if (parts.length === 0) return null;
    const doc = new Y.Doc();
    try {
      Y.applyUpdate(doc, mergeUpdates(parts));
      return readTitle(doc) || null;
    } finally {
      doc.destroy();
    }
  }

  /**
   * What one agent commit changed, as kept (#174 merge check): a commit never changes, so only
   * the titles it names are checked again, against this device's notes. Null when it was never
   * read, or one of those notes was renamed since.
   */
  private kept(commit: string): Derived | null {
    const kept = this.derived.get(commit);
    return kept && [...kept.titles].every(([id, title]) => (this.titleOf(id) ?? title) === title)
      ? kept
      : null;
  }

  /** What one agent commit changed (its kinds, words and inverses), read from the branch and kept. */
  private async changeOf(
    commit: CommitInfo,
    /** This list's readings by commit: a parent is the commit after it's, decoded once. */
    readings: Map<string, Reading>,
  ): Promise<Derived> {
    // One after the other: both move the one cursor.
    const before = await this.readingAt(commit.parents[0] ?? null, readings);
    const after = await this.readingAt(commit.id, readings);
    const titles = await this.titlesOf(before, after, commit.id);
    const change = { ...changesOf(before, after, commit.at, titles), titles };
    this.derived.set(commit.id, change);
    return change;
  }

  /** A commit's workspace, read once for this list. */
  private async readingAt(commit: string | null, readings: Map<string, Reading>): Promise<Reading> {
    const key = commit ?? '';
    const known = readings.get(key);
    if (known) return known;
    let reading: Reading;
    if (commit === null) {
      const doc = new Y.Doc();
      reading = readingOf(doc);
      doc.destroy();
    } else {
      reading = await this.serially(() => this.moveTo(commit));
    }
    readings.set(key, reading);
    return reading;
  }

  /** The titles of the notes `after` moved: the live replica's, else the note's at `commit`. */
  private async titlesOf(
    before: Reading,
    after: Reading,
    commit: string,
  ): Promise<Map<string, string>> {
    const was = new Map(before.workspace.notes.map((note) => [note.id, note]));
    const moved = after.workspace.notes.filter((note) => {
      const old = was.get(note.id);
      return old && (old.folderId !== note.folderId || old.position !== note.position);
    });
    const titles = new Map<string, string>();
    let files: ReadonlyMap<string, string> | null = null;
    for (const note of moved) {
      const known = this.titleOf(note.id);
      if (known !== null) {
        titles.set(note.id, known);
        continue;
      }
      // Not here (deleted for good since, or never opened): as the branch had it then.
      const dir = this.layout.noteDir(note.id);
      files ??= await this.transport.list(commit);
      const paths = [...files.keys()].filter((path) => path.startsWith(dir));
      if (paths.length === 0) continue;
      const parts = [...(await this.transport.read(commit, paths)).values()].filter(isUpdate);
      if (parts.length === 0) continue;
      const doc = new Y.Doc();
      try {
        Y.applyUpdate(doc, mergeUpdates(parts));
        titles.set(note.id, readTitle(doc));
      } finally {
        doc.destroy();
      }
    }
    return titles;
  }

  private async changes(live: Y.Doc, now: number): Promise<Change[]> {
    const since = now - ACTIVITY_DAYS * 24 * 60 * 60 * 1000;
    const commits: readonly CommitInfo[] = await this.transport.log({
      paths: [`${this.layout.base}workspace/`],
      limit: LOG_LIMIT,
    });
    // The agents' commits in the window, newest first, each with its change if kept.
    const agents: { commit: CommitInfo; kept: Derived | null }[] = [];
    for (const commit of commits) {
      if (commit.at < since) break;
      if (commitWriter(commit.message)?.kind !== 'agent') continue;
      agents.push({ commit, kept: this.kept(commit.id) });
    }
    // Those not kept read oldest first, each parent just before its commit, so the cursor only
    // ever moves forward over files that grew (#174 merge check). Past the list's length, a
    // commit is read only if the loop below gets to it.
    const readings = new Map<string, Reading>();
    for (const { commit, kept } of agents.slice(0, ACTIVITY_LIST_MAX).reverse()) {
      if (kept) continue;
      await this.readingAt(commit.parents[0] ?? null, readings);
      await this.readingAt(commit.id, readings);
    }
    const out: Change[] = [];
    // Read once, and only when an entry is marked undone (its mark is checked, never trusted):
    // one snapshot of the live workspace for the whole list (#174 merge check).
    let view: LiveView | null = null;
    let state: string | null = null;
    let purged: ReadonlySet<string> | null = null;
    for (const { commit, kept } of agents) {
      const writer = commitWriter(commit.message)!;
      const { kinds, parts, inverses } = kept ?? (await this.changeOf(commit, readings));
      if (kinds.length === 0) continue;
      {
        const marked = undoneOf(live, commit.id);
        let undone: { at: number; by: string } | null = null;
        if (marked) {
          if (state === null) {
            purged = new Set([...purgedIds(live), ...(await this.purgedAtHead(readings))]);
            state = `${hex(Y.encodeStateVector(live))}:${[...purged].sort().join(',')}`;
          }
          let left = this.marksChecked.get(state)?.get(commit.id);
          if (left === undefined) {
            view ??= liveView(live, now, purged!);
            left = leftToUndo(view, inverses);
            this.remember(state, commit.id, left);
          }
          undone = left ? null : marked;
        }
        out.push({
          commit: commit.id,
          inverses,
          entry: {
            id: activityId(commit.id),
            at: commit.at,
            actor: { id: writer.id, label: writer.label },
            kinds,
            summary: parts.join('; '),
            undoneAt: undone?.at ?? null,
            undoneBy: undone?.by ?? null,
          },
        });
      }
      if (out.length >= ACTIVITY_LIST_MAX) break;
    }
    return out;
  }

  /** The last ACTIVITY_DAYS of agents' changes, newest first. */
  async list(live: Y.Doc, now: number = Date.now()): Promise<{ entries: ActivityEntry[] }> {
    return { entries: (await this.changes(live, now)).map((change) => change.entry) };
  }

  /**
   * Undoes entry `id` in `live`, as a change by `by` (the person's label), all of it or none.
   * The caller's next sync commits it.
   */
  async undo(live: Y.Doc, id: number, by: string, now: number = Date.now()): Promise<UndoResult> {
    const change = (await this.changes(live, now)).find((each) => each.entry.id === id);
    if (!change) {
      return {
        ok: false,
        status: 404,
        code: 'not_found',
        message: 'No such change in the last 30 days',
      };
    }
    if (change.entry.undoneAt !== null) return { ok: true, alreadyUndone: true, notice: null };
    // Deleted for good here (this device's marks, landed or not) or at head (another device's,
    // fetched and not merged yet): those ids are never filed again (A828, #174 review).
    const purged = new Set([...purgedIds(live), ...(await this.purgedAtHead())]);
    // On a copy first: a part that cannot be undone leaves the notebook as it is.
    const trial = new Y.Doc();
    Y.applyUpdate(trial, Y.encodeStateAsUpdate(live));
    let keptOut: readonly string[];
    try {
      const tried = applyInverses(trial, change.inverses, now, purged);
      if (tried.refused) return tried.refused;
      keptOut = tried.keptOut;
    } finally {
      trial.destroy();
    }
    const said = await Promise.all(
      [...new Set(keptOut)].map(
        async (id) =>
          `“${(await this.titleAt(change.commit, id)) ?? 'Untitled'}” is already deleted for good, so it stays deleted.`,
      ),
    );
    let notices: string[] = [];
    live.transact(() => {
      notices = applyInverses(live, change.inverses, now, purged).notices;
      live.get(WORKSPACE_AGENT_UNDONE).setAttr(change.commit, { at: now, by });
    });
    notices = [...notices, ...said];
    return {
      ok: true,
      alreadyUndone: false,
      notice: notices.length > 0 ? notices.join(' ') : null,
    };
  }
}
