/**
 * The folder tree, built in one place (the T39 review, T41): the sidebar's
 * tree, the folder picker (Move to folder…) and the note's folder path (its
 * breadcrumb and the Info panel) all read it from here.
 *
 * The tree is built once per workspace snapshot and note list and shared by
 * every component that asks for it, so a second reader costs nothing.
 */
import { buildTree } from '@penmoss/core/workspace';
import { useMemo } from 'react';
import { folderTrail } from '../notes/crumbs';
import { useNoteList } from '../notes/hooks';
import type { NoteListEntry } from '../notes/list';
import { useWorkspaceState } from './hooks';
import { mergeRegistry, type MergedNotes } from './model';
import type { WorkspaceSnapshot } from '@penmoss/sync-client/workspace';

export interface FolderTreeData {
  /** The registry and the note list merged (notes the registry does not know yet included). */
  readonly merged: MergedNotes;
  readonly tree: ReturnType<typeof buildTree>;
}

const built = new WeakMap<WorkspaceSnapshot, WeakMap<readonly NoteListEntry[], FolderTreeData>>();

/** The tree for this snapshot and list, built at most once for both. */
export function folderTreeOf(
  snapshot: WorkspaceSnapshot,
  list: readonly NoteListEntry[],
): FolderTreeData {
  let byList = built.get(snapshot);
  if (!byList) {
    byList = new WeakMap();
    built.set(snapshot, byList);
  }
  let data = byList.get(list);
  if (!data) {
    const merged = mergeRegistry(snapshot, list);
    data = {
      merged,
      tree: buildTree(
        snapshot.folders,
        merged.entries,
        snapshot.rootSortMode,
        snapshot.rootTogether === true,
      ),
    };
    byList.set(list, data);
  }
  return data;
}

/**
 * The folder tree, or null while `enabled` is false (the folder picker builds
 * it only while it is open, not on every edit).
 */
export function useFolderTree(enabled: true): FolderTreeData;
export function useFolderTree(enabled: boolean): FolderTreeData | null;
export function useFolderTree(enabled: boolean): FolderTreeData | null {
  const { snapshot } = useWorkspaceState();
  const list = useNoteList();
  return enabled ? folderTreeOf(snapshot, list) : null;
}

/** The folders note `id` sits in, outermost first; empty at the top level. */
export function useNoteFolders(id: string): readonly string[] {
  const { snapshot } = useWorkspaceState();
  return useMemo(
    () =>
      folderTrail(
        snapshot.folders,
        snapshot.notes.find((entry) => entry.id === id)?.folderId ?? null,
      ),
    [snapshot, id],
  );
}
