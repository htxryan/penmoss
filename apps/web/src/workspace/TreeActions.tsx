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

/** A notebook's Time Machine (PEN-21): where it is, and whether it is the page showing. */
export interface TreeTimeMachine {
  readonly href: string;
  readonly current: boolean;
}

/**
 * A notebook's actions, on its name's row (T53 item 4): New Note at its top level, the sort order
 * (a menu), New Folder and its Trash. They show while the pointer is over the row or focus is in
 * it, over the end of the name if it needs the room; the sync dot stays at the far right. Sort
 * and New Folder act on the folder chosen in the tree, as they did on the bar below (T52).
 * In a narrow row (styles.css) Sort, New Folder, Time Machine and Trash fold into a ⋯ menu, so
 * the notebook's name keeps room to be read (Ryan's review of #192, finding 19).
 * Rendered in the notebook's source scope.
 */
export function TreeActions({
  currentFolder,
  onCurrentFolderChange,
  trash,
  timeMachine,
}: {
  readonly currentFolder: string | null;
  readonly onCurrentFolderChange: (folderId: string | null) => void;
  readonly trash?: TreeTrash | undefined;
  readonly timeMachine?: TreeTimeMachine | undefined;
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
  const [moreMenu, setMoreMenu] = useState<{ x: number; y: number } | null>(null);
  const sortButton = useRef<HTMLButtonElement>(null);
  const moreButton = useRef<HTMLButtonElement>(null);
  /** The button a menu opened from: Sort's own, or ⋯ when Sort is folded into it. */
  const sortAnchor = useRef<HTMLElement | null>(null);
  const under = (button: HTMLElement | null) => {
    const rect = button?.getBoundingClientRect();
    return rect ? { x: rect.left, y: rect.bottom + 4 } : null;
  };
  const openSortMenu = (from: HTMLElement | null = sortButton.current) => {
    sortAnchor.current = from;
    const at = under(from);
    if (at) setSortMenu(at);
  };
  /** Closes the sort menu, focus back on the button it opened from. */
  const closeSortMenu = () => {
    setSortMenu(null);
    sortAnchor.current?.focus();
  };
  const closeMoreMenu = () => {
    setMoreMenu(null);
    moreButton.current?.focus();
  };
  /** A new note at the notebook's top level, opened; new notes go there next. */
  const newNote = () => {
    onCurrentFolderChange(null);
    const id = notes.create(new Date(), { folderId: null });
    workspace.registerNote(id, null);
    navigate(notePath(id));
  };

  return (
    <div
      className="tree-actions row-end"
      data-testid="tree-actions"
      data-open={sortMenu || moreMenu ? '' : undefined}
    >
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
        className="icon-btn tree-action-fold"
        aria-haspopup="menu"
        aria-expanded={sortMenu !== null}
        aria-label={`Sort Order for ${currentName}`}
        data-tip={`Sort Order for ${currentName}: ${SORT_LABELS[sortMode]}`}
        data-ui="menu"
        data-testid="sort-order"
        data-sort={sortMode}
        onClick={() => (sortMenu ? setSortMenu(null) : openSortMenu(sortButton.current))}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowDown' || sortMenu) return;
          event.preventDefault();
          openSortMenu(sortButton.current);
        }}
      >
        <Icon name="sort" />
      </button>
      <button
        type="button"
        className="icon-btn tree-action-fold"
        data-command="folder.new"
        aria-label="New Folder"
        aria-keyshortcuts={ariaKeyShortcuts(newFolderKeys) || undefined}
        data-tip={withKeys('New Folder', newFolderKeys)}
        onClick={() => commands.run('folder.new')}
      >
        <Icon name="folderPlus" />
      </button>
      {timeMachine ? (
        <a
          className="icon-btn tree-action-fold"
          href={timeMachine.href}
          data-ui="item"
          aria-label="Time Machine"
          data-tip="Time Machine"
          data-testid="section-time-machine"
          aria-current={timeMachine.current ? 'page' : undefined}
          onClick={linkHandler(timeMachine.href)}
        >
          <Icon name="history" />
        </a>
      ) : null}
      {trash ? (
        <a
          className="icon-btn tree-action-fold"
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
      {/* Shown instead of the four above in a narrow row (finding 19). */}
      <button
        ref={moreButton}
        type="button"
        className="icon-btn tree-actions-more"
        aria-haspopup="menu"
        aria-expanded={moreMenu !== null}
        aria-label="More Notebook Actions"
        data-tip="More Notebook Actions"
        data-ui="menu"
        data-testid="notebook-more"
        onClick={() => {
          if (moreMenu) setMoreMenu(null);
          else setMoreMenu(under(moreButton.current));
        }}
      >
        <Icon name="more" />
      </button>
      {moreMenu ? (
        <ContextMenu
          label="More Notebook Actions"
          x={moreMenu.x}
          y={moreMenu.y}
          anchor={moreButton}
          onClose={closeMoreMenu}
        >
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            className="menu-item"
            data-ui="item"
            aria-haspopup="menu"
            onClick={() => {
              setMoreMenu(null);
              openSortMenu(moreButton.current);
            }}
          >
            <span className="menu-label">Sort Order…</span>
          </button>
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            className="menu-item"
            data-ui="item"
            onClick={() => {
              setMoreMenu(null);
              commands.run('folder.new');
            }}
          >
            <span className="menu-label">New Folder</span>
          </button>
          {timeMachine ? (
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              className="menu-item"
              data-ui="item"
              onClick={() => {
                setMoreMenu(null);
                navigate(timeMachine.href);
              }}
            >
              <span className="menu-label">Time Machine</span>
            </button>
          ) : null}
          {trash ? (
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              className="menu-item"
              data-ui="item"
              onClick={() => {
                setMoreMenu(null);
                navigate(trash.href);
              }}
            >
              <span className="menu-label">Trash</span>
            </button>
          ) : null}
        </ContextMenu>
      ) : null}
      {sortMenu ? (
        <ContextMenu
          label={`Sort Order for ${currentName}`}
          x={sortMenu.x}
          y={sortMenu.y}
          anchor={sortAnchor}
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
