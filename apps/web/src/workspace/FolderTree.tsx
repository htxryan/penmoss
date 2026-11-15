import type { FolderNode } from '@penmoss/core/workspace';
import { WorkspaceError } from '@penmoss/sync-client/workspace';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { ariaKeyShortcuts, isApplePlatform } from '@penmoss/editor/keys';
import { useKeys } from '../commands/hooks';
import { setTitle } from '@penmoss/sync-client/note';
import { useNotes } from '../notes/hooks';
import { oneLineTitle } from '@penmoss/sync-client/title';
import { isPlainLeftClick, isWindowClick, navigate, notePath } from '../router';
import { openNoteWindow } from '../window/open';
import { COPIED_AGENT_REFERENCE, useCopyAgentReference } from '../notes/agent-reference';
import { useQuickAccess } from '../notes/quick-access';
import { MAX_QUICK_ACCESS } from '@penmoss/core/quick-access';
import { ConfirmDialog } from '../shell/ConfirmDialog';
import { ContextMenu } from '../shell/ContextMenu';
import { MenuItem } from '../shell/Menu';
import { trashAll, trashedNote } from '../trash/trashed';
import { moveRequest } from './move-request';
import { isToggleClick, notesLabel, notesNamed, toggled } from './selection';
import { duplicateNote, itemsCount, transfer, type TransferResult } from './transfer';
import { useExpanded } from './expanded';
import {
  TransferMenuItems,
  TransferButtons,
  TransferPicker,
  type Transferring,
} from './TreeTransfer';
import { useWorkspace, useWorkspaceState } from './hooks';
import { useFolderTree } from './tree';
import { useTreeCommands } from './tree-commands';
import { useTreeDrop } from './tree-drop';
import { onTreeKeyDown } from './tree-keys';
import { useTreeSelection } from './tree-selection';
import { findRow, rowElement } from './tree-dom';
import { EmptyFolderRow, FolderTreeRow, NewFolderRow, NoteTreeRow, type RowPlace } from './TreeRow';
import { revealNotebooks } from '../shell/reveal-notebooks';
import { showToast, type ToastTone } from '../toasts/toasts';
import { useSource, useSourcesState } from '../sources/hooks';
import type { Source } from '../sources/registry';
import {
  ancestors,
  folderLabel,
  revealFolders,
  rowKey,
  visibleRows,
  type FolderRow,
  type ItemRef,
  type MovePlan,
  type NoteRow,
  type Row,
} from './model';

type Draft =
  | { readonly mode: 'create'; readonly parentId: string | null }
  | { readonly mode: 'rename'; readonly id: string };

const MESSAGE_MS = 6000;

export interface FolderTreeProps {
  /** The open note. */
  readonly activeId: string | null;
  /** The folder new notes and folders go into (null: the top level). */
  readonly currentFolder: string | null;
  readonly onCurrentFolderChange: (folderId: string | null) => void;
  /**
   * False while the sidebar is an icon rail (A508): the tree is hidden, so bringing the open
   * note's row into view waits until it shows again.
   */
  readonly shown?: boolean;
  /**
   * Whether this tree answers the tree commands (T50, A862): with several sources side by side,
   * the one in use does (default true); the others yield to it.
   */
  readonly active?: boolean;
}

/**
 * The sidebar's folder tree (T7): folders and notes from the WorkspaceDoc,
 * per-folder sort modes, drag-and-drop and keyboard moves. A WAI-ARIA tree
 * with a roving tab stop: ↑/↓ move, ←/→ close and open, Enter opens,
 * Alt+↑/↓ reorders, F2 renames and Delete deletes a folder. Row events are
 * handled once, on the tree.
 *
 * Notes can be selected (T42, A570): Shift-click or Shift+↑/↓ for a range,
 * ⌘-click (Ctrl-click off a Mac) or Space for one more. Right-click, the
 * context-menu key or Shift+F10 opens an in-app menu: Move to folder… and
 * Move to Trash for the selected notes, New Note Here, Rename and Delete for a folder. A click
 * below the rows chooses the top level (T52: the Top Level button went).
 */
export function FolderTree({
  activeId,
  currentFolder,
  onCurrentFolderChange,
  shown = true,
  active = true,
}: FolderTreeProps) {
  const notes = useNotes();
  const workspace = useWorkspace();
  const renameKeys = useKeys('folder.rename');
  const deleteKeys = useKeys('folder.delete');
  const { snapshot, loaded } = useWorkspaceState();
  const [expanded, setExpanded] = useExpanded();
  const { tree } = useFolderTree(true);
  const rows = useMemo(() => visibleRows(tree, expanded), [tree, expanded]);
  const current = currentFolder !== null && tree.byId.has(currentFolder) ? currentFolder : null;

  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  /** The note renamed in place, from its menu's Rename (T62 item 13). */
  const [renamingNote, setRenamingNote] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [transferring, setTransferring] = useState<Transferring | null>(null);
  // The other open notebooks, which a note or folder can move or be copied to (T68, #230).
  const source = useSource();
  const sourcesState = useSourcesState();
  const others = sourcesState.all.filter((each) => each !== source);
  const selection = useTreeSelection(rows, activeId);
  const {
    selected,
    setSelection,
    setAnchor,
    pickedFolders,
    setPicked,
    pickAnchor,
    setPickAnchor,
    menu,
    setMenu,
  } = selection;
  const treeRef = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef<string | null>(null);
  const revealed = useRef<string | null>(null);
  /** The open note was just revealed: its row scrolls into view once it shows. */
  const scrollToActive = useRef(false);

  // Notes the registry does not know yet only show at the top level (T43 review B2, A767): this
  // window never files a note it did not make; the app that made it files it.

  // Open the folders around the open note, once per note and place (so they can still be
  // closed, and open again when it moves), once the workspace says where it is, and bring
  // its row into view (T39).
  useEffect(() => {
    if (!activeId) return;
    // Read from this device is all there is to wait for (D49): no server copy is on its way.
    const around = revealFolders(activeId, snapshot, tree, loaded);
    if (around === null) return;
    const place = `${activeId} in ${around.join('/')}`;
    if (revealed.current === place) return;
    revealed.current = place;
    if (around.some((id) => !expanded.has(id))) setExpanded(around, true);
    scrollToActive.current = true;
  }, [activeId, snapshot, tree, loaded, expanded, setExpanded]);
  useEffect(() => {
    if (!scrollToActive.current || !activeId || !shown) return;
    const row = treeRef.current?.querySelector<HTMLElement>(
      `[data-key="${rowKey({ kind: 'note', id: activeId })}"]`,
    );
    if (!row) return;
    scrollToActive.current = false;
    row.scrollIntoView?.({ block: 'nearest' });
  }, [rows, activeId, shown]);

  // Focus asked for before its row existed (a new folder, a reordered row) lands once it renders.
  useLayoutEffect(() => {
    const key = pendingFocus.current;
    const element = key ? findRow(treeRef.current, key) : null;
    if (!element) return;
    pendingFocus.current = null;
    if (document.activeElement !== element) element.focus();
  });

  /** What a tree action did, as a toast at the bottom centre of the window (PEN-63). */
  const say = useCallback(
    (text: string, tone: ToastTone = 'done') =>
      showToast({ text, tone, testId: 'tree-message', ms: MESSAGE_MS }),
    [],
  );
  const copyAgentReference = useCopyAgentReference();
  const quickAccess = useQuickAccess();

  const focusRow = (key: string) => {
    setFocusKey(key);
    pendingFocus.current = key;
    findRow(treeRef.current, key)?.focus();
  };

  const rowOf = (element: HTMLElement | null): Row | undefined =>
    element ? rows.find((row) => row.key === element.dataset.key) : undefined;

  /** Applies a move; says why when it is refused. */
  const run = (plan: MovePlan): boolean => {
    if (plan.type === 'refused') {
      say(plan.reason, 'error');
      return false;
    }
    if (plan.type === 'noop') return false;
    try {
      workspace.apply(plan);
    } catch (error) {
      if (!(error instanceof WorkspaceError)) throw error;
      say(`${error.message}.`, 'error');
      return false;
    }
    if (plan.parentId !== null) {
      setExpanded([...ancestors(tree, { kind: 'folder', id: plan.parentId }), plan.parentId], true);
    }
    return true;
  };

  const startCreate = useCallback(() => {
    if (current !== null) setExpanded([current], true);
    revealNotebooks();
    setDraft({ mode: 'create', parentId: current });
  }, [current, setExpanded]);

  /** Asks to delete a folder (ConfirmDelete). */
  const askDelete = useCallback((id: string) => setDeleting(id), []);

  useTreeCommands({
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
    startRename: (id) => setDraft({ mode: 'rename', id }),
    askDelete,
  });

  const commitDraft = (name: string) => {
    const active = draft;
    setDraft(null);
    const trimmed = name.trim();
    if (!active) return;
    try {
      if (active.mode === 'create') {
        if (!trimmed) return;
        const id = workspace.createFolder(trimmed, active.parentId);
        onCurrentFolderChange(id);
        focusRow(rowKey({ kind: 'folder', id }));
      } else {
        if (trimmed && trimmed !== tree.byId.get(active.id)?.name) {
          workspace.renameFolder(active.id, trimmed);
        }
        focusRow(rowKey({ kind: 'folder', id: active.id }));
      }
    } catch (error) {
      if (!(error instanceof WorkspaceError)) throw error;
      say(`${error.message}.`, 'error');
    }
  };

  const cancelDraft = () => {
    const active = draft;
    setDraft(null);
    if (active?.mode === 'rename') focusRow(rowKey({ kind: 'folder', id: active.id }));
  };

  /** A note's new title from its row, written into the note as its title field would (T62 item 13). */
  const commitNoteRename = (id: string, name: string) => {
    setRenamingNote(null);
    focusRow(rowKey({ kind: 'note', id }));
    const title = oneLineTitle(name).trim();
    const entry = notes.list().find((each) => each.id === id);
    if (!entry || title === entry.title.trim()) return;
    notes
      .editNote(id, (doc) => setTitle(doc, title))
      .catch((error: unknown) => {
        console.error('[tree] could not rename a note', id, error);
        say('Could not rename the note.', 'error');
      });
  };

  const cancelNoteRename = () => {
    const id = renamingNote;
    setRenamingNote(null);
    if (id) focusRow(rowKey({ kind: 'note', id }));
  };

  const openNote = (row: NoteRow) => {
    onCurrentFolderChange(row.parentId);
    navigate(notePath(row.id));
  };

  // --- the context menu (A570) ---

  const titleOf = (id: string) =>
    rows.find((row): row is NoteRow => row.kind === 'note' && row.id === id)?.title ?? '';

  /** Closes the menu, focus back on its row (where the picker gives it back too). */
  const closeMenu = () => {
    const key = menu?.rowKey;
    setMenu(null);
    if (key) focusRow(key);
  };

  const moveSelected = (ids: readonly string[]) => {
    closeMenu();
    moveRequest.set(ids);
  };

  /**
   * A new note in folder `id` (T52, the folder's New Note Here; null, the top level: a top-level
   * note's, T53 item 12), opened; new notes go there next.
   */
  const newNoteIn = (id: string | null) => {
    setMenu(null);
    onCurrentFolderChange(id);
    if (id !== null) setExpanded([id], true);
    const noteId = notes.create(new Date());
    workspace.registerNote(noteId, id);
    navigate(notePath(noteId));
  };

  /** A new folder in `id` (null, the top level), named in place (T53 item 12: New Folder Here). */
  const newFolderIn = (id: string | null) => {
    setMenu(null);
    onCurrentFolderChange(id);
    if (id !== null) setExpanded([id], true);
    setDraft({ mode: 'create', parentId: id });
  };

  /** The folder a note is in, as the tree shows it (null at the top level). */
  const folderOfNote = (id: string): string | null => {
    const folderId = snapshot.notes.find((note) => note.id === id)?.folderId ?? null;
    return folderId !== null && tree.byId.has(folderId) ? folderId : null;
  };

  /** To Trash, with Undo (A524): the open note closes first, as its own Move to Trash does. */
  const trashNotes = (ids: readonly string[]) => {
    const moved = ids.map((id) => ({ id, title: titleOf(id) }));
    setMenu(null);
    setSelection([]);
    if (activeId !== null && ids.includes(activeId)) navigate('/');
    const done = trashAll(ids, (id) => notes.deleteNote(id));
    trashedNote.set({ notes: moved, done, from: notes });
  };

  /** Every note's title in this notebook, for Duplicate's "(copy N)" (T68, #227). */
  const allTitles = () => [
    ...tree.notes.map((note) => note.title),
    ...[...tree.byId.values()].flatMap((folder) => folder.notes.map((note) => note.title)),
  ];

  /** Duplicate (T68, #227): the copy just after the note, opened. */
  const duplicate = (id: string) => {
    setMenu(null);
    void duplicateNote({ notes, workspace }, tree, id, allTitles()).then((copyId) => {
      if (copyId === null) {
        say('That note has not loaded on this Mac yet, so it was not duplicated.', 'error');
        return;
      }
      setSelection([copyId]);
      setAnchor(copyId);
      pendingFocus.current = rowKey({ kind: 'note', id: copyId });
      navigate(notePath(copyId));
    });
  };

  /** Asks where in another notebook to move or copy `items` (T68, #230). */
  const askTransfer = (items: readonly ItemRef[], mode: 'move' | 'copy') => {
    const key = menu?.rowKey ?? '';
    setMenu(null);
    setTransferring({ items, mode, rowKey: key });
  };

  /**
   * Moves or copies to the chosen notebook and folder; says what happened (T68, #230). A copy
   * takes the tags or not, as the picker's Copy Tags says (A1353).
   */
  const runTransfer = (
    job: Transferring,
    target: Source,
    folderId: string | null,
    tags: boolean,
  ) => {
    setTransferring(null);
    focusRow(job.rowKey);
    const moving = job.mode === 'move';
    const leaving = moving && activeId !== null && job.items.some((item) => item.id === activeId);
    void transfer({
      from: { notes, workspace },
      to: { notes: target.notes, workspace: target.workspace },
      tree,
      items: job.items,
      folderId,
      mode: job.mode,
      tags,
    }).then(
      (result: TransferResult) => {
        if (moving) {
          setSelection([]);
          setPicked([]);
        }
        const what = itemsCount(result.notes, result.folders);
        const skipped =
          result.skipped > 0
            ? ` ${result.skipped === 1 ? 'One note has' : `${result.skipped} notes have`} not loaded on this Mac yet and stayed.`
            : '';
        const files =
          result.missingFiles > 0
            ? ` ${result.missingFiles === 1 ? 'One file' : `${result.missingFiles} files`} could not be copied.`
            : '';
        say(`${moving ? 'Moved' : 'Copied'} ${what} to “${target.name}”.${skipped}${files}`);
        // The open note moved: its copy opens, in the other notebook.
        const copy = leaving && activeId !== null ? result.copies.get(activeId) : undefined;
        if (copy) navigate(notePath(copy));
      },
      (error: unknown) => {
        say(error instanceof Error ? `${error.message}.` : 'Could not finish that.', 'error');
      },
    );
  };

  /** Click or Enter: choose a folder (opening it); on the chosen folder, open or close it. */
  const activateFolder = (row: FolderRow) => {
    if (row.id === current) {
      setExpanded([row.id]);
      return;
    }
    onCurrentFolderChange(row.id);
    if (!row.expanded) setExpanded([row.id], true);
  };

  // --- keyboard (tree-keys.ts) ---

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) =>
    onTreeKeyDown(event, {
      rows,
      rowOf,
      selection,
      focusRow,
      setExpanded,
      openNote,
      activateFolder,
    });

  const onFocus = (event: FocusEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('input')) return;
    const key = rowElement(event)?.dataset.key;
    if (key) setFocusKey(key);
  };

  // --- pointer ---

  const onClick = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest('input, .row-actions')) return;
    const row = rowOf(rowElement(event));
    if (!row) {
      // The space below the rows is the top level (T52): new notes and folders go there.
      if (!target.closest('[role="treeitem"]')) onCurrentFolderChange(null);
      return;
    }
    if (row.kind === 'folder') {
      // The second click of a double-click (rename) leaves the folder as it is.
      if (event.detail > 1) return;
      if (target.closest('.twisty')) {
        setExpanded([row.id]);
        return;
      }
      // Folders are picked like notes (T68, #230): Shift for a range, ⌘ (Ctrl) for one more.
      if (event.button === 0 && event.shiftKey && !event.altKey) {
        event.preventDefault();
        selection.pickRange(row);
        return;
      }
      if (event.button === 0 && isToggleClick(event, isApplePlatform()) && !event.altKey) {
        event.preventDefault();
        setPicked(toggled(pickedFolders, row.id));
        setPickAnchor(row.key);
        return;
      }
      setPicked([]);
      setPickAnchor(row.key);
      activateFolder(row);
    } else if (isWindowClick(event)) {
      // ⌥-click (Alt-click): the note in a new window (T45, A710). Not the browser's own
      // ⌥-click on the row's link, which downloads it.
      event.preventDefault();
      openNoteWindow(row.id);
    } else if (event.button === 0 && event.shiftKey && !event.altKey) {
      // A range, not a new window (A570); with a folder at its start, folders too (T68).
      event.preventDefault();
      if (pickedFolders.length > 0 || pickAnchor?.startsWith('folder:')) selection.pickRange(row);
      else selection.selectRange(row);
    } else if (event.button === 0 && isToggleClick(event, isApplePlatform()) && !event.altKey) {
      // One more, not a new tab: ⌘ on a Mac, where Ctrl-click is a right-click (A570).
      event.preventDefault();
      selection.toggleSelected(row);
      setPickAnchor(row.key);
    } else if (isPlainLeftClick(event)) {
      event.preventDefault();
      setSelection([row.id]);
      setAnchor(row.id);
      setPicked([]);
      setPickAnchor(row.key);
      openNote(row);
    }
  };

  const onContextMenu = (event: MouseEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('input')) return;
    const element = rowElement(event);
    const row = rowOf(element);
    if (!row || !element) return;
    event.preventDefault();
    element.focus();
    selection.openMenu(row, event.clientX, event.clientY);
  };

  const onDoubleClick = (event: MouseEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('input, .row-actions')) return;
    const row = rowOf(rowElement(event));
    if (row?.kind === 'folder') setDraft({ mode: 'rename', id: row.id });
  };

  // --- drag and drop (tree-drop.ts) ---

  const drop = useTreeDrop({ tree, rowOf, selected, setSelection, run, focusRow });
  const { dropHint } = drop;

  // --- rendering ---

  const tabStop = rows.some((row) => row.key === focusKey) ? focusKey : (rows[0]?.key ?? null);
  const folderKeys = ariaKeyShortcuts([...renameKeys, ...deleteKeys]);
  const deletingNode = deleting === null ? undefined : tree.byId.get(deleting);
  const place = (row: Row): RowPlace => ({
    drop:
      dropHint !== null && dropHint !== 'root' && dropHint.key === row.key
        ? dropHint.zone
        : undefined,
    tabStop: row.key === tabStop,
    draggable: draft === null && renamingNote === null,
  });

  const draftRow = (parentId: string | null, level: number) =>
    draft?.mode === 'create' && draft.parentId === parentId ? (
      <NewFolderRow key="draft" level={level} onCommit={commitDraft} onCancel={cancelDraft} />
    ) : null;

  const content: ReactNode[] = [draftRow(null, 1)];
  for (const row of rows) {
    if (row.kind === 'folder') {
      content.push(
        <FolderTreeRow
          key={row.key}
          row={row}
          place={place(row)}
          picked={pickedFolders.includes(row.id)}
          chosen={row.id === current}
          keyShortcuts={folderKeys}
          renaming={draft?.mode === 'rename' && draft.id === row.id}
          onRename={commitDraft}
          onCancelRename={cancelDraft}
          onNewNote={() => newNoteIn(row.id)}
        />,
      );
      content.push(draftRow(row.id, row.level + 1));
      // An open folder with nothing in it says so (#231), where its first row would be.
      if (
        row.expanded &&
        !row.hasChildren &&
        !(draft?.mode === 'create' && draft.parentId === row.id)
      ) {
        content.push(<EmptyFolderRow key={`${row.key}:empty`} level={row.level + 1} />);
      }
    } else {
      content.push(
        <NoteTreeRow
          key={row.key}
          row={row}
          place={place(row)}
          selected={selected.includes(row.id)}
          open={row.id === activeId}
          renaming={renamingNote === row.id}
          onRename={(name) => commitNoteRename(row.id, name)}
          onCancelRename={cancelNoteRename}
        />,
      );
    }
  }

  const loading = !notes.isLoaded && !loaded;
  const empty = rows.length === 0 && draft === null;

  return (
    <div className="folders">
      {loading ? (
        <p className="list-empty loading" role="status">
          <span className="spinner" aria-hidden="true" />
          Loading notes…
        </p>
      ) : (
        <div
          ref={treeRef}
          className="tree"
          role="tree"
          aria-label="Folders and notes"
          aria-multiselectable="true"
          data-testid="note-list"
          data-drop={dropHint === 'root' ? 'inside' : undefined}
          onKeyDown={onKeyDown}
          onFocus={onFocus}
          onClick={onClick}
          onDoubleClick={onDoubleClick}
          onContextMenu={onContextMenu}
          onDragStart={drop.onDragStart}
          onDragEnd={drop.onDragEnd}
          onDragOver={drop.onDragOver}
          onDragLeave={drop.onDragLeave}
          onDrop={drop.onDrop}
        >
          {empty ? <p className="list-empty">No notes yet.</p> : content}
          <div className="tree-end" data-testid="tree-root-drop" aria-hidden="true" />
        </div>
      )}
      {menu ? (
        <ContextMenu
          label={
            menu.target.kind === 'notes'
              ? notesLabel(menu.target.ids.map(titleOf))
              : menu.target.kind === 'items'
                ? itemsCount(
                    menu.target.items.filter((item) => item.kind === 'note').length,
                    menu.target.items.filter((item) => item.kind === 'folder').length,
                  )
                : `Folder ${tree.byId.get(menu.target.id)?.name ?? ''}`
          }
          caption={
            // Several notes: named, as some may be scrolled out of sight (review S1).
            menu.target.kind === 'notes' && menu.target.ids.length > 1
              ? notesNamed(menu.target.ids.map(titleOf))
              : undefined
          }
          x={menu.x}
          y={menu.y}
          onClose={closeMenu}
        >
          {menu.target.kind === 'items' ? (
            <TransferMenuItems
              items={menu.target.items}
              canTransfer={others.length > 0}
              onTransfer={askTransfer}
            />
          ) : menu.target.kind === 'notes' ? (
            <NoteMenuItems
              ids={menu.target.ids}
              onDuplicate={duplicate}
              onTransfer={
                others.length > 0
                  ? (ids, mode) =>
                      askTransfer(
                        ids.map((id) => ({ kind: 'note', id })),
                        mode,
                      )
                  : null
              }
              // Beside the note: in its folder (T53 item 12).
              onNewNote={(id) => newNoteIn(folderOfNote(id))}
              onNewFolder={(id) => newFolderIn(folderOfNote(id))}
              onWindow={(id) => {
                closeMenu();
                openNoteWindow(id);
              }}
              onCopyReference={(id) => {
                closeMenu();
                void copyAgentReference(id).then((done) =>
                  // The same words as the note's status, with no full stop (T52).
                  say(
                    done ? COPIED_AGENT_REFERENCE : 'Could not copy the agent reference',
                    done ? 'done' : 'error',
                  ),
                );
              }}
              quickAccess={quickAccess.canChange ? quickAccess.pinned : null}
              onPin={(id) => {
                closeMenu();
                if (!quickAccess.toggle(id))
                  say(
                    `Quick Access is full: it holds ${MAX_QUICK_ACCESS} notes. Unpin one to pin this note.`,
                    'error',
                  );
              }}
              onRename={(id) => {
                setMenu(null);
                setRenamingNote(id);
              }}
              onMove={moveSelected}
              onTrash={trashNotes}
            />
          ) : (
            <FolderMenuItems
              id={menu.target.id}
              onNewNote={newNoteIn}
              onNewFolder={newFolderIn}
              onTransfer={
                others.length > 0 ? (id, mode) => askTransfer([{ kind: 'folder', id }], mode) : null
              }
              onRename={(id) => {
                setMenu(null);
                setDraft({ mode: 'rename', id });
              }}
              onDelete={(id) => {
                setMenu(null);
                askDelete(id);
              }}
            />
          )}
        </ContextMenu>
      ) : null}
      {transferring ? (
        <TransferPicker
          job={transferring}
          others={others}
          title={
            transferring.items.length === 1
              ? transferring.items[0]!.kind === 'note'
                ? titleOf(transferring.items[0]!.id) || 'Untitled'
                : (tree.byId.get(transferring.items[0]!.id)?.name ?? 'Folder')
              : itemsCount(
                  transferring.items.filter((item) => item.kind === 'note').length,
                  transferring.items.filter((item) => item.kind === 'folder').length,
                )
          }
          onChoose={(target, folderId, tags) => runTransfer(transferring, target, folderId, tags)}
          onClose={() => {
            setTransferring(null);
            focusRow(transferring.rowKey);
          }}
        />
      ) : null}
      {deletingNode ? (
        <ConfirmDelete
          folder={deletingNode}
          destination={folderLabel(tree, deletingNode.effectiveParentId)}
          onCancel={() => {
            setDeleting(null);
            focusRow(rowKey({ kind: 'folder', id: deletingNode.id }));
          }}
          onConfirm={() => {
            setDeleting(null);
            try {
              workspace.deleteFolder(deletingNode.id);
            } catch (error) {
              if (!(error instanceof WorkspaceError)) throw error;
              say(`${error.message}.`, 'error');
              return;
            }
            const parent = deletingNode.effectiveParentId;
            if (current === deletingNode.id) onCurrentFolderChange(parent);
            if (parent !== null) focusRow(rowKey({ kind: 'folder', id: parent }));
            say(`Moved “${deletingNode.name}” to Trash. Its notes moved up.`);
          }}
        />
      ) : null}
    </div>
  );
}

/** The context menu's items for one note or several (A570). */
function NoteMenuItems({
  ids,
  onDuplicate,
  onTransfer,
  onNewNote,
  onNewFolder,
  onWindow,
  onCopyReference,
  quickAccess,
  onPin,
  onRename,
  onMove,
  onTrash,
}: {
  ids: readonly string[];
  /** A copy of one note just after it (T68, #227). */
  onDuplicate: (id: string) => void;
  /** To another open notebook (T68, #230); null with no other notebook open. */
  onTransfer: ((ids: readonly string[], mode: 'move' | 'copy') => void) | null;
  /** A new note or folder beside one note, in its folder (T53 item 12). */
  onNewNote: (id: string) => void;
  onNewFolder: (id: string) => void;
  /** One note in a new window (T45); a browser opens one window per click. */
  onWindow: (id: string) => void;
  /** One note's reference for an agent conversation (T52 item 4), on the clipboard. */
  onCopyReference: (id: string) => void;
  /** Whether a note is in Quick Access; null until the list can change (feedback of 6 Nov). */
  quickAccess: ((id: string) => boolean) | null;
  /** One note pinned to Quick Access, or unpinned from it. */
  onPin: (id: string) => void;
  /** One note's title edited in its row (T62 item 13). */
  onRename: (id: string) => void;
  onMove: (ids: readonly string[]) => void;
  onTrash: (ids: readonly string[]) => void;
}) {
  const several = ids.length > 1;
  const only = several ? null : (ids[0] ?? null);
  return (
    <>
      {only ? (
        <>
          <MenuItem icon="plus" data-testid="note-new-note" onClick={() => onNewNote(only)}>
            New Note Here
          </MenuItem>
          <MenuItem
            icon="folderPlus"
            data-testid="note-new-folder"
            onClick={() => onNewFolder(only)}
          >
            New Folder Here
          </MenuItem>
          <div className="menu-sep" role="separator" />
          <MenuItem icon="windowNew" onClick={() => onWindow(only)}>
            Open in New Window
          </MenuItem>
          <MenuItem
            icon="agentRef"
            onClick={() => onCopyReference(only)}
            data-testid="note-menu-copy-agent-reference"
          >
            Copy Agent Reference
          </MenuItem>
          <MenuItem
            icon="pin"
            data-testid="note-menu-quick-access"
            disabled={quickAccess === null}
            onClick={() => onPin(only)}
          >
            {quickAccess?.(only) ? 'Unpin from Quick Access' : 'Pin to Quick Access'}
          </MenuItem>
          <div className="menu-sep" role="separator" />
          <MenuItem icon="pencil" data-testid="note-menu-rename" onClick={() => onRename(only)}>
            Rename
          </MenuItem>
          <MenuItem icon="copy" data-testid="note-menu-duplicate" onClick={() => onDuplicate(only)}>
            Duplicate
          </MenuItem>
        </>
      ) : null}
      <MenuItem icon="folder" onClick={() => onMove(ids)}>
        {several ? `Move ${ids.length} Notes…` : 'Move to Folder…'}
      </MenuItem>
      {onTransfer ? (
        <TransferButtons
          noun={several ? `${ids.length} Notes` : null}
          onTransfer={(mode) => onTransfer(ids, mode)}
        />
      ) : null}
      <div className="menu-sep" role="separator" />
      <MenuItem icon="trash" danger onClick={() => onTrash(ids)}>
        {several ? `Move ${ids.length} Notes to Trash` : 'Move to Trash'}
      </MenuItem>
    </>
  );
}

/**
 * The context menu's items for a folder (A570): New Note Here (T52) and New Folder Here (T53),
 * the row's Rename and Delete.
 */
function FolderMenuItems({
  id,
  onNewNote,
  onNewFolder,
  onTransfer,
  onRename,
  onDelete,
}: {
  id: string;
  onNewNote: (id: string) => void;
  /** A folder inside it (T53 item 12). */
  onNewFolder: (id: string) => void;
  /** With its notes and subfolders, to another open notebook (T68, #230); null with none. */
  onTransfer: ((id: string, mode: 'move' | 'copy') => void) | null;
  onRename: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <>
      <MenuItem icon="plus" data-testid="folder-new-note" onClick={() => onNewNote(id)}>
        New Note Here
      </MenuItem>
      <MenuItem icon="folderPlus" data-testid="folder-new-folder" onClick={() => onNewFolder(id)}>
        New Folder Here
      </MenuItem>
      {onTransfer ? (
        <>
          <div className="menu-sep" role="separator" />
          <TransferButtons noun={null} onTransfer={(mode) => onTransfer(id, mode)} />
        </>
      ) : null}
      <div className="menu-sep" role="separator" />
      {/* The menu's own icon size, on its items' column; the row's 14px one sat 2px short (A988). */}
      <MenuItem icon="pencil" onClick={() => onRename(id)}>
        Rename
      </MenuItem>
      <div className="menu-sep" role="separator" />
      <MenuItem icon="trash" danger onClick={() => onDelete(id)}>
        Delete Folder…
      </MenuItem>
    </>
  );
}

function countNotes(folder: FolderNode): number {
  return folder.notes.length + folder.folders.reduce((sum, child) => sum + countNotes(child), 0);
}

function ConfirmDelete({
  folder,
  destination,
  onConfirm,
  onCancel,
}: {
  folder: FolderNode;
  destination: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const notes = countNotes(folder);
  const subfolders = folder.folders.length;
  const into = destination === 'The top level' ? 'the top level' : destination;
  return (
    <ConfirmDialog title={`Delete “${folder.name}”?`} onCancel={onCancel} onSubmit={onConfirm}>
      <p>
        {subfolders > 0
          ? `It and its ${subfolders === 1 ? 'subfolder' : `${subfolders} subfolders`} will be deleted. `
          : ''}
        {notes > 0
          ? `${notes === 1 ? 'Its note moves' : `Its ${notes} notes move`} to ${into}; no notes are deleted.`
          : 'It holds no notes.'}{' '}
        You can restore it from Trash for 30 days.
      </p>
      <div className="confirm-actions">
        <button type="button" className="btn" data-ui="dismiss" onClick={onCancel} autoFocus>
          Cancel
        </button>
        <button type="submit" className="btn danger-fill" data-ui="submit">
          Delete Folder
        </button>
      </div>
    </ConfirmDialog>
  );
}
