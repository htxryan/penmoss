/**
 * The folder tree as every client reads it (T7). The WorkspaceDoc stores
 * each folder's parent as a plain field, so concurrent moves can form a
 * cycle (A moved into B while B moved into A). Reading never writes a
 * repair: a cycle is broken by a deterministic rule, so all clients show
 * the same tree. Folders whose parent is missing (deleted concurrently)
 * show at the top level, and so do notes whose folder is missing.
 */
import { compareOrder } from './order';

export type SortMode = 'manual' | 'alpha' | 'modified';
export const SORT_MODES: readonly SortMode[] = ['manual', 'alpha', 'modified'];

export interface FolderRecord {
  readonly id: string;
  readonly name: string;
  readonly parentId: string | null;
  readonly position: string;
  readonly sortMode: SortMode;
  /**
   * A notebook's folder (T43, A750): set only on a top-level folder, and absent (never false)
   * on every other, so a tree without notebooks reads exactly as before.
   */
  readonly notebook?: true;
  /**
   * Its subfolders and notes share one Manual order (T62 item 6), so a note may sit above or
   * between them; absent (never false) until a note or folder is first placed among the other
   * kind, so every tree reads as before: subfolders, then notes.
   */
  readonly together?: true;
}

export interface NoteEntry {
  readonly id: string;
  readonly folderId: string | null;
  readonly position: string;
  readonly title: string;
  /** Epoch ms; for 'modified' sorting. */
  readonly updatedAt: number;
}

export interface FolderNode extends FolderRecord {
  /** The parent the tree actually uses (differs from parentId for orphans and broken cycles). */
  readonly effectiveParentId: string | null;
  readonly folders: FolderNode[];
  readonly notes: NoteEntry[];
}

export interface WorkspaceTree {
  readonly rootSortMode: SortMode;
  /** The top level's folders and notes share one Manual order (T62 item 6). */
  readonly rootTogether?: true;
  readonly folders: FolderNode[];
  readonly notes: NoteEntry[];
  readonly byId: ReadonlyMap<string, FolderNode>;
}

/**
 * Each folder's effective parent. Rule for a cycle: the folder with the
 * smallest id on it moves to the top level (its stored parent is kept, so
 * a later move can resolve the cycle for real).
 */
export function effectiveParents(folders: readonly FolderRecord[]): Map<string, string | null> {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const parent = new Map<string, string | null>();
  for (const folder of folders) {
    parent.set(
      folder.id,
      folder.parentId !== null && byId.has(folder.parentId) ? folder.parentId : null,
    );
  }
  // Walk up from every folder; any revisit inside one walk is a cycle.
  const settled = new Set<string>();
  for (const start of folders) {
    const path: string[] = [];
    const onPath = new Set<string>();
    let current: string | null = start.id;
    while (current !== null && !settled.has(current)) {
      if (onPath.has(current)) {
        const cycle = path.slice(path.indexOf(current));
        const breaker = cycle.reduce((min, id) => (id < min ? id : min));
        parent.set(breaker, null);
        break;
      }
      onPath.add(current);
      path.push(current);
      current = parent.get(current) ?? null;
    }
    for (const id of path) settled.add(id);
  }
  return parent;
}

/** True when `candidateId` is `folderId` or lies below it: moving folderId there would loop. */
export function isWithin(
  folders: readonly FolderRecord[],
  candidateId: string | null,
  folderId: string,
): boolean {
  const parents = effectiveParents(folders);
  for (let current = candidateId; current !== null; current = parents.get(current) ?? null) {
    if (current === folderId) return true;
  }
  return false;
}

/**
 * A folder and every folder below it, as the tree shows them (cycles and
 * orphans resolved as `effectiveParents` does); empty for an unknown folder.
 * Search filters by folder with it (T22), on the server and offline.
 */
export function folderSubtree(folders: readonly FolderRecord[], folderId: string): Set<string> {
  const parents = effectiveParents(folders);
  const out = new Set<string>();
  if (!parents.has(folderId)) return out;
  for (const folder of folders) {
    for (
      let current: string | null = folder.id;
      current !== null;
      current = parents.get(current) ?? null
    ) {
      if (current === folderId) {
        out.add(folder.id);
        break;
      }
    }
  }
  return out;
}

/**
 * A folder's names from the top, `Projects/Garden`, as the tree shows them
 * (cycles and orphans resolved as `effectiveParents` does); null for an
 * unknown folder. Folder-scoped tokens are shown by it (T37).
 */
export function folderPath(folders: readonly FolderRecord[], folderId: string): string | null {
  const parents = effectiveParents(folders);
  if (!parents.has(folderId)) return null;
  const names = new Map(folders.map((folder) => [folder.id, folder.name]));
  const path: string[] = [];
  for (
    let current: string | null = folderId;
    current !== null;
    current = parents.get(current) ?? null
  ) {
    path.unshift(names.get(current) ?? '');
  }
  return path.join('/');
}

export function buildTree(
  folders: readonly FolderRecord[],
  notes: readonly NoteEntry[],
  rootSortMode: SortMode = 'manual',
  rootTogether = false,
): WorkspaceTree {
  const parents = effectiveParents(folders);
  const nodes = new Map<string, FolderNode>();
  for (const folder of folders) {
    nodes.set(folder.id, {
      ...folder,
      effectiveParentId: parents.get(folder.id) ?? null,
      folders: [],
      notes: [],
    });
  }
  const rootFolders: FolderNode[] = [];
  const rootNotes: NoteEntry[] = [];
  for (const node of nodes.values()) {
    const parent = node.effectiveParentId === null ? null : nodes.get(node.effectiveParentId);
    (parent ? parent.folders : rootFolders).push(node);
  }
  for (const note of notes) {
    const folder = note.folderId === null ? undefined : nodes.get(note.folderId);
    (folder ? folder.notes : rootNotes).push(note);
  }
  for (const node of nodes.values()) {
    node.folders.sort(folderComparator(node.sortMode));
    node.notes.sort(noteComparator(node.sortMode));
  }
  rootFolders.sort(folderComparator(rootSortMode));
  rootNotes.sort(noteComparator(rootSortMode));
  return {
    rootSortMode,
    ...(rootTogether ? { rootTogether: true as const } : {}),
    folders: rootFolders,
    notes: rootNotes,
    byId: nodes,
  };
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Subfolders: manual order in manual mode, otherwise by name (folders have no modified time). */
export function folderComparator(mode: SortMode): (a: FolderRecord, b: FolderRecord) => number {
  if (mode === 'manual') return compareOrder;
  return (a, b) => collator.compare(a.name, b.name) || (a.id < b.id ? -1 : 1);
}

export function noteComparator(mode: SortMode): (a: NoteEntry, b: NoteEntry) => number {
  switch (mode) {
    case 'manual':
      return compareOrder;
    case 'alpha':
      return (a, b) =>
        collator.compare(a.title || 'Untitled', b.title || 'Untitled') || (a.id < b.id ? -1 : 1);
    case 'modified':
      return (a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : 1);
  }
}
