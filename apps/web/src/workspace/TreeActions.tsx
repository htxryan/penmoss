import { SORT_MODES } from '@penmoss/core/workspace';
import { ariaKeyShortcuts } from '@penmoss/editor/keys';
import { Icon } from '@penmoss/ui/icons';
import { useRef, useState } from 'react';
import { useCommands, useKeys } from '../commands/hooks';
import { useNotes } from '../notes/hooks';
import { navigate, notePath } from '../router';
import { ContextMenu } from '../shell/ContextMenu';
import { MenuItem } from '../shell/Menu';
import { withKeys } from '../shell/drawer';
import { useWorkspace } from './hooks';
import { SORT_LABELS, sortModeOf } from './model';
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
 * A notebook's actions, on its name's row (T53 item 4): New Note at its top level, New Folder,
 * and ⋯ (More Notebook Actions). They show while the pointer is over the row or focus is in it,
 * over the end of the name if it needs the room; the sync dot stays at the far right. ⋯ holds
 * Rename… (where the row can rename its notebook), Sort Order… (its own menu), Time Machine and
 * Trash, whatever the sidebar's width, so the name keeps room to be read (Ryan's review of #193,
 * R2-20 and R2-21; replaces A1392's fold below 16.5rem). It is the sidebar's right-click menu
 * (`ContextMenu`), an icon beside each item. Sort and New Folder act on the folder chosen in the
 * tree, as they did on the bar below (T52). Rendered in the notebook's source scope.
 */
export function TreeActions({
  currentFolder,
  onCurrentFolderChange,
  trash,
  timeMachine,
  onRename,
}: {
  readonly currentFolder: string | null;
  readonly onCurrentFolderChange: (folderId: string | null) => void;
  readonly trash?: TreeTrash | undefined;
  readonly timeMachine?: TreeTimeMachine | undefined;
  /** Renames the notebook in place on its row (A1383); absent where the row cannot. */
  readonly onRename?: (() => void) | undefined;
}) {
  const notes = useNotes();
  const workspace = useWorkspace();
  const commands = useCommands();
  const newFolderKeys = useKeys('folder.new');
  const { tree } = useFolderTree(true);
  const current = currentFolder !== null && tree.byId.has(currentFolder) ? currentFolder : null;
  const currentName = current === null ? 'the Top Level' : (tree.byId.get(current)?.name ?? '');
  const sortMode = sortModeOf(tree, current);
  const [sortMenu, setSortMenu] = useState<{ x: number; y: number } | null>(null);
  const [moreMenu, setMoreMenu] = useState<{ x: number; y: number } | null>(null);
  const moreButton = useRef<HTMLButtonElement>(null);
  /** Where a menu opens: under ⋯, which both open from. */
  const underMore = () => {
    const rect = moreButton.current?.getBoundingClientRect();
    return rect ? { x: rect.left, y: rect.bottom + 4 } : null;
  };
  /** Closes either menu, focus back on ⋯. */
  const closeMenus = () => {
    setMoreMenu(null);
    setSortMenu(null);
    moreButton.current?.focus();
  };
  /** An item of ⋯: the menu closes, then it runs. */
  const choose = (run: () => void) => {
    setMoreMenu(null);
    run();
  };
  /** A new note at the notebook's top level, opened; new notes go there next. */
  const newNote = () => {
    onCurrentFolderChange(null);
    const id = notes.create(new Date());
    workspace.registerNote(id, null);
    navigate(notePath(id));
  };
  const open = moreMenu !== null || sortMenu !== null;

  return (
    <div
      className="tree-actions row-end"
      data-testid="tree-actions"
      data-open={open ? '' : undefined}
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
      <button
        ref={moreButton}
        type="button"
        className="icon-btn tree-actions-more"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="More Notebook Actions"
        data-tip="More Notebook Actions"
        data-ui="menu"
        data-testid="notebook-more"
        onClick={() => {
          if (open) {
            setMoreMenu(null);
            setSortMenu(null);
          } else setMoreMenu(underMore());
        }}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowDown' || open) return;
          event.preventDefault();
          setMoreMenu(underMore());
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
          onClose={closeMenus}
        >
          {onRename ? (
            <MenuItem
              icon="pencil"
              data-testid="notebook-more-rename"
              onClick={() => choose(onRename)}
            >
              Rename…
            </MenuItem>
          ) : null}
          <MenuItem
            icon="sort"
            aria-haspopup="menu"
            data-testid="sort-order"
            data-sort={sortMode}
            onClick={() => choose(() => setSortMenu(underMore()))}
          >
            Sort Order…
          </MenuItem>
          {timeMachine || trash ? <div className="menu-sep" role="separator" /> : null}
          {timeMachine ? (
            <MenuItem
              icon="history"
              data-testid="section-time-machine"
              aria-current={timeMachine.current ? 'page' : undefined}
              onClick={() => choose(() => navigate(timeMachine.href))}
            >
              Time Machine
            </MenuItem>
          ) : null}
          {trash ? (
            <MenuItem
              icon="trash"
              data-command={trash.href === '/trash' ? 'app.trash' : undefined}
              data-testid={trash.testId}
              aria-current={trash.current ? 'page' : undefined}
              onClick={() => choose(() => navigate(trash.href))}
            >
              Trash
            </MenuItem>
          ) : null}
        </ContextMenu>
      ) : null}
      {sortMenu ? (
        <ContextMenu
          label={`Sort Order for ${currentName}`}
          x={sortMenu.x}
          y={sortMenu.y}
          anchor={moreButton}
          onClose={closeMenus}
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
                closeMenus();
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
