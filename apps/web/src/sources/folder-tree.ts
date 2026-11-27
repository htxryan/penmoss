/**
 * Pick Folder's tree (A1620, A1703), worked out apart from the screen: which folders there are,
 * which hold a notebook, which a notebook can go in, and the rows shown for what is open and what
 * the filter (or Notebooks) keeps. The Mac's and the relay's Pick Folder are the one screen
 * (FirstRunFolderPick.tsx), and this is its logic, as Android's FirstRunFolderPick.kt has it.
 */
import { fuzzyMatch } from '@penmoss/core/fuzzy';
import type { RepoFolders } from '../desktop/bridge';

export interface FolderNotebook {
  readonly id: string;
  readonly name: string;
}

/** A folder's parent, or '' (the root) for a top-level one. */
const parentOf = (path: string) => {
  const at = path.lastIndexOf('/');
  return at < 0 ? '' : path.slice(0, at);
};

/** The folders above `path`, the nearest first, never the root. */
export function ancestors(path: string): string[] {
  const above: string[] = [];
  for (let at = parentOf(path); at; at = parentOf(at)) above.push(at);
  return above;
}

/** A folder's own name: its path's last part. */
export const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1);

export interface FolderTreeShape {
  /** Where a notebook can go: the folders with none in them (the root among them), and new ones. */
  readonly free: readonly string[];
  /** The folders below the root holding a notebook, by path. */
  readonly notebooks: ReadonlyMap<string, FolderNotebook>;
  /** Each folder's folders, by name; the root's under ''. */
  readonly children: ReadonlyMap<string, readonly string[]>;
  /** Every folder below the root. */
  readonly all: readonly string[];
}

export function folderTreeShape(folders: RepoFolders, made: readonly string[]): FolderTreeShape {
  const notebooks = new Map<string, FolderNotebook>();
  for (const folder of folders.folders) {
    if (folder.notebook && folder.path) notebooks.set(folder.path, folder.notebook);
  }
  const free = [
    ...new Set([
      ...folders.folders.filter((folder) => folder.notebook === null).map((f) => f.path),
      ...made,
    ]),
  ];
  // Every folder below the root, with the folders above each, so each has its place.
  const all = new Set<string>();
  for (const path of [...free, ...notebooks.keys()]) {
    if (!path) continue;
    all.add(path);
    for (const above of ancestors(path)) all.add(above);
  }
  const children = new Map<string, string[]>();
  for (const path of all) {
    const parent = parentOf(path);
    const kids = children.get(parent) ?? [];
    kids.push(path);
    children.set(parent, kids);
  }
  for (const kids of children.values()) {
    kids.sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
  }
  return { free, notebooks, children, all: [...all] };
}

/** The levels down to each notebook: open at first, so they show without a click. */
export const openAtFirst = (shape: FolderTreeShape): ReadonlySet<string> =>
  new Set([...shape.notebooks.keys()].flatMap((path) => ancestors(path)));

/** The folders holding folders: what Expand All opens. */
export const parents = (shape: FolderTreeShape): ReadonlySet<string> =>
  new Set([...shape.children.keys()].filter(Boolean));

export interface FolderFilter {
  /** The folders whose name has what is typed in it. */
  readonly matches: ReadonlySet<string>;
  /** With a filter or Notebooks, the folders kept: each match and the folders above it. */
  readonly shown: ReadonlySet<string> | null;
}

export function folderFilter(
  shape: FolderTreeShape,
  query: string,
  onlyNotebooks: boolean,
): FolderFilter {
  // Matched as Pick Repository's filter matches (the letters in a run), and marked the same.
  const words = query.trim();
  const matches = new Set(
    words
      ? shape.all.filter((path) => fuzzyMatch(words, nameOf(path), { scattered: false }) !== null)
      : [],
  );
  const keep = (paths: Iterable<string>) =>
    new Set([...paths].flatMap((path) => [...ancestors(path), path]));
  if (onlyNotebooks) return { matches, shown: keep(shape.notebooks.keys()) };
  if (words) return { matches, shown: keep(matches) };
  return { matches, shown: null };
}

export interface TreeRowAt {
  readonly path: string;
  /** How many levels below the top: 0 for a folder at the root. */
  readonly depth: number;
}

/** The tree's rows in order: what is open, or, while filtered, everything kept, every level open. */
export function treeRows(
  shape: FolderTreeShape,
  open: ReadonlySet<string>,
  shown: ReadonlySet<string> | null,
): TreeRowAt[] {
  const rows: TreeRowAt[] = [];
  const walk = (parent: string, depth: number) => {
    for (const path of shape.children.get(parent) ?? []) {
      if (shown && !shown.has(path)) continue;
      rows.push({ path, depth });
      if (shown || open.has(path)) walk(path, depth + 1);
    }
  };
  walk('', 0);
  return rows;
}
