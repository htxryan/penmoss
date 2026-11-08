/**
 * The graph's input from the app (T17): every listed note with the notes it
 * links to, from this device's link index (the replica, A7), and its
 * top-level folder for colour. No server call: the graph works offline and
 * costs the Worker nothing (D20).
 */
import {
  buildTree,
  effectiveParents,
  openNotebookFilter,
  type FolderRecord,
  type SortMode,
} from '@penmoss/core/workspace';
import type { GraphGroup } from '@penmoss/ui/graph/GraphView';
import type { GraphNoteInput } from '@penmoss/ui/graph/model';
import { displayTitle } from '../notes/list';
import type { LocalLinks } from '../notes/service';

export interface GraphSource {
  readonly folders: readonly FolderRecord[];
  readonly registry: readonly { readonly id: string; readonly folderId: string | null }[];
  readonly rootSortMode: SortMode;
  /** Notebooks closed on this device (T43, A752): their notes, links and groups leave the graph. */
  readonly closed?: ReadonlySet<string>;
}

/** Each folder's top-level ancestor (itself at the top level). */
export function topLevelOf(folders: readonly FolderRecord[]): Map<string, string> {
  const parents = effectiveParents(folders);
  const top = new Map<string, string>();
  for (const folder of folders) {
    let current = folder.id;
    for (
      let parent = parents.get(current) ?? null;
      parent !== null;
      parent = parents.get(parent) ?? null
    ) {
      current = parent;
    }
    top.set(folder.id, current);
  }
  return top;
}

export function graphInput(
  local: readonly LocalLinks[],
  source: GraphSource,
): { notes: GraphNoteInput[]; groups: GraphGroup[] } {
  const top = topLevelOf(source.folders);
  const folderOf = new Map(source.registry.map((entry) => [entry.id, entry.folderId]));
  const closed = source.closed ?? new Set<string>();
  const inOpen = openNotebookFilter(source.folders, closed);
  const shown =
    closed.size === 0 ? local : local.filter((note) => inOpen(folderOf.get(note.id) ?? null));
  const ids = new Set(shown.map((note) => note.id));
  const notes = shown.map((note) => {
    const folder = folderOf.get(note.id) ?? null;
    return {
      id: note.id,
      title: displayTitle(note.title),
      group: (folder !== null ? top.get(folder) : null) ?? null,
      // Tags arrive with T18; the graph's tag filter and tag nodes appear once notes have them.
      tags: [],
      links: [
        ...new Set(
          note.links.flatMap((link) =>
            link.noteId && (closed.size === 0 || ids.has(link.noteId)) ? [link.noteId] : [],
          ),
        ),
      ],
    };
  });
  // Folders in sidebar order, then the top level.
  const tree = buildTree(source.folders, [], source.rootSortMode);
  const groups: GraphGroup[] = [
    ...tree.folders
      .filter((folder) => !closed.has(folder.id))
      .map((folder) => ({ id: folder.id, name: folder.name })),
    { id: null, name: 'Top level' },
  ];
  return { notes, groups };
}

/**
 * The last graph input, kept while what the graph shows is unchanged: the
 * notes, their titles, groups and links, and the groups. The note list
 * changes on every edit, so without this each typing pause would lay the
 * graph out again.
 */
export class GraphInputCache {
  private key = '';
  private value: ReturnType<typeof graphInput> | null = null;

  get(local: readonly LocalLinks[], source: GraphSource): ReturnType<typeof graphInput> {
    const fresh = graphInput(local, source);
    const key = JSON.stringify([
      fresh.notes.map((note) => [note.id, note.title, note.group, note.tags, note.links]),
      fresh.groups,
    ]);
    if (this.value && key === this.key) return this.value;
    this.key = key;
    this.value = fresh;
    return fresh;
  }
}
