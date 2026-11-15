/**
 * The folder tree's commands (T20). New Folder (⌘⌥⇧N, Alt+Shift+N off a Mac, A90), Top Level
 * and the sort orders act on the current folder; with several sources side by side, the tree in
 * use answers and the others yield (A862). Move Up and Down (Alt+↑/↓), Rename (F2) and Delete
 * act on the focused row only (scope "tree").
 */
import type { WorkspaceTree } from '@penmoss/core/workspace';
import type { RefObject } from 'react';
import { useCommand } from '../commands/hooks';
import { planStep, type MovePlan, type Row } from './model';
import type { Workspace } from './service';

export function useTreeCommands({
  active,
  tree,
  treeRef,
  rowOf,
  run,
  focusRow,
  current,
  workspace,
  startCreate,
  onCurrentFolderChange,
  startRename,
  askDelete,
}: {
  /** This tree answers the commands that act on the current folder. */
  active: boolean;
  tree: WorkspaceTree;
  treeRef: RefObject<HTMLDivElement | null>;
  rowOf: (element: HTMLElement | null) => Row | undefined;
  run: (plan: MovePlan) => boolean;
  focusRow: (key: string) => void;
  /** The current folder (null: the top level). */
  current: string | null;
  workspace: Workspace;
  startCreate: () => void;
  onCurrentFolderChange: (folderId: string | null) => void;
  /** The folder's name, edited in its row. */
  startRename: (id: string) => void;
  askDelete: (id: string) => void;
}): void {
  const inUse = () => active;
  const yields = { yields: true } as const;
  useCommand('folder.new', startCreate, inUse, yields);
  useCommand('folder.topLevel', () => onCurrentFolderChange(null), inUse, yields);
  useCommand('folder.sortManual', () => workspace.setSortMode(current, 'manual'), inUse, yields);
  useCommand('folder.sortAlpha', () => workspace.setSortMode(current, 'alpha'), inUse, yields);
  useCommand(
    'folder.sortModified',
    () => workspace.setSortMode(current, 'modified'),
    inUse,
    yields,
  );

  /** The tree row with focus (not its rename field), for the row commands. */
  const focusedRow = (): Row | undefined => {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !treeRef.current?.contains(active)) return undefined;
    if (active.closest('input')) return undefined;
    return rowOf(active.closest<HTMLElement>('[data-key]'));
  };
  const focusedFolder = () => {
    const row = focusedRow();
    return row?.kind === 'folder' ? row : undefined;
  };
  const moveFocused = (delta: -1 | 1) => {
    const row = focusedRow();
    if (!row) return false;
    if (run(planStep(tree, row, delta))) focusRow(row.key);
    return true;
  };
  useCommand(
    'folder.moveUp',
    () => moveFocused(-1),
    () => focusedRow() !== undefined,
    yields,
  );
  useCommand(
    'folder.moveDown',
    () => moveFocused(1),
    () => focusedRow() !== undefined,
    yields,
  );
  useCommand(
    'folder.rename',
    () => {
      const row = focusedFolder();
      if (row) startRename(row.id);
    },
    () => focusedFolder() !== undefined,
    yields,
  );
  useCommand(
    'folder.delete',
    () => {
      const row = focusedFolder();
      if (row) askDelete(row.id);
    },
    () => focusedFolder() !== undefined,
    yields,
  );
}
