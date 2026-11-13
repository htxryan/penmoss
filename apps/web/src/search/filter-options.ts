/**
 * The search dialog's Folder and Tag lists (A1127; PEN-71, A1290). Under All Notebooks, Folder
 * lists every open notebook's folders grouped under the notebook's name, and Tag every open
 * notebook's tags, each once; with one notebook chosen, that notebook's alone, and Folder offers
 * every folder of this notebook or of all notebooks (A1352).
 */
import { tagTree, type TagNode } from '@penmoss/core/tags';
import { buildTree, type FolderNode, type FolderRecord } from '@penmoss/core/workspace';

export interface FolderOption {
  readonly id: string;
  /** The name, indented one em space per level of depth. */
  readonly label: string;
}

/** One notebook's folders in the Folder list. */
export interface FolderGroup {
  readonly notebookId: string;
  readonly name: string;
  readonly folders: readonly FolderOption[];
}

/** What the lists are made from: one open notebook. */
export interface FilterNotebook {
  readonly id: string;
  readonly name: string;
  readonly folders: readonly FolderRecord[];
  readonly tags: ReadonlyArray<readonly string[]>;
}

/** One of the Folder list's first choices, before the folders. */
export interface FolderScope {
  readonly value: string;
  readonly label: string;
}

/**
 * Folder's value for All Folders (All Notebooks): Notebook goes back to All Notebooks. Not a
 * folder id, nor a grouped folder's JSON value.
 */
export const ALL_NOTEBOOKS_FOLDERS = '*all-notebooks';

/**
 * The Folder list's first choices (A1352): with several notebooks open and one chosen, All
 * Folders of this notebook, or of all notebooks (which puts Notebook back to All Notebooks);
 * otherwise All Folders alone.
 */
export function folderScopes(several: boolean, notebookChosen: boolean): FolderScope[] {
  if (!several || !notebookChosen) return [{ value: '', label: 'All Folders' }];
  return [
    { value: '', label: 'All Folders (This Notebook)' },
    { value: ALL_NOTEBOOKS_FOLDERS, label: 'All Folders (All Notebooks)' },
  ];
}

/** Folders in tree order, each with its depth, for the Folder list. */
export function folderOptions(folders: readonly FolderRecord[]): FolderOption[] {
  const walk = (nodes: readonly FolderNode[], depth: number): FolderOption[] =>
    nodes.flatMap((folder) => [
      { id: folder.id, label: `${'\u2003'.repeat(depth)}${folder.name}` },
      ...walk(folder.folders, depth + 1),
    ]);
  return walk(buildTree(folders, []).folders, 0);
}

/**
 * Every notebook's folders, one group per notebook in the order given (the Notebook picker's),
 * and no group for a notebook without folders.
 */
export function folderGroups(notebooks: readonly FilterNotebook[]): FolderGroup[] {
  return notebooks
    .map((notebook) => ({
      notebookId: notebook.id,
      name: notebook.name,
      folders: folderOptions(notebook.folders),
    }))
    .filter((group) => group.folders.length > 0);
}

function flatten(nodes: readonly TagNode[]): string[] {
  return nodes.flatMap((node) => [node.tag, ...flatten(node.children)]);
}

/** The tags of these notes (each note's list of tags), each once, in the tag tree's order. */
export function tagOptions(notes: ReadonlyArray<readonly string[]>): string[] {
  return flatten(tagTree(notes));
}

/** The tags of every notebook given, each once. */
export function notebookTags(notebooks: readonly FilterNotebook[]): string[] {
  return tagOptions(notebooks.flatMap((notebook) => notebook.tags));
}
