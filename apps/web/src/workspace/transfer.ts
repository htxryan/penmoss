/**
 * Duplicate (T68, #227) and moving or copying notes and folders between open notebooks (#230).
 *
 * A note's id belongs to one notebook (A826), so a note that crosses is a new note: its body,
 * title and tags copied under a new id (`copyNote`), the images and files it shows copied into
 * the other notebook, and links between notes that cross together pointed at the copies. A move
 * then puts the originals in Trash in the notebook they came from, where they can be restored.
 */
import { ulid } from '@penmoss/core/ids';
import type { FolderNode, WorkspaceTree } from '@penmoss/core/workspace';
import { copyNote, noteAttachmentPaths } from '@penmoss/sync-client/records';
import type { Notes } from '../notes/service';
import { childrenOf, planDrop, type ItemRef } from './model';
import type { Workspace } from './service';

/** What a copy needs of a notebook: its notes and its folder tree. */
export interface NotebookServices {
  readonly notes: Pick<Notes, 'stateOf' | 'addCopy' | 'deleteNote' | 'attachments'>;
  readonly workspace: Pick<
    Workspace,
    'createFolder' | 'registerNote' | 'setSortMode' | 'deleteFolder' | 'notebookOf' | 'apply'
  >;
}

const COPY = / \(copy(?: (\d+))?\)$/;

/**
 * Duplicate's title (#227): `<title> (copy)`, then `(copy 2)`, `(copy 3)` for later copies of
 * the same note. A copy of a copy counts from the same base, so copying "Plan (copy)" makes the
 * next free number of "Plan".
 */
export function copyTitle(title: string, titles: Iterable<string>): string {
  const base = (title.trim() || 'Untitled').replace(COPY, '');
  let highest = 0;
  for (const other of titles) {
    if (!other.startsWith(`${base} (copy`)) continue;
    const match = COPY.exec(other);
    if (!match || other.slice(0, match.index) !== base) continue;
    highest = Math.max(highest, match[1] ? Number(match[1]) : 1);
  }
  return highest === 0 ? `${base} (copy)` : `${base} (copy ${highest + 1})`;
}

/**
 * Duplicates a note just after itself, in its folder (#227), and returns the copy's id, or null
 * when the note has no content on this device yet.
 */
export async function duplicateNote(
  services: NotebookServices,
  tree: WorkspaceTree,
  noteId: string,
  titles: readonly string[],
  now: Date = new Date(),
): Promise<string | null> {
  const state = await services.notes.stateOf(noteId);
  if (!state) return null;
  const title = titleIn(tree, noteId) ?? '';
  const record = copyNote(state, { title: copyTitle(title, titles), now });
  const id = services.notes.addCopy(record);
  const plan = planDrop(tree, { kind: 'note', id }, { kind: 'note', id: noteId, zone: 'after' });
  if (plan.type === 'move') services.workspace.apply(plan);
  else services.workspace.registerNote(id, folderOfNoteIn(tree, noteId));
  return id;
}

function titleIn(tree: WorkspaceTree, noteId: string): string | undefined {
  return [tree.notes, ...[...tree.byId.values()].map((folder) => folder.notes)]
    .flat()
    .find((note) => note.id === noteId)?.title;
}

function folderOfNoteIn(tree: WorkspaceTree, noteId: string): string | null {
  for (const folder of tree.byId.values()) {
    if (folder.notes.some((note) => note.id === noteId)) return folder.id;
  }
  return null;
}

/** Whether `folderId` is `ancestorId` or inside it. */
function within(tree: WorkspaceTree, folderId: string | null, ancestorId: string): boolean {
  for (let at = folderId; at !== null; at = tree.byId.get(at)?.effectiveParentId ?? null) {
    if (at === ancestorId) return true;
  }
  return false;
}

/**
 * The items as they go (#230): a folder takes everything inside it, so a selected note or
 * folder already inside a selected folder is left out; the rest keep the tree's order.
 */
export function topItems(tree: WorkspaceTree, items: readonly ItemRef[]): ItemRef[] {
  const folders = items.filter((item) => item.kind === 'folder').map((item) => item.id);
  const inside = (item: ItemRef) => {
    const start =
      item.kind === 'folder'
        ? (tree.byId.get(item.id)?.effectiveParentId ?? null)
        : folderOfNoteIn(tree, item.id);
    return folders.some((folder) => within(tree, start, folder));
  };
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.kind}:${item.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return !inside(item);
  });
}

/** "3 notes and 2 folders", for what moved or was copied (T68). */
export function itemsCount(notes: number, folders: number): string {
  const part = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;
  if (folders === 0) return part(notes, 'note');
  if (notes === 0) return part(folders, 'folder');
  return `${part(notes, 'note')} and ${part(folders, 'folder')}`;
}

export interface TransferResult {
  readonly notes: number;
  readonly folders: number;
  /** Notes with no content on this device, left where they were. */
  readonly skipped: number;
  /** Attachments neither this device nor the notebook had, so not copied. */
  readonly missingFiles: number;
  /** Each note copied, by its original's id. */
  readonly copies: ReadonlyMap<string, string>;
}

interface PlannedNote {
  readonly id: string;
  readonly copyId: string;
  readonly title: string;
  /** The folder it goes in, as a key of `folderIds` (null: the destination itself). */
  readonly parent: string | null;
}

interface PlannedFolder {
  readonly folder: FolderNode;
  readonly parent: string | null;
}

/**
 * Moves or copies notes and folders from one open notebook to another (#230), into `folderId`
 * there (null: its top level), each at the end, in order.
 */
export async function transfer(options: {
  readonly from: NotebookServices;
  readonly to: NotebookServices;
  readonly tree: WorkspaceTree;
  readonly items: readonly ItemRef[];
  readonly folderId: string | null;
  readonly mode: 'move' | 'copy';
  /**
   * A copy's choice (A1353): whether its notes take their frontmatter tags (default true).
   * A move always keeps them: the notes leave, so nothing is left to keep them.
   */
  readonly tags?: boolean;
  readonly now?: () => Date;
}): Promise<TransferResult> {
  const { from, to, tree, folderId, mode } = options;
  const now = options.now ?? (() => new Date());
  const tags = mode === 'move' || options.tags !== false;
  const folders: PlannedFolder[] = [];
  const notes: PlannedNote[] = [];
  const planNote = (id: string, title: string, parent: string | null) =>
    notes.push({ id, copyId: ulid(now().getTime()), title, parent });
  const planFolder = (folder: FolderNode, parent: string | null) => {
    folders.push({ folder, parent });
    for (const child of childrenOf(tree, folder.id)) {
      if (child.kind === 'folder') planFolder(child.folder, folder.id);
      else planNote(child.note.id, child.note.title, folder.id);
    }
  };
  const top = topItems(tree, options.items);
  for (const item of top) {
    if (item.kind === 'folder') {
      const folder = tree.byId.get(item.id);
      if (folder) planFolder(folder, null);
    } else {
      planNote(item.id, titleIn(tree, item.id) ?? '', null);
    }
  }

  // Folders first, parents before children (the walk's order), so every note has its place.
  const folderIds = new Map<string | null, string | null>([[null, folderId]]);
  for (const { folder, parent } of folders) {
    const id = to.workspace.createFolder(folder.name, folderIds.get(parent) ?? null);
    if (folder.sortMode !== 'manual') to.workspace.setSortMode(id, folder.sortMode);
    folderIds.set(folder.id, id);
  }

  const links = new Map(notes.map((note) => [note.id, note.copyId]));
  const copied: string[] = [];
  let skipped = 0;
  let missingFiles = 0;
  for (const note of notes) {
    const state = await from.notes.stateOf(note.id);
    if (!state) {
      skipped++;
      continue;
    }
    for (const path of noteAttachmentPaths(state)) {
      const bytes = await from.notes.attachments.bytes(path);
      if (!bytes || !(await to.notes.attachments.copyIn(path, bytes))) missingFiles++;
    }
    const place = folderIds.get(note.parent) ?? null;
    const record = copyNote(state, {
      id: note.copyId,
      title: note.title,
      now: now(),
      notebook: to.workspace.notebookOf(place),
      links,
      tags,
    });
    to.notes.addCopy(record);
    to.workspace.registerNote(note.copyId, place);
    copied.push(note.id);
  }

  if (mode === 'move') {
    // The originals to Trash: each note that was copied, then each folder (its notes gone, only
    // a note with nothing to copy would move up out of it).
    for (const id of copied) await from.notes.deleteNote(id);
    for (const item of top) if (item.kind === 'folder') from.workspace.deleteFolder(item.id);
  }
  const copies = new Map(
    notes.filter((note) => copied.includes(note.id)).map((note) => [note.id, note.copyId]),
  );
  return { notes: copied.length, folders: folders.length, skipped, missingFiles, copies };
}
