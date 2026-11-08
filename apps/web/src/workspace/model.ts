/**
 * The sidebar's folder tree as pure functions (T7): joining the WorkspaceDoc
 * registry with the note list, flattening the tree into visible rows, and
 * planning moves (drag-and-drop and Alt+↑/↓) as order-key writes. Nothing
 * here touches the Y.Doc; the Workspace service applies a plan.
 */
import {
  compareOrder,
  isOrderKey,
  isWithin,
  keyBetween,
  keysBetween,
  type FolderNode,
  type NoteEntry,
  type SortMode,
  type WorkspaceTree,
} from '@penmoss/core/workspace';
import type { WorkspaceSnapshot } from '@penmoss/sync-client/workspace';
import { displayTitle, type NoteListEntry } from '../notes/list';

/**
 * Order key for notes the registry does not know yet. It is not a valid key
 * and sorts after every valid one, so unregistered notes show at the end of
 * the top level, oldest first (ties break by id, and ids are ULIDs).
 */
export const UNREGISTERED_POSITION = '~';

export interface MergedNotes {
  /** Every listed note, placed where the registry says (top level when it does not know it). */
  readonly entries: NoteEntry[];
  /** Listed notes missing from the registry, oldest first. */
  readonly unregistered: string[];
}

/**
 * Joins the note list (titles, modified times) with the registry (folder,
 * order). A note only the registry knows is left out: the list decides which
 * notes exist, and the registry can learn of a note before the list does.
 */
export function mergeRegistry(
  snapshot: Pick<WorkspaceSnapshot, 'notes'>,
  list: readonly NoteListEntry[],
): MergedNotes {
  const registry = new Map(snapshot.notes.map((entry) => [entry.id, entry]));
  const entries: NoteEntry[] = [];
  const unregistered: string[] = [];
  for (const note of list) {
    const registered = registry.get(note.id);
    if (!registered) unregistered.push(note.id);
    entries.push({
      id: note.id,
      folderId: registered?.folderId ?? null,
      position: registered?.position ?? UNREGISTERED_POSITION,
      title: note.title,
      updatedAt: note.updatedAt,
    });
  }
  unregistered.sort();
  return { entries, unregistered };
}

export type ItemKind = 'folder' | 'note';

export interface ItemRef {
  readonly kind: ItemKind;
  readonly id: string;
}

export const rowKey = (item: ItemRef) => `${item.kind}:${item.id}`;

interface RowBase extends ItemRef {
  readonly key: string;
  /** 1-based depth (aria-level). */
  readonly level: number;
  /** The folder this row shows in (null: top level). */
  readonly parentId: string | null;
  readonly setSize: number;
  readonly posInSet: number;
}

export interface FolderRow extends RowBase {
  readonly kind: 'folder';
  readonly name: string;
  readonly expanded: boolean;
  readonly hasChildren: boolean;
  readonly sortMode: SortMode;
  /** A notebook's folder (T43, A750): its own icon and menu. */
  readonly notebook: boolean;
  /** The default notebook's first top-level folder after the notebooks (T43): a rule above it. */
  readonly sectionStart?: true;
}

export interface NoteRow extends RowBase {
  readonly kind: 'note';
  readonly title: string;
  readonly untitled: boolean;
}

export type Row = FolderRow | NoteRow;

/** A folder's child as the tree shows it: a subfolder or a note. */
export type Child =
  | {
      readonly kind: 'folder';
      readonly id: string;
      readonly position: string;
      readonly folder: FolderNode;
    }
  | {
      readonly kind: 'note';
      readonly id: string;
      readonly position: string;
      readonly note: NoteEntry;
    };

/**
 * A folder's children in the order shown: its subfolders, then its notes; or, sorted Manual and
 * `together` (T62 item 6), the two kinds in one order by their keys, a folder first on a tie.
 */
export function orderedChildren(
  folders: readonly FolderNode[],
  notes: readonly NoteEntry[],
  together: boolean,
): Child[] {
  const out: Child[] = [
    ...folders.map((folder) => ({
      kind: 'folder' as const,
      id: folder.id,
      position: folder.position,
      folder,
    })),
    ...notes.map((note) => ({ kind: 'note' as const, id: note.id, position: note.position, note })),
  ];
  if (!together) return out;
  // Both lists are already in key order: a stable sort merges them.
  return out.sort(
    (a, b) => compareOrder(a, b) || (a.kind === b.kind ? 0 : a.kind === 'folder' ? -1 : 1),
  );
}

/** Whether a folder's (null: the top level's) children share one Manual order (T62 item 6). */
export function isTogether(tree: WorkspaceTree, folderId: string | null): boolean {
  if (sortModeOf(tree, folderId) !== 'manual') return false;
  return folderId === null
    ? tree.rootTogether === true
    : tree.byId.get(folderId)?.together === true;
}

/** A folder's (null: the top level's) children in the order shown. */
export function childrenOf(tree: WorkspaceTree, folderId: string | null): Child[] {
  const parent = folderId === null ? tree : tree.byId.get(folderId);
  if (!parent) return [];
  return orderedChildren(parent.folders, parent.notes, isTogether(tree, folderId));
}

/** The rows a reader sees, depth first: in each folder, its subfolders, then its notes (or the two in one Manual order, T62 item 6). */
export function visibleRows(tree: WorkspaceTree, expanded: ReadonlySet<string>): Row[] {
  const rows: Row[] = [];
  const walk = (
    folders: readonly FolderNode[],
    notes: readonly NoteEntry[],
    parentId: string | null,
    level: number,
  ) => {
    const setSize = folders.length + notes.length;
    let posInSet = 0;
    for (const child of orderedChildren(folders, notes, isTogether(tree, parentId))) {
      if (child.kind === 'note') {
        const note = child.note;
        rows.push({
          kind: 'note',
          id: note.id,
          key: rowKey({ kind: 'note', id: note.id }),
          level,
          parentId,
          setSize,
          posInSet: ++posInSet,
          title: displayTitle(note.title),
          untitled: !note.title.trim(),
        });
        continue;
      }
      const folder = child.folder;
      const isOpen = expanded.has(folder.id);
      rows.push({
        kind: 'folder',
        id: folder.id,
        key: rowKey({ kind: 'folder', id: folder.id }),
        level,
        parentId,
        setSize,
        posInSet: ++posInSet,
        name: folder.name,
        expanded: isOpen,
        hasChildren: folder.folders.length + folder.notes.length > 0,
        sortMode: folder.sortMode,
        notebook: folder.notebook === true,
        ...(level === 1 &&
        folder.notebook !== true &&
        folders.some((other) => other.notebook === true)
          ? folders.find((other) => other.notebook !== true) === folder
            ? { sectionStart: true as const }
            : {}
          : {}),
      });
      if (isOpen) walk(folder.folders, folder.notes, folder.id, level + 1);
    }
  };
  walk(tree.folders, tree.notes, null, 1);
  return rows;
}

/**
 * The sidebar's tree (T43, A752): the notebooks open on this device head the top level, in their
 * own order, then the default notebook's folders; closed notebooks leave it, so neither the
 * sidebar nor its moves see them. `byId` still knows them, so a note in one still finds its
 * place. A tree without notebooks comes back as it is.
 */
export function withoutClosed(tree: WorkspaceTree, closed: ReadonlySet<string>): WorkspaceTree {
  const top = tree.folders;
  const notebooks = top.filter((folder) => folder.notebook === true && !closed.has(folder.id));
  const others = top.filter((folder) => folder.notebook !== true);
  const folders = [...notebooks, ...others];
  if (folders.length === top.length && folders.every((folder, i) => folder === top[i])) {
    return tree;
  }
  return { ...tree, folders };
}

/** The folders a note or folder shows inside, nearest first. */
export function ancestors(tree: WorkspaceTree, item: ItemRef): string[] {
  let parent = parentOf(tree, item);
  const out: string[] = [];
  while (parent !== null && !out.includes(parent)) {
    out.push(parent);
    parent = tree.byId.get(parent)?.effectiveParentId ?? null;
  }
  return out;
}

/**
 * The folders to open so the open note's row shows (T7), outermost last, or
 * null while that is not known yet: the note is not listed, or the workspace
 * has not filed it and has not synced (on a cold load the note list arrives
 * before the WorkspaceDoc, and the note would wrongly read as top level). A
 * note still unfiled once the workspace has synced shows at the top level.
 */
export function revealFolders(
  noteId: string,
  snapshot: Pick<WorkspaceSnapshot, 'notes'>,
  tree: WorkspaceTree,
  synced: boolean,
): string[] | null {
  const listed =
    tree.notes.some((note) => note.id === noteId) ||
    [...tree.byId.values()].some((folder) => folder.notes.some((note) => note.id === noteId));
  if (!listed) return null;
  const filed = snapshot.notes.some((entry) => entry.id === noteId);
  if (!filed && !synced) return null;
  return ancestors(tree, { kind: 'note', id: noteId });
}

/** The folder an item shows in (null: top level, or unknown). */
export function parentOf(tree: WorkspaceTree, item: ItemRef): string | null {
  if (item.kind === 'folder') return tree.byId.get(item.id)?.effectiveParentId ?? null;
  const inRoot = tree.notes.some((note) => note.id === item.id);
  if (inRoot) return null;
  for (const folder of tree.byId.values()) {
    if (folder.notes.some((note) => note.id === item.id)) return folder.id;
  }
  return null;
}

export type DropZone = 'before' | 'after' | 'inside';

/**
 * Where a drop lands on a row, from the pointer's offset within it: the top
 * and bottom quarters of a folder row drop beside it, the middle drops into
 * it. A note row splits in half (notes hold nothing).
 */
export function dropZone(kind: ItemKind, offsetY: number, height: number): DropZone {
  const ratio = height > 0 ? offsetY / height : 0.5;
  if (kind === 'note') return ratio < 0.5 ? 'before' : 'after';
  if (ratio < 0.25) return 'before';
  if (ratio > 0.75) return 'after';
  return 'inside';
}

export type DropTarget =
  | { readonly kind: 'root' }
  | { readonly kind: ItemKind; readonly id: string; readonly zone: DropZone };

export interface Placement {
  /** A sibling of the item's own kind unless the order holds both (T62 item 6). */
  readonly kind: ItemKind;
  readonly id: string;
  readonly position: string;
}

export type MovePlan =
  | {
      readonly type: 'move';
      readonly item: ItemRef;
      readonly parentId: string | null;
      readonly position: string;
      /**
       * Siblings that need new keys too. Empty unless the neighbours' keys
       * cannot frame a new one (a tie from two clients inserting at the
       * same spot, or notes the registry does not know yet); then only the
       * run of such siblings around the drop point is re-keyed.
       */
      readonly respace: readonly Placement[];
      /**
       * The parent's subfolders and notes take one Manual order from now on (T62 item 6): a note
       * or folder was placed beside the other kind. `respace` re-keys every sibling with it.
       */
      readonly together?: true;
    }
  | { readonly type: 'noop' }
  | { readonly type: 'refused'; readonly reason: string };

export const SORT_LABELS: Record<SortMode, string> = {
  manual: 'Manual',
  alpha: 'A–Z',
  modified: 'Modified',
};

/**
 * Plans a drop of `item` on `target`. Beside a row of the other kind, in a folder sorted Manual,
 * the item goes there and the folder's subfolders and notes share one order from then on (T62
 * item 6); sorted by name or date, it goes to the end of its kind as before.
 */
export function planDrop(tree: WorkspaceTree, item: ItemRef, target: DropTarget): MovePlan {
  if (target.kind === 'root') return placeIn(tree, item, null, null);
  if (target.kind === item.kind && target.id === item.id) return { type: 'noop' };
  if (target.kind === 'folder' && target.zone === 'inside') {
    return placeIn(tree, item, target.id, null);
  }
  const parentId = parentOf(tree, target);
  return placeIn(tree, item, parentId, { kind: target.kind, id: target.id, side: target.zone });
}

/**
 * Plans Alt+↑ (delta -1) or Alt+↓ (+1): one step past the next row in the folder, in Manual order
 * only. A step past the other kind (the first note up past the last folder) puts the two in one
 * order (T62 item 6).
 */
export function planStep(tree: WorkspaceTree, item: ItemRef, delta: -1 | 1): MovePlan {
  const parentId = parentOf(tree, item);
  const mode = sortModeOf(tree, parentId);
  if (mode !== 'manual') {
    return {
      type: 'refused',
      reason: `${folderLabel(tree, parentId)} is sorted ${SORT_LABELS[mode]}. Switch it to Manual to reorder.`,
    };
  }
  const siblings = childrenOf(tree, parentId);
  const index = siblings.findIndex(
    (sibling) => sibling.kind === item.kind && sibling.id === item.id,
  );
  const anchor = siblings[index + delta];
  if (index === -1 || !anchor) return { type: 'noop' };
  return placeIn(tree, item, parentId, {
    kind: anchor.kind,
    id: anchor.id,
    side: delta < 0 ? 'before' : 'after',
  });
}

export function sortModeOf(tree: WorkspaceTree, folderId: string | null): SortMode {
  return folderId === null ? tree.rootSortMode : (tree.byId.get(folderId)?.sortMode ?? 'manual');
}

/** A place "Move to folder…" offers (T39): null is the top level. */
export interface FolderChoice {
  readonly id: string | null;
  readonly name: string;
  /** Its folders from the top, joined with " / ". */
  readonly path: string;
  /** 0 for the top level, 1 for a top-level folder. */
  readonly depth: number;
  /** A notebook's own folder (T43): moving there moves the note to another notebook. */
  readonly notebook?: true;
}

/** The top level, then every folder in the tree's own order, each before its subfolders. */
export function folderChoices(tree: WorkspaceTree): FolderChoice[] {
  const choices: FolderChoice[] = [{ id: null, name: 'Top level', path: 'Top level', depth: 0 }];
  const walk = (folders: readonly FolderNode[], trail: readonly string[], depth: number) => {
    for (const folder of folders) {
      const path = [...trail, folder.name];
      choices.push({
        id: folder.id,
        name: folder.name,
        path: path.join(' / '),
        depth,
        ...(folder.notebook === true ? { notebook: true as const } : {}),
      });
      walk(folder.folders, path, depth + 1);
    }
  };
  walk(tree.folders, [], 1);
  return choices;
}

/**
 * Plans "Move to folder…" (T39): the note goes to the end of `folderId`
 * (null: the top level), as a drop on that folder does. Choosing where it
 * already is changes nothing (a drop there would move it to the end).
 */
export function planMoveTo(tree: WorkspaceTree, noteId: string, folderId: string | null): MovePlan {
  const item: ItemRef = { kind: 'note', id: noteId };
  if (parentOf(tree, item) === folderId) return { type: 'noop' };
  return placeIn(tree, item, folderId, null);
}

export function folderLabel(tree: WorkspaceTree, folderId: string | null): string {
  if (folderId === null) return 'The top level';
  return `“${tree.byId.get(folderId)?.name ?? 'Folder'}”`;
}

interface Sibling {
  readonly kind: ItemKind;
  readonly id: string;
  readonly position: string;
}

function siblingsOf(tree: WorkspaceTree, kind: ItemKind, parentId: string | null): Sibling[] {
  const parent = parentId === null ? tree : tree.byId.get(parentId);
  if (!parent) return [];
  return (kind === 'folder' ? parent.folders : parent.notes).map((sibling) => ({
    kind,
    id: sibling.id,
    position: sibling.position,
  }));
}

/** Places `item` in `parentId`, beside `anchor` or (no anchor) at the end. */
function placeIn(
  tree: WorkspaceTree,
  item: ItemRef,
  parentId: string | null,
  anchor: { readonly kind: ItemKind; readonly id: string; readonly side: DropZone } | null,
): MovePlan {
  if (parentId !== null && !tree.byId.has(parentId)) return { type: 'noop' };
  if (item.kind === 'folder' && isWithin([...tree.byId.values()], parentId, item.id)) {
    return {
      type: 'refused',
      reason: 'A folder cannot move into itself or one of its subfolders.',
    };
  }
  const currentParent = parentOf(tree, item);
  const manual = sortModeOf(tree, parentId) === 'manual';
  const together = isTogether(tree, parentId);
  const crossing = manual && anchor !== null && anchor.kind !== item.kind;
  // One order for both kinds once together, or from this move on; otherwise the item's own kind.
  const all: Sibling[] =
    together || crossing
      ? childrenOf(tree, parentId).map(({ kind, id, position }) => ({ kind, id, position }))
      : siblingsOf(tree, item.kind, parentId);
  const isItem = (sibling: Sibling) => sibling.kind === item.kind && sibling.id === item.id;
  const others = all.filter((sibling) => !isItem(sibling));
  let index = others.length;
  if (manual && anchor && (anchor.kind === item.kind || together || crossing)) {
    const at = others.findIndex(
      (sibling) => sibling.kind === anchor.kind && sibling.id === anchor.id,
    );
    if (at !== -1) index = anchor.side === 'before' ? at : at + 1;
  }
  if (currentParent === parentId) {
    // Sorted by name or date, a folder's order is not ours to change.
    if (!manual) return { type: 'noop' };
    const current = all.findIndex(isItem);
    if (current === index) return { type: 'noop' };
  }
  if (!manual) {
    // Appending to a folder sorted by name or date: after its largest valid key.
    const last = others
      .map((sibling) => sibling.position)
      .filter(isOrderKey)
      .sort()
      .at(-1);
    return { type: 'move', item, parentId, position: keyBetween(last ?? null, null), respace: [] };
  }
  if (crossing && !together) {
    // The first move across kinds (T62 item 6): the two kinds' keys were never compared, so every
    // sibling takes a fresh key in the order shown, the item at its place among them.
    const keys = keysBetween(null, null, others.length + 1);
    return {
      type: 'move',
      item,
      parentId,
      position: keys[index]!,
      respace: others.map((sibling, i) => ({
        kind: sibling.kind,
        id: sibling.id,
        position: keys[i < index ? i : i + 1]!,
      })),
      together: true,
    };
  }
  // Neighbours whose keys cannot frame a new one (a tie from two clients
  // inserting at the same spot, or notes the registry does not know yet) are
  // stepped past, and the siblings in between get fresh keys with the item.
  const valid = (i: number) => i < 0 || i >= others.length || isOrderKey(others[i]!.position);
  let lower = index - 1;
  let upper = index;
  for (;;) {
    if (!valid(lower)) lower--;
    else if (!valid(upper)) upper++;
    else if (
      lower >= 0 &&
      upper < others.length &&
      others[lower]!.position >= others[upper]!.position
    ) {
      upper++;
    } else break;
  }
  const keys = keysBetween(
    others[lower]?.position ?? null,
    others[upper]?.position ?? null,
    upper - lower,
  );
  const respace: Placement[] = [];
  for (let i = lower + 1; i < upper; i++) {
    const key = keys[i - lower - (i < index ? 1 : 0)]!;
    respace.push({ kind: others[i]!.kind, id: others[i]!.id, position: key });
  }
  return { type: 'move', item, parentId, position: keys[index - lower - 1]!, respace };
}
