/**
 * The sidebar tree's session detail (PEN-177): `tree expand` and `tree collapse` wherever the
 * open folders change (a twisty, a key, a folder chosen, the app revealing the open note), and
 * `tree open` for a note opened from the tree, each naming the folder (and note) by its real id
 * in `refs`, which the Mac's main process swaps for a ref. The existing `click tree.toggle` and
 * `click tree.open` stay: they say which control was used; these say what changed.
 */
import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import { clampUsage } from '@penmoss/core/analytics';
import { record } from '../analytics/record';
import type { WorkspaceTree } from '@penmoss/core/workspace';
import { ancestors, type NoteRow } from './model';

/** Why the open folders changed. */
export type TreeSource = 'click' | 'key' | 'reveal';

/** How deep a folder is in its notebook's tree: 0 at the top level. */
function folderDepth(tree: WorkspaceTree, id: string): number {
  return clampUsage('index', ancestors(tree, { kind: 'folder', id }).length);
}

/** Records each folder opened or closed since the last render, with `cause`'s source. */
export function useTreeUsage(
  tree: WorkspaceTree,
  expanded: ReadonlySet<string>,
  cause: RefObject<TreeSource>,
): void {
  const before = useRef(expanded);
  const treeRef = useRef(tree);
  useLayoutEffect(() => {
    treeRef.current = tree;
  });
  useEffect(() => {
    const previous = before.current;
    before.current = expanded;
    if (previous === expanded) return;
    const source = cause.current ?? 'click';
    const known = treeRef.current;
    for (const id of expanded) {
      if (previous.has(id) || !known.byId.has(id)) continue;
      record('tree', 'expand', { depth: folderDepth(known, id), source }, { folder: id });
    }
    for (const id of previous) {
      if (expanded.has(id) || !known.byId.has(id)) continue;
      record('tree', 'collapse', { depth: folderDepth(known, id), source }, { folder: id });
    }
    cause.current = 'click';
  }, [expanded, cause]);
}

/** Records a note opened from the tree, by its ref and its folder's. */
export function recordTreeOpen(tree: WorkspaceTree, row: NoteRow, source: 'click' | 'key'): void {
  const folder = row.parentId !== null && tree.byId.has(row.parentId) ? row.parentId : null;
  const depth = folder === null ? 0 : folderDepth(tree, folder) + 1;
  record(
    'tree',
    'open',
    { depth: clampUsage('index', depth), source },
    { note: row.id, ...(folder ? { folder } : {}) },
  );
}
