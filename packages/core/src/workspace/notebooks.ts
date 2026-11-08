/**
 * Notebooks (T43, D42, A750–A756): a level above folders inside the one
 * workspace. A notebook is a top-level folder flagged `notebook: true` in the
 * WorkspaceDoc (A750); everything else (top-level notes and every folder that
 * is not in a notebook) is the default notebook (A751). These rules are read
 * the same way by every client and by the server, as the folder tree is
 * (A17): reading never writes a repair.
 *
 * - A note or folder belongs to the outermost flagged folder above it (or to
 *   itself, for a notebook's own folder). Notebooks only ever sit at the top
 *   level, and every client refuses a move that would nest one; should a
 *   concurrent move nest one anyway, its notes still count as a notebook's
 *   (the outer one's, when it lands inside another), never as the default
 *   notebook's, whose repository would publish them (A753).
 * - A notebook's id is its folder's id; the default notebook's is
 *   `DEFAULT_NOTEBOOK`.
 */
import { journalFolderId } from '../periodic';
import { effectiveParents, type FolderRecord } from './tree';

/** The default notebook's id wherever a notebook is named by id (`notebooks=`, open state). */
export const DEFAULT_NOTEBOOK = 'default';
/** The default notebook's name until the person names it (Settings → Notebooks). */
export const DEFAULT_NOTEBOOK_NAME = 'Personal';
/** The folder captures filed as new notes go to (T30); never a notebook's. */
const INBOX = 'inbox';

/** A notebook as a list shows it. */
export interface Notebook {
  readonly id: string;
  readonly name: string;
  readonly position: string;
}

/** Which notebook each folder is in, worked out once for a snapshot of the folders. */
export interface NotebookIndex {
  /** The notebooks, in the top level's manual order (position, then id). */
  readonly notebooks: readonly Notebook[];
  /** The notebook a folder is in (its own id for a notebook's folder); null: the default. */
  ofFolder(folderId: string | null): string | null;
  /** True when the folder is a notebook's own folder. */
  isNotebook(folderId: string | null): boolean;
}

export function notebookIndex(folders: readonly FolderRecord[]): NotebookIndex {
  const parents = effectiveParents(folders);
  const flagged = new Set(folders.filter((folder) => folder.notebook === true).map((f) => f.id));
  const memo = new Map<string, string | null>();
  /** The outermost flagged folder on the way up (cycles are already broken by effectiveParents). */
  const outermost = (folderId: string): string | null => {
    const known = memo.get(folderId);
    if (known !== undefined) return known;
    const parent = parents.get(folderId) ?? null;
    const above = parent === null ? null : outermost(parent);
    const found = above ?? (flagged.has(folderId) ? folderId : null);
    memo.set(folderId, found);
    return found;
  };
  const ofFolder = (folderId: string | null): string | null =>
    folderId === null || !parents.has(folderId) ? null : outermost(folderId);
  const notebooks = folders
    .filter((folder) => flagged.has(folder.id) && outermost(folder.id) === folder.id)
    .map((folder) => ({ id: folder.id, name: folder.name, position: folder.position }))
    .sort((a, b) =>
      a.position < b.position ? -1 : a.position > b.position ? 1 : a.id < b.id ? -1 : 1,
    );
  const own = new Set(notebooks.map((notebook) => notebook.id));
  return {
    notebooks,
    ofFolder,
    isNotebook: (folderId) => folderId !== null && own.has(folderId),
  };
}

/** A notebook's id as the APIs name it: the folder id, or `DEFAULT_NOTEBOOK`. */
export function notebookKey(notebookId: string | null): string {
  return notebookId ?? DEFAULT_NOTEBOOK;
}

/** True for the Journal folder and the Inbox: they stay in the default notebook (A751). */
export function isJournalOrInbox(folder: Pick<FolderRecord, 'id' | 'name' | 'parentId'>): boolean {
  if (folder.id === journalFolderId('Journal') || folder.id === journalFolderId('Inbox')) {
    return true;
  }
  return folder.parentId === null && folder.name.trim().toLowerCase() === INBOX;
}

/**
 * Why a folder cannot move to `parentId`, or null when it can (A750): a
 * notebook stays at the top level, and Journal and the Inbox (and folders
 * holding them) never go into a notebook. Whether the move would loop is the
 * tree's own check (`isWithin`).
 */
export function folderMoveRefusal(
  folders: readonly FolderRecord[],
  folderId: string,
  parentId: string | null,
): string | null {
  const index = notebookIndex(folders);
  const folder = folders.find((candidate) => candidate.id === folderId);
  if (!folder) return null;
  if (folder.notebook === true && parentId !== null) {
    return 'A notebook stays at the top level: notebooks cannot go inside folders';
  }
  // Journal and the Inbox stay in the default notebook, and so does everything in them (a year
  // of daily notes, say): daily notes and captures file there (A751).
  if (
    parentId !== null &&
    index.ofFolder(parentId) !== null &&
    (holdsJournal(folders, folderId) || inJournal(folders, folderId))
  ) {
    return 'Journal and the Inbox stay in the default notebook';
  }
  return null;
}

/** The folder is in Journal or the Inbox (at any depth), or is one of them. */
function inJournal(folders: readonly FolderRecord[], folderId: string): boolean {
  const parents = effectiveParents(folders);
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  for (let at: string | null = folderId; at !== null; at = parents.get(at) ?? null) {
    const folder = byId.get(at);
    if (folder && isJournalOrInbox(folder)) return true;
  }
  return false;
}

/** Why a folder cannot be turned into a notebook (`on`) or back into a folder, or null. */
export function notebookFlagRefusal(
  folders: readonly FolderRecord[],
  folderId: string,
  on: boolean,
): string | null {
  const folder = folders.find((candidate) => candidate.id === folderId);
  if (!folder) return 'No such folder';
  if (!on) return folder.notebook === true ? null : 'That folder is not a notebook';
  if (folder.notebook === true) return null;
  const parents = effectiveParents(folders);
  if ((parents.get(folderId) ?? null) !== null) {
    return 'Only a top-level folder can be a notebook';
  }
  if (holdsJournal(folders, folderId)) return 'Journal and the Inbox stay in the default notebook';
  return null;
}

/** The folder is Journal or the Inbox, or holds one of them. */
function holdsJournal(folders: readonly FolderRecord[], folderId: string): boolean {
  const parents = effectiveParents(folders);
  return folders.some((candidate) => {
    if (!isJournalOrInbox(candidate)) return false;
    for (let at: string | null = candidate.id; at !== null; at = parents.get(at) ?? null) {
      if (at === folderId) return true;
    }
    return false;
  });
}

/**
 * The notes a view shows with some notebooks closed (A752): those whose
 * notebook is open. The default notebook is always open. `folderOf` gives a
 * note's folder (null: the top level, or not filed).
 */
export function openNotebookFilter(
  folders: readonly FolderRecord[],
  closed: ReadonlySet<string>,
): (folderId: string | null) => boolean {
  if (closed.size === 0) return () => true;
  const index = notebookIndex(folders);
  return (folderId) => {
    const notebook = index.ofFolder(folderId);
    return notebook === null || !closed.has(notebook);
  };
}

/**
 * A folder gone from the tree, as Trash remembers it (the WorkspaceDoc's `folderTrash`, T42):
 * where it was, and whether it was a notebook's own folder. The lineage below reads through
 * these to tell which notebook a folder or note left behind by a delete belongs to (A757).
 */
export interface GoneFolder {
  readonly id: string;
  readonly parentId: string | null;
  readonly notebook: boolean;
}

/**
 * Where a folder (or a note filed in it) belongs, and whether that is certain (T43, A757: fail
 * closed). It is certain when every folder on the way to the top level is in the tree and no
 * two of them form a loop. Otherwise the chain is broken:
 *
 * - `orphaned`: a folder on the way up is gone (deleted on another device); Trash says where it
 *   was, so `notebook` is where the chain leads (`deletedNotebook` when that is a notebook that
 *   was deleted too);
 * - `cycle`: two concurrent moves made a loop (the tree breaks it for show, A17);
 * - `unknown`: a folder on the way up is gone and Trash no longer remembers it.
 *
 * A mirror writes a note only when its place is certain; every mirror holds the others.
 */
export type Placement =
  | { readonly certain: true; readonly notebook: string | null }
  | {
      readonly certain: false;
      readonly reason: 'orphaned' | 'cycle' | 'unknown';
      /** The notebook the chain leads to as far as it is known (null: the default); undefined: not known. */
      readonly notebook: string | null | undefined;
      /** A deleted notebook on the way up (its id), or null. */
      readonly deletedNotebook: string | null;
    };

/**
 * Where to put something meant for a folder that may be gone (T43, A757): the folder itself
 * while it is in the tree, else the nearest folder above it that is (through Trash's records),
 * else the top level when the whole way up was the default notebook's. Never from a notebook
 * into the default notebook: when the way up passes a deleted notebook, or Trash no longer
 * knows it, there is no safe place (`refused`) and the caller asks, refuses, or keeps it in
 * Trash with its notebook.
 */
export type Fallback =
  | { readonly folderId: string | null }
  | { readonly refused: 'notebook-gone' | 'unknown'; readonly notebook: string | null };

export interface NotebookLineage {
  placement(folderId: string | null): Placement;
  fallback(folderId: string | null): Fallback;
}

export function notebookLineage(
  folders: readonly FolderRecord[],
  gone: readonly GoneFolder[] = [],
): NotebookLineage {
  const live = new Map(folders.map((folder) => [folder.id, folder]));
  const trashed = new Map<string, GoneFolder>();
  for (const folder of gone) if (!live.has(folder.id)) trashed.set(folder.id, folder);
  const memo = new Map<string, Placement>();
  const placement = (folderId: string | null): Placement => {
    if (folderId === null) return { certain: true, notebook: null };
    const known = memo.get(folderId);
    if (known) return known;
    let outer: string | null = null;
    let deletedNotebook: string | null = null;
    let reason: 'orphaned' | 'cycle' | 'unknown' | null = null;
    const seen = new Set<string>();
    for (let at: string | null = folderId; at !== null;) {
      if (seen.has(at)) {
        reason = 'cycle';
        break;
      }
      seen.add(at);
      const folder = live.get(at);
      if (folder) {
        if (folder.notebook === true) outer = at;
        at = folder.parentId;
        continue;
      }
      const record = trashed.get(at);
      if (!record) {
        reason = 'unknown';
        break;
      }
      reason = 'orphaned';
      if (record.notebook) {
        outer = at;
        deletedNotebook = at;
      }
      at = record.parentId;
    }
    const result: Placement =
      reason === null
        ? { certain: true, notebook: outer }
        : {
            certain: false,
            reason,
            notebook: reason === 'orphaned' ? outer : (outer ?? undefined),
            deletedNotebook,
          };
    memo.set(folderId, result);
    return result;
  };
  const fallback = (folderId: string | null): Fallback => {
    if (folderId === null || live.has(folderId)) return { folderId };
    const seen = new Set<string>();
    for (let at: string | null = folderId; ;) {
      if (at === null) return { folderId: null };
      if (live.has(at)) return { folderId: at };
      const record = trashed.get(at);
      if (!record || seen.has(at)) return { refused: 'unknown', notebook: null };
      seen.add(at);
      if (record.notebook) return { refused: 'notebook-gone', notebook: at };
      at = record.parentId;
    }
  };
  return { placement, fallback };
}
