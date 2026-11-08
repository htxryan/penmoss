import { SORT_MODES } from '@penmoss/core/workspace';
import { ariaKeyShortcuts } from '@penmoss/editor/keys';
import { Icon } from '@penmoss/ui/icons';
import { useMemo, useRef, useState } from 'react';
import { useCommands, useKeys } from '../commands/hooks';
import { useNotes } from '../notes/hooks';
import { linkHandler, navigate, notePath } from '../router';
import { ContextMenu } from '../shell/ContextMenu';
import { withKeys } from '../shell/drawer';
import { useWorkspace } from './hooks';
import { SORT_LABELS, sortModeOf, withoutClosed } from './model';
import { useClosedNotebooks } from './notebooks';
import { useFolderTree } from './tree';

/** A notebook's Trash: where it is, its test id, and whether it is the page showing. */
export interface TreeTrash {
  readonly href: string;
  readonly testId: string;
  readonly current: boolean;
}

/**
 * A notebook's actions, on its name's row (T53 item 4): New Note at its top level, the sort order
 * (a menu), New Folder and its Trash. They show while the pointer is over the row or focus is in
 * it, over the end of the name if it needs the room; the sync dot stays at the far right. Sort
 * and New Folder act on the folder chosen in the tree, as they did on the bar below (T52).
 * Rendered in the notebook's source scope.
 */
export function TreeActions({
  currentFolder,
  onCurrentFolderChange,
  trash,
}: {
  readonly currentFolder: string | null;
  readonly onCurrentFolderChange: (folderId: string | null) => void;
  readonly trash?: TreeTrash | undefined;
}) {
  const notes = useNotes();
  const workspace = useWorkspace();
  const commands = useCommands();
  const newFolderKeys = useKeys('folder.new');
  const { tree: everything } = useFolderTree(true);
  const closed = useClosedNotebooks();
  const tree = useMemo(() => withoutClosed(everything, closed), [everything, closed]);
  const current = currentFolder !== null && tree.byId.has(currentFolder) ? currentFolder : null;
  const currentName = current === null ? 'the Top Level' : (tree.byId.get(current)?.name ?? '');
  const sortMode = sortModeOf(tree, current);
  const [sortMenu, setSortMenu] = useState<{ x: number; y: number } | null>(null);
  const sortButton = useRef<HTMLButtonElement>(null);
  const openSortMenu = () => {
    const rect = sortButton.current?.getBoundingClientRect();
    if (rect) setSortMenu({ x: rect.left, y: rect.bottom + 4 });
  };
  /** Closes the sort menu, focus back on its button. */
  const closeSortMenu = () => {
    setSortMenu(null);
    sortButton.current?.focus();
  };
  /** A new note at the notebook's top level, opened; new notes go there next. */
  const newNote = () => {
    onCurrentFolderChange(null);
    const id = notes.create(new Date(), { folderId: null });
    workspace.registerNote(id, null);
    navigate(notePath(id));
  };

  return (
    <div className="tree-actions" data-testid="tree-actions" data-open={sortMenu ? '' : undefined}>
      <button
        type="button"
        className="icon-btn"
        data-ui="item"
        aria-label="New Note in This Notebook"
        data-tip="New Note in This Notebook"
        data-testid="notebook-new-note"
        onClick={newNote}
      >
        <Icon name="plus" />
      </button>
      <button
        ref={sortButton}
        type="button"
        className="icon-btn"
        aria-haspopup="menu"
        aria-expanded={sortMenu !== null}
        aria-label={`Sort Order for ${currentName}`}
        data-tip={`Sort Order for ${currentName}: ${SORT_LABELS[sortMode]}`}
        data-ui="menu"
        data-testid="sort-order"
        data-sort={sortMode}
        onClick={() => (sortMenu ? setSortMenu(null) : openSortMenu())}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowDown' || sortMenu) return;
          event.preventDefault();
          openSortMenu();
        }}
      >
        <Icon name="sort" />
      </button>
      <button
        type="button"
        className="icon-btn"
        data-command="folder.new"
        aria-label="New Folder"
        aria-keyshortcuts={ariaKeyShortcuts(newFolderKeys) || undefined}
        data-tip={withKeys('New Folder', newFolderKeys)}
        onClick={() => commands.run('folder.new')}
      >
        <Icon name="folderPlus" />
      </button>
      {trash ? (
        <a
          className="icon-btn"
          href={trash.href}
          data-command={trash.href === '/trash' ? 'app.trash' : undefined}
          aria-label="Trash"
          data-tip="Trash"
          data-testid={trash.testId}
          aria-current={trash.current ? 'page' : undefined}
          onClick={linkHandler(trash.href)}
        >
          <Icon name="trash" />
        </a>
      ) : null}
      {sortMenu ? (
        <ContextMenu
          label={`Sort Order for ${currentName}`}
          x={sortMenu.x}
          y={sortMenu.y}
          anchor={sortButton}
          onClose={closeSortMenu}
        >
          {SORT_MODES.map((mode) => (
            <button
              key={mode}
              type="button"
              role="menuitemradio"
              aria-checked={mode === sortMode}
              tabIndex={-1}
              className="menu-item"
              data-ui="item"
              onClick={() => {
                workspace.setSortMode(current, mode);
                closeSortMenu();
              }}
            >
              <span className="menu-check" aria-hidden="true">
                {mode === sortMode ? <Icon name="check" /> : null}
              </span>
              <span className="menu-label">{SORT_LABELS[mode]}</span>
            </button>
          ))}
        </ContextMenu>
      ) : null}
    </div>
  );
}
