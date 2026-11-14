import { Icon } from '@penmoss/ui/icons';
import type { FolderNode } from '@penmoss/core/workspace';
import { WorkspaceError } from '@penmoss/sync-client/workspace';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { ariaKeyShortcuts, isApplePlatform } from '@penmoss/editor/keys';
import { useCommand, useKeys } from '../commands/hooks';
import { setTitle } from '@penmoss/sync-client/note';
import { useNotes } from '../notes/hooks';
import { oneLineTitle } from '../notes/title';
import { isPlainLeftClick, isWindowClick, navigate, notePath } from '../router';
import { openNoteWindow } from '../window/open';
import { COPIED_AGENT_REFERENCE, useCopyAgentReference } from '../notes/agent-reference';
import { useQuickAccess } from '../notes/quick-access';
import { MAX_QUICK_ACCESS } from '@penmoss/core/quick-access';
import { ContextMenu } from '../shell/ContextMenu';
import { trashAll, trashedNote } from '../trash/trashed';
import { moveRequest } from './move-request';
import {
  isToggleClick,
  menuTargets,
  noteRange,
  notesLabel,
  notesNamed,
  rowRange,
  selectionAfterOpen,
  toggled,
  visibleFolders,
  visibleSelection,
} from './selection';
import { FolderPicker } from './FolderPicker';
import { useCopyTagsDefault } from './copy-tags-state';
import { duplicateNote, itemsCount, transfer, type TransferResult } from './transfer';
import { folderTreeOf } from './tree';
import { useExpanded } from './expanded';
import { useWorkspace, useWorkspaceState } from './hooks';
import { useFolderTree } from './tree';
import { revealNotebooks } from '../shell/reveal-notebooks';
import { showToast, type ToastTone } from '../toasts/toasts';
import { NOTE_DRAG_TYPE } from '../notes/note-drag';
import { useIsGitSource, useSource, useSourcesState } from '../sources/hooks';
import type { Source } from '../sources/registry';
import { setNotebookOpen, useClosedNotebooks } from './notebooks';
import {
  ancestors,
  dropZone,
  folderLabel,
  planDrop,
  planStep,
  sortModeOf,
  revealFolders,
  rowKey,
  folderChoices,
  SORT_LABELS,
  visibleRows,
  type DropTarget,
  type DropZone,
  type FolderRow,
  type ItemRef,
  type MovePlan,
  type NoteRow,
  type Row,
  withoutClosed,
} from './model';

type Draft =
  | { readonly mode: 'create'; readonly parentId: string | null; readonly notebook?: true }
  | { readonly mode: 'rename'; readonly id: string };

/** A notebook change that asks first (T43): turning it back into a folder, or deleting it. */
type NotebookConfirm = { readonly kind: 'unflag' | 'delete'; readonly id: string };

type DropHint = { readonly key: string; readonly zone: DropZone } | 'root' | null;

/** The open context menu (A570): where, on what, and the row focus goes back to. */
type ContextTarget =
  | { readonly kind: 'notes'; readonly ids: readonly string[] }
  | { readonly kind: 'folder'; readonly id: string }
  /** Folders and notes picked together (T68, #230): what goes to another notebook at once. */
  | { readonly kind: 'items'; readonly items: readonly ItemRef[] };

/** Moving or copying to another open notebook (T68, #230): what, and which way. */
interface Transferring {
  readonly items: readonly ItemRef[];
  readonly mode: 'move' | 'copy';
  readonly rowKey: string;
}

/** The other notebook's folder chosen in the picker: its source's id, then the folder's. */
const choiceKey = (sourceId: string, folderId: string | null) =>
  `${sourceId}\u0000${folderId ?? ''}`;

interface MenuState {
  readonly x: number;
  readonly y: number;
  readonly target: ContextTarget;
  readonly rowKey: string;
}

const MESSAGE_MS = 6000;

const depth = (level: number) => ({ '--depth': level - 1 }) as CSSProperties;

/** The row element an event came from (null: the tree's empty space). */
const rowElement = (event: { target: EventTarget }) =>
  (event.target as HTMLElement).closest<HTMLElement>('[data-key]');

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
  // A git notebook is one notebook (T39 pass 3 review, A912): no notebooks inside it, so no Turn
  // into notebook, New notebook or Close on this device there.
  const git = useIsGitSource();
  const [expanded, setExpanded] = useExpanded();
  const { tree: everything } = useFolderTree(true);
  // Notebooks closed on this device leave the tree (T43, A752).
  const closed = useClosedNotebooks();
  const tree = useMemo(() => withoutClosed(everything, closed), [everything, closed]);
  const rows = useMemo(() => visibleRows(tree, expanded), [tree, expanded]);
  const current = currentFolder !== null && tree.byId.has(currentFolder) ? currentFolder : null;

  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  /** The note renamed in place, from its menu's Rename (T62 item 13). */
  const [renamingNote, setRenamingNote] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<NotebookConfirm | null>(null);
  const [dropHint, setDropHint] = useState<DropHint>(null);
  /** Selected notes (A570), in the order chosen; `anchor` is where a Shift range starts. */
  const [selection, setSelection] = useState<readonly string[]>([]);
  const [anchor, setAnchor] = useState<string | null>(null);
  /**
   * Folders picked with Shift- or ⌘-click (T68, #230), beside the selected notes, and the row
   * a Shift range with a folder in it starts from.
   */
  const [picked, setPicked] = useState<readonly string[]>([]);
  const [pickAnchor, setPickAnchor] = useState<string | null>(null);
  const [transferring, setTransferring] = useState<Transferring | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  // The other open notebooks, which a note or folder can move or be copied to (T68, #230).
  const source = useSource();
  const sourcesState = useSourcesState();
  const others = (sourcesState?.all ?? []).filter((each) => each !== source);
  /** The sort order's menu (T52), open under its button. */
  // Another note opened: the selection starts afresh unless a click just chose it (S1).
  const [selectionFor, setSelectionFor] = useState(activeId);
  if (selectionFor !== activeId) {
    setSelectionFor(activeId);
    const next = selectionAfterOpen(selection, activeId);
    if (next.length !== selection.length) {
      setSelection(next);
      setAnchor(activeId);
    }
  }
  const treeRef = useRef<HTMLDivElement>(null);
  const dragged = useRef<ItemRef | null>(null);
  const pendingFocus = useRef<string | null>(null);
  const revealed = useRef<string | null>(null);
  /** The open note was just revealed: its row scrolls into view once it shows. */
  const scrollToActive = useRef(false);

  // Notes the registry does not know yet only show at the top level (T43 review B2, A767): this
  // window never files a note it did not make. A phone's new note may be on its way into a
  // notebook; the app that made it files it, or the server does once its notebook is known.

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

  /** Asks to delete a folder: a notebook goes to Trash with its notes, so it says so (T43). */
  const askDelete = useCallback(
    (id: string) => {
      if (tree.byId.get(id)?.notebook === true) setConfirming({ kind: 'delete', id });
      else setDeleting(id);
    },
    [tree],
  );

  /** Turns a top-level folder into a notebook, or (after asking) back (T43, A756). */
  const flagNotebook = (id: string, on: boolean) => {
    const name = tree.byId.get(id)?.name ?? '';
    try {
      workspace.setNotebook(id, on);
    } catch (error) {
      if (!(error instanceof WorkspaceError)) throw error;
      say(`${error.message}.`, 'error');
      return;
    }
    say(
      on
        ? `“${name}” is a notebook. Choose where it is mirrored in Settings → Git Mirror.`
        : `“${name}” is a folder again; its notes publish with the default notebook, and its own repository’s mirroring is paused.`,
    );
  };

  /** Deletes a notebook: it and its notes go to Trash, never into the default notebook (A755). */
  const deleteNotebook = (id: string) => {
    const node = tree.byId.get(id);
    if (!node) return;
    const folderOf = new Map(snapshot.notes.map((note) => [note.id, note.folderId]));
    let trashed: readonly string[];
    try {
      trashed = workspace.deleteFolder(id).trashed;
    } catch (error) {
      if (!(error instanceof WorkspaceError)) throw error;
      say(`${error.message}.`, 'error');
      return;
    }
    if (activeId !== null && trashed.includes(activeId)) navigate('/');
    if (current === id) onCurrentFolderChange(null);
    for (const noteId of trashed) {
      void notes.deleteNote(noteId, { folderId: folderOf.get(noteId) ?? null });
    }
    say(
      `Moved the notebook “${node.name}” and ${trashed.length === 1 ? 'its note' : `its ${trashed.length} notes`} to Trash.`,
    );
  };

  /** Closes a notebook on this device (A752): it leaves the sidebar, search and Recent here. */
  const closeNotebook = (id: string) => {
    const name = tree.byId.get(id)?.name ?? '';
    if (
      current === id ||
      (current !== null && ancestors(tree, { kind: 'folder', id: current }).includes(id))
    ) {
      onCurrentFolderChange(null);
    }
    setNotebookOpen(id, false);
    say(`Closed “${name}” on this device. Open it again in Settings → Notebooks.`);
  };

  // Commands (T20): ⌘⌥⇧N (Alt+Shift+N off a Mac, A90) makes a folder in the current folder; the rest have no keys.
  // With several sources side by side, the tree in use answers; the others yield (A862).
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
  // Alt+↑/↓, F2 and Delete by default; they act on the focused row only (scope "tree").
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
      if (row) setDraft({ mode: 'rename', id: row.id });
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

  const commitDraft = (name: string) => {
    const active = draft;
    setDraft(null);
    const trimmed = name.trim();
    if (!active) return;
    try {
      if (active.mode === 'create') {
        if (!trimmed) return;
        const id = active.notebook
          ? workspace.createNotebook(trimmed)
          : workspace.createFolder(trimmed, active.parentId);
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

  // --- selection and the context menu (A570) ---

  const selected = visibleSelection(rows, selection);
  const pickedFolders = visibleFolders(rows, picked);

  /** Shift-click with a folder at either end: the notes and folders between (T68, #230). */
  const pickRange = (row: Row) => {
    const from = pickAnchor ?? (activeId === null ? null : rowKey({ kind: 'note', id: activeId }));
    const between = rowRange(rows, from, row.key);
    setSelection(between.filter((each) => each.kind === 'note').map((each) => each.id));
    setPicked(between.filter((each) => each.kind === 'folder').map((each) => each.id));
    if (from === null) setPickAnchor(row.key);
  };
  const titleOf = (id: string) =>
    rows.find((row): row is NoteRow => row.kind === 'note' && row.id === id)?.title ?? '';

  /** Shift: the notes from the anchor (or the open note) to `row`. */
  const selectRange = (row: NoteRow) => {
    const from = anchor ?? activeId;
    setSelection(noteRange(rows, from, row.id));
    if (from === null) setAnchor(row.id);
  };
  const toggleSelected = (row: NoteRow) => {
    // Only what was chosen here: the open note is not added unseen (review S1).
    setSelection(toggled(selected, row.id));
    setAnchor(row.id);
  };

  const openMenu = (row: Row, x: number, y: number) => {
    const inPicks =
      pickedFolders.length > 0 &&
      (row.kind === 'folder' ? pickedFolders.includes(row.id) : selected.includes(row.id));
    if (inPicks && pickedFolders.length + selected.length > 1) {
      // Folders and notes picked together: in the tree's order.
      const chosen = new Set([...pickedFolders, ...selected]);
      const items = rows
        .filter((each) => chosen.has(each.id))
        .map((each): ItemRef => ({ kind: each.kind, id: each.id }));
      setMenu({ x, y, target: { kind: 'items', items }, rowKey: row.key });
      return;
    }
    if (pickedFolders.length > 0 && !inPicks) setPicked([]);
    if (row.kind === 'note') {
      const ids = menuTargets(selected, row.id);
      if (ids.length === 1) {
        setSelection([row.id]);
        setAnchor(row.id);
      }
      setMenu({ x, y, target: { kind: 'notes', ids }, rowKey: row.key });
    } else {
      setMenu({ x, y, target: { kind: 'folder', id: row.id }, rowKey: row.key });
    }
  };

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
    const noteId = notes.create(new Date(), { folderId: id });
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
    ...everything.notes.map((note) => note.title),
    ...[...everything.byId.values()].flatMap((folder) => folder.notes.map((note) => note.title)),
  ];

  /** Duplicate (T68, #227): the copy just after the note, opened. */
  const duplicate = (id: string) => {
    setMenu(null);
    void duplicateNote({ notes, workspace }, everything, id, allTitles()).then((copyId) => {
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
      tree: everything,
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

  // --- keyboard ---

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('input')) return;
    const row = rowOf(rowElement(event));
    if (!row) return;
    const index = rows.indexOf(row);
    const handled = () => {
      event.preventDefault();
      event.stopPropagation();
    };
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        // Alt+↑/↓ (moving the row) is a command (T20): rebound, the keys do nothing here.
        if (event.altKey || event.metaKey || event.ctrlKey) return;
        handled();
        const delta = event.key === 'ArrowDown' ? 1 : -1;
        const next = rows[index + delta];
        if (!next) return;
        focusRow(next.key);
        // Shift+↑/↓: the selection grows from where it started (A570).
        if (event.shiftKey && next.kind === 'note') {
          const from = anchor ?? (row.kind === 'note' ? row.id : null);
          setSelection(noteRange(rows, from, next.id));
          if (anchor === null) setAnchor(from ?? next.id);
        }
        return;
      }
      case ' ':
        // Space: a note in or out of the selection (A570).
        if (row.kind !== 'note' || event.altKey || event.metaKey || event.ctrlKey) return;
        handled();
        toggleSelected(row);
        return;
      case 'ContextMenu':
      case 'F10': {
        if (event.key === 'F10' && !event.shiftKey) return;
        handled();
        const rect = (event.target as HTMLElement).getBoundingClientRect();
        openMenu(row, rect.left + 24, rect.bottom);
        return;
      }
      case 'Escape':
        if (selected.length < 2) return;
        handled();
        setSelection(row.kind === 'note' ? [row.id] : []);
        return;
      case 'Home':
      case 'End': {
        handled();
        const edge = event.key === 'Home' ? rows[0] : rows.at(-1);
        if (edge) focusRow(edge.key);
        return;
      }
      case 'ArrowRight': {
        handled();
        if (row.kind !== 'folder') return;
        const next = rows[index + 1];
        // Every folder opens, an empty one too (#231): it shows that it is empty.
        if (!row.expanded) setExpanded([row.id], true);
        else if (row.expanded && next?.parentId === row.id) focusRow(next.key);
        return;
      }
      case 'ArrowLeft':
        handled();
        if (row.kind === 'folder' && row.expanded) {
          setExpanded([row.id], false);
        } else if (row.parentId !== null) {
          focusRow(rowKey({ kind: 'folder', id: row.parentId }));
        }
        return;
      case 'Enter':
        handled();
        if (row.kind === 'note') {
          // As a click: the note opened is the one chosen.
          setSelection([row.id]);
          setAnchor(row.id);
          openNote(row);
        } else activateFolder(row);
        return;
    }
  };

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
        pickRange(row);
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
      if (pickedFolders.length > 0 || pickAnchor?.startsWith('folder:')) pickRange(row);
      else selectRange(row);
    } else if (event.button === 0 && isToggleClick(event, isApplePlatform()) && !event.altKey) {
      // One more, not a new tab: ⌘ on a Mac, where Ctrl-click is a right-click (A570).
      event.preventDefault();
      toggleSelected(row);
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
    openMenu(row, event.clientX, event.clientY);
  };

  const onDoubleClick = (event: MouseEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('input, .row-actions')) return;
    const row = rowOf(rowElement(event));
    if (row?.kind === 'folder') setDraft({ mode: 'rename', id: row.id });
  };

  // --- drag and drop: a drop on a row goes beside or into it; on empty space, to the top level ---

  const dropTarget = (event: DragEvent<HTMLElement>): DropTarget => {
    const element = rowElement(event);
    const row = rowOf(element);
    if (!element || !row) return { kind: 'root' };
    const rect = element.getBoundingClientRect();
    const zone = dropZone(row.kind, event.clientY - rect.top, rect.height);
    // A note dropped on a folder goes into it, unless the folder's own folder is sorted Manual:
    // there its top and bottom quarters place the note above or below it (T62 item 6).
    const into =
      row.kind === 'folder' &&
      dragged.current?.kind === 'note' &&
      sortModeOf(tree, row.parentId) !== 'manual';
    return { kind: row.kind, id: row.id, zone: into ? 'inside' : zone };
  };

  const onDragStart = (event: DragEvent<HTMLDivElement>) => {
    const row = rowOf(rowElement(event));
    if (!row) return;
    dragged.current = { kind: row.kind, id: row.id };
    // A drag moves the row dragged, alone: a highlighted selection must not suggest otherwise
    // (review N5); the menu's Move takes a selection.
    if (selected.length > 1) setSelection(row.kind === 'note' ? [row.id] : []);
    // Copy too: a note dropped on Quick Access is pinned there, not moved (T53 item 10).
    event.dataTransfer.effectAllowed = row.kind === 'note' ? 'copyMove' : 'move';
    event.dataTransfer.setData('text/plain', row.kind === 'folder' ? row.name : row.title);
    if (row.kind === 'note') event.dataTransfer.setData(NOTE_DRAG_TYPE, row.id);
  };

  const onDragEnd = () => {
    dragged.current = null;
    setDropHint(null);
  };

  const onDragOver = (event: DragEvent<HTMLElement>) => {
    if (!dragged.current) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const target = dropTarget(event);
    const hint: DropHint =
      target.kind === 'root' ? 'root' : { key: rowKey(target), zone: target.zone };
    setDropHint((previous) =>
      previous === hint ||
      (previous !== null &&
        previous !== 'root' &&
        hint !== 'root' &&
        previous.key === hint.key &&
        previous.zone === hint.zone)
        ? previous
        : hint,
    );
  };

  const onDrop = (event: DragEvent<HTMLElement>) => {
    const item = dragged.current;
    if (!item) return;
    event.preventDefault();
    const target = dropTarget(event);
    onDragEnd();
    if (run(planDrop(tree, item, target))) focusRow(rowKey(item));
  };

  const onDragLeave = (event: DragEvent<HTMLElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropHint(null);
  };

  // --- rendering ---

  const tabStop = rows.some((row) => row.key === focusKey) ? focusKey : (rows[0]?.key ?? null);
  const folderKeys = ariaKeyShortcuts([...renameKeys, ...deleteKeys]);
  const deletingNode = deleting === null ? undefined : tree.byId.get(deleting);
  const common = (row: Row) => ({
    'data-key': row.key,
    'data-drop':
      dropHint !== null && dropHint !== 'root' && dropHint.key === row.key
        ? dropHint.zone
        : undefined,
    role: 'treeitem',
    'aria-level': row.level,
    'aria-setsize': row.setSize,
    'aria-posinset': row.posInSet,
    tabIndex: row.key === tabStop ? 0 : -1,
    draggable: draft === null && renamingNote === null,
    style: depth(row.level),
  });

  const draftRow = (parentId: string | null, level: number) =>
    draft?.mode === 'create' && draft.parentId === parentId ? (
      <div
        key="draft"
        role="treeitem"
        aria-level={level}
        aria-selected={false}
        className="tree-row draft-row"
        style={depth(level)}
      >
        <span className="twisty" data-empty="" aria-hidden="true" />
        {draft.notebook ? <NotebookIcon /> : <FolderIcon />}
        <NameInput
          label={draft.notebook ? 'New notebook name' : 'New folder name'}
          initial=""
          onCommit={commitDraft}
          onCancel={cancelDraft}
        />
      </div>
    ) : null;

  const content: ReactNode[] = [draftRow(null, 1)];
  for (const row of rows) {
    if (row.kind === 'folder') {
      const renaming = draft?.mode === 'rename' && draft.id === row.id;
      content.push(
        <div
          key={row.key}
          {...common(row)}
          className={row.notebook ? 'tree-row folder-row notebook-row' : 'tree-row folder-row'}
          data-notebook={row.notebook ? '' : undefined}
          data-section-start={row.sectionStart ? '' : undefined}
          data-picked={pickedFolders.includes(row.id) ? '' : undefined}
          aria-label={row.notebook ? `${row.name} (notebook)` : row.name}
          aria-expanded={row.expanded}
          aria-selected={row.id === current}
          aria-keyshortcuts={folderKeys || undefined}
        >
          <span className="twisty" data-open={row.expanded} aria-hidden="true">
            <ChevronIcon />
          </span>
          {row.notebook ? <NotebookIcon /> : <FolderIcon />}
          {renaming ? (
            <NameInput
              label={`Rename ${row.notebook ? 'notebook' : 'folder'} ${row.name}`}
              initial={row.name}
              onCommit={commitDraft}
              onCancel={cancelDraft}
            />
          ) : (
            <span className="tree-label">{row.name}</span>
          )}
          {row.sortMode !== 'manual' && !renaming ? (
            <span className="sort-badge">{SORT_LABELS[row.sortMode]}</span>
          ) : null}
          {renaming ? null : (
            <span className="row-actions">
              {/* A new note in it (T53 item 5), as its menu's New Note Here. Rename and Delete are
                  in its menu only (Quanta feedback 2, A1120). */}
              <button
                type="button"
                tabIndex={-1}
                className="icon-btn"
                data-ui="item"
                aria-label={`New Note in ${row.name}`}
                data-tip="New Note Here"
                data-testid="folder-row-new-note"
                onClick={() => newNoteIn(row.id)}
              >
                <PlusIcon />
              </button>
            </span>
          )}
        </div>,
      );
      content.push(draftRow(row.id, row.level + 1));
      // An open folder with nothing in it says so (#231), where its first row would be.
      if (
        row.expanded &&
        !row.hasChildren &&
        !(draft?.mode === 'create' && draft.parentId === row.id)
      ) {
        content.push(
          <div
            key={`${row.key}:empty`}
            className="tree-row tree-empty-row"
            style={depth(row.level + 1)}
            aria-hidden="true"
            data-testid="tree-empty-folder"
          >
            <span className="twisty" data-empty="" />
            <span className="tree-label">Empty</span>
          </div>,
        );
      }
    } else {
      content.push(
        <div
          key={row.key}
          {...common(row)}
          className="tree-row note-row"
          aria-label={row.title}
          aria-selected={selected.includes(row.id)}
          // No tooltip (A1119): the tree shows where the note is, and the time it was last edited
          // covered the rows below.
        >
          <span className="twisty" data-empty="" aria-hidden="true" />
          {renamingNote === row.id ? (
            <span className="tree-link">
              <NoteIcon />
              <NameInput
                label={`Rename note ${row.title}`}
                initial={row.untitled ? '' : row.title}
                placeholder="Untitled"
                onCommit={(name) => commitNoteRename(row.id, name)}
                onCancel={cancelNoteRename}
              />
            </span>
          ) : (
            <a
              className="tree-link"
              href={notePath(row.id)}
              tabIndex={-1}
              draggable={false}
              aria-current={row.id === activeId ? 'page' : undefined}
              data-untitled={row.untitled ? '' : undefined}
            >
              <NoteIcon />
              <span className="tree-label">{row.title}</span>
            </a>
          )}
        </div>,
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
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
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
                : `${tree.byId.get(menu.target.id)?.notebook ? 'Notebook' : 'Folder'} ${tree.byId.get(menu.target.id)?.name ?? ''}`
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
                void copyAgentReference(id, titleOf(id)).then((done) =>
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
              kind={
                tree.byId.get(menu.target.id)?.notebook === true
                  ? 'notebook'
                  : tree.byId.get(menu.target.id)?.effectiveParentId === null && !git
                    ? 'top'
                    : 'folder'
              }
              onNewNote={newNoteIn}
              onNewFolder={newFolderIn}
              onTransfer={
                others.length > 0 && tree.byId.get(menu.target.id)?.notebook !== true
                  ? (id, mode) => askTransfer([{ kind: 'folder', id }], mode)
                  : null
              }
              onRename={(id) => {
                setMenu(null);
                setDraft({ mode: 'rename', id });
              }}
              onDelete={(id) => {
                setMenu(null);
                askDelete(id);
              }}
              onNotebook={(id, on) => {
                closeMenu();
                if (on) flagNotebook(id, true);
                else setConfirming({ kind: 'unflag', id });
              }}
              onCloseNotebook={
                git
                  ? null
                  : (id) => {
                      setMenu(null);
                      closeNotebook(id);
                    }
              }
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
      {confirming && tree.byId.get(confirming.id) ? (
        <ConfirmNotebook
          kind={confirming.kind}
          folder={tree.byId.get(confirming.id)!}
          onCancel={() => {
            setConfirming(null);
            focusRow(rowKey({ kind: 'folder', id: confirming.id }));
          }}
          onConfirm={() => {
            setConfirming(null);
            if (confirming.kind === 'delete') deleteNotebook(confirming.id);
            else {
              flagNotebook(confirming.id, false);
              focusRow(rowKey({ kind: 'folder', id: confirming.id }));
            }
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
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            className="menu-item"
            data-ui="item"
            data-testid="note-new-note"
            onClick={() => onNewNote(only)}
          >
            <Icon name="plus" />
            <span className="menu-label">New Note Here</span>
          </button>
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            className="menu-item"
            data-ui="item"
            data-testid="note-new-folder"
            onClick={() => onNewFolder(only)}
          >
            <Icon name="folderPlus" />
            <span className="menu-label">New Folder Here</span>
          </button>
          <div className="menu-sep" role="separator" />
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            className="menu-item"
            data-ui="item"
            onClick={() => onWindow(only)}
          >
            <Icon name="windowNew" />
            <span className="menu-label">Open in New Window</span>
          </button>
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            className="menu-item"
            data-ui="item"
            onClick={() => onCopyReference(only)}
            data-testid="note-menu-copy-agent-reference"
          >
            <Icon name="agentRef" />
            <span className="menu-label">Copy Agent Reference</span>
          </button>
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            className="menu-item"
            data-ui="item"
            data-testid="note-menu-quick-access"
            disabled={quickAccess === null}
            onClick={() => onPin(only)}
          >
            <Icon name="pin" />
            <span className="menu-label">
              {quickAccess?.(only) ? 'Unpin from Quick Access' : 'Pin to Quick Access'}
            </span>
          </button>
          <div className="menu-sep" role="separator" />
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            className="menu-item"
            data-ui="item"
            data-testid="note-menu-rename"
            onClick={() => onRename(only)}
          >
            <Icon name="pencil" />
            <span className="menu-label">Rename</span>
          </button>
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            className="menu-item"
            data-ui="item"
            data-testid="note-menu-duplicate"
            onClick={() => onDuplicate(only)}
          >
            <Icon name="copy" />
            <span className="menu-label">Duplicate</span>
          </button>
        </>
      ) : null}
      <button
        type="button"
        role="menuitem"
        tabIndex={-1}
        className="menu-item"
        data-ui="item"
        onClick={() => onMove(ids)}
      >
        <Icon name="folder" />
        <span className="menu-label">
          {several ? `Move ${ids.length} Notes…` : 'Move to Folder…'}
        </span>
      </button>
      {onTransfer ? (
        <TransferButtons
          noun={several ? `${ids.length} Notes` : null}
          onTransfer={(mode) => onTransfer(ids, mode)}
        />
      ) : null}
      <div className="menu-sep" role="separator" />
      <button
        type="button"
        role="menuitem"
        tabIndex={-1}
        className="menu-item danger"
        data-ui="item"
        onClick={() => onTrash(ids)}
      >
        <Icon name="trash" />
        <span className="menu-label">
          {several ? `Move ${ids.length} Notes to Trash` : 'Move to Trash'}
        </span>
      </button>
    </>
  );
}

/**
 * The context menu's items for a folder (A570): New Note Here (T52) and New Folder Here (T53),
 * the row's Rename and Delete,
 * and for a top-level folder Turn into notebook, or for a notebook Close and Turn back into a
 * folder (T43, A756).
 */
function FolderMenuItems({
  id,
  kind,
  onNewNote,
  onNewFolder,
  onTransfer,
  onRename,
  onDelete,
  onNotebook,
  onCloseNotebook,
}: {
  id: string;
  kind: 'folder' | 'top' | 'notebook';
  onNewNote: (id: string) => void;
  /** A folder inside it (T53 item 12). */
  onNewFolder: (id: string) => void;
  /** With its notes and subfolders, to another open notebook (T68, #230); null with none. */
  onTransfer: ((id: string, mode: 'move' | 'copy') => void) | null;
  onRename: (id: string) => void;
  onDelete: (id: string) => void;
  onNotebook: (id: string, on: boolean) => void;
  /** Null in a git notebook, which has no Settings → Notebooks to open it again (A912). */
  onCloseNotebook: ((id: string) => void) | null;
}) {
  return (
    <>
      <button
        type="button"
        role="menuitem"
        tabIndex={-1}
        className="menu-item"
        data-ui="item"
        data-testid="folder-new-note"
        onClick={() => onNewNote(id)}
      >
        <Icon name="plus" />
        <span className="menu-label">New Note Here</span>
      </button>
      <button
        type="button"
        role="menuitem"
        tabIndex={-1}
        className="menu-item"
        data-ui="item"
        data-testid="folder-new-folder"
        onClick={() => onNewFolder(id)}
      >
        <Icon name="folderPlus" />
        <span className="menu-label">New Folder Here</span>
      </button>
      {onTransfer ? (
        <>
          <div className="menu-sep" role="separator" />
          <TransferButtons noun={null} onTransfer={(mode) => onTransfer(id, mode)} />
        </>
      ) : null}
      <div className="menu-sep" role="separator" />
      {kind === 'top' ? (
        <>
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            className="menu-item"
            data-ui="item"
            onClick={() => onNotebook(id, true)}
          >
            <Icon name="notebook" />
            <span className="menu-label">Turn into Notebook</span>
          </button>
          <div className="menu-sep" role="separator" />
        </>
      ) : null}
      {kind === 'notebook' ? (
        <>
          {onCloseNotebook ? (
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              className="menu-item"
              data-ui="item"
              onClick={() => onCloseNotebook(id)}
            >
              <Icon name="close" />
              <span className="menu-label">Close on This Device</span>
            </button>
          ) : null}
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            className="menu-item"
            data-ui="item"
            onClick={() => onNotebook(id, false)}
          >
            <Icon name="folder" />
            <span className="menu-label">Turn Back into a Folder…</span>
          </button>
          <div className="menu-sep" role="separator" />
        </>
      ) : null}
      <button
        type="button"
        role="menuitem"
        tabIndex={-1}
        className="menu-item"
        data-ui="item"
        onClick={() => onRename(id)}
      >
        {/* The menu's own icon size, on its items' column; the row's 14px one sat 2px short (A988). */}
        <Icon name="pencil" />
        <span className="menu-label">Rename</span>
      </button>
      <div className="menu-sep" role="separator" />
      <button
        type="button"
        role="menuitem"
        tabIndex={-1}
        className="menu-item danger"
        data-ui="item"
        onClick={() => onDelete(id)}
      >
        <Icon name="trash" />
        <span className="menu-label">
          {kind === 'notebook' ? 'Delete Notebook…' : 'Delete Folder…'}
        </span>
      </button>
    </>
  );
}

function findRow(tree: HTMLElement | null, key: string): HTMLElement | null {
  return tree?.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`) ?? null;
}

function NameInput({
  label,
  initial,
  placeholder = 'Folder name',
  onCommit,
  onCancel,
}: {
  label: string;
  initial: string;
  placeholder?: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const done = useRef(false);
  return (
    <input
      className="tree-input"
      aria-label={label}
      defaultValue={initial}
      placeholder={placeholder}
      autoFocus
      maxLength={200}
      onFocus={(event) => event.currentTarget.select()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Enter') {
          event.preventDefault();
          done.current = true;
          onCommit(event.currentTarget.value);
        } else if (event.key === 'Escape') {
          event.preventDefault();
          done.current = true;
          onCancel();
        }
      }}
      onBlur={(event) => {
        if (done.current) return;
        done.current = true;
        onCommit(event.currentTarget.value);
      }}
    />
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
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);
  const notes = countNotes(folder);
  const subfolders = folder.folders.length;
  const into = destination === 'The top level' ? 'the top level' : destination;
  return (
    <dialog
      ref={ref}
      className="confirm"
      aria-labelledby="confirm-delete-title"
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
    >
      <form
        method="dialog"
        onSubmit={(event) => {
          event.preventDefault();
          onConfirm();
        }}
      >
        <h2 id="confirm-delete-title">Delete “{folder.name}”?</h2>
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
      </form>
    </dialog>
  );
}

/** Asks before a notebook goes back to being a folder, or to Trash with its notes (T43). */
function ConfirmNotebook({
  kind,
  folder,
  onConfirm,
  onCancel,
}: {
  kind: 'unflag' | 'delete';
  folder: FolderNode;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);
  const notes = countNotes(folder);
  const deleting = kind === 'delete';
  return (
    <dialog
      ref={ref}
      className="confirm"
      aria-labelledby="confirm-notebook-title"
      data-testid="confirm-notebook"
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
    >
      <form
        method="dialog"
        onSubmit={(event) => {
          event.preventDefault();
          onConfirm();
        }}
      >
        <h2 id="confirm-notebook-title">
          {deleting
            ? `Delete the notebook “${folder.name}”?`
            : `Turn “${folder.name}” back into a folder?`}
        </h2>
        <p>
          {deleting
            ? `${notes === 0 ? 'It holds no notes.' : notes === 1 ? 'Its note goes to Trash with it.' : `Its ${notes} notes go to Trash with it.`} You can restore the notebook, notes and all, from Trash for 30 days.`
            : `Its ${notes === 1 ? 'note' : `${notes} notes`} will publish with the default notebook’s git mirror. Its own repository keeps every file: its mirroring pauses (Settings → Git Mirror), and nothing there is deleted.`}
        </p>
        <div className="confirm-actions">
          <button type="button" className="btn" data-ui="dismiss" onClick={onCancel} autoFocus>
            Cancel
          </button>
          <button
            type="submit"
            className={deleting ? 'btn danger-fill' : 'btn primary'}
            data-ui="submit"
          >
            {deleting ? 'Delete Notebook' : 'Turn into a Folder'}
          </button>
        </div>
      </form>
    </dialog>
  );
}

const FolderIcon = () => <Icon name="folder" className="tree-icon" />;
const NotebookIcon = () => <Icon name="notebook" className="tree-icon" />;
const NoteIcon = () => <Icon name="file" className="tree-icon" />;
const ChevronIcon = () => <Icon name="chevR" size={12} className="chevron" />;
const PlusIcon = () => <Icon name="plus" size={14} />;

/** Move to Notebook… and Copy to Notebook… (T68, #230), for one item or several. */
function TransferButtons({
  noun,
  onTransfer,
}: {
  /** "3 Notes", "4 Items"; null for one note or folder. */
  noun: string | null;
  onTransfer: (mode: 'move' | 'copy') => void;
}) {
  return (
    <>
      <button
        type="button"
        role="menuitem"
        tabIndex={-1}
        className="menu-item"
        data-ui="item"
        data-testid="menu-move-to-notebook"
        onClick={() => onTransfer('move')}
      >
        <Icon name="notebook" />
        <span className="menu-label">
          {noun ? `Move ${noun} to Notebook…` : 'Move to Notebook…'}
        </span>
      </button>
      <button
        type="button"
        role="menuitem"
        tabIndex={-1}
        className="menu-item"
        data-ui="item"
        data-testid="menu-copy-to-notebook"
        onClick={() => onTransfer('copy')}
      >
        <Icon name="copy" />
        <span className="menu-label">
          {noun ? `Copy ${noun} to Notebook…` : 'Copy to Notebook…'}
        </span>
      </button>
    </>
  );
}

/** The menu on folders and notes picked together (T68, #230). */
function TransferMenuItems({
  items,
  canTransfer,
  onTransfer,
}: {
  items: readonly ItemRef[];
  canTransfer: boolean;
  onTransfer: (items: readonly ItemRef[], mode: 'move' | 'copy') => void;
}) {
  if (!canTransfer) {
    return (
      <button
        type="button"
        role="menuitem"
        tabIndex={-1}
        className="menu-item"
        data-ui="item"
        disabled
      >
        <Icon name="notebook" />
        <span className="menu-label">Open another notebook to move these to</span>
      </button>
    );
  }
  return (
    <TransferButtons
      noun={`${items.length} Items`}
      onTransfer={(mode) => onTransfer(items, mode)}
    />
  );
}

/**
 * Where in another open notebook (T68, #230): the folder picker over every other notebook's top
 * level and folders, each path starting with the notebook's name.
 */
function TransferPicker({
  job,
  others,
  title,
  onChoose,
  onClose,
}: {
  job: Transferring;
  others: readonly Source[];
  title: string;
  onChoose: (target: Source, folderId: string | null, tags: boolean) => void;
  onClose: () => void;
}) {
  // A copy asks whether the tags go too (A1353), ticked as Settings → Notebooks says. A
  // move always takes them: the notes leave this notebook.
  const copying = job.mode === 'copy';
  const { copies } = useCopyTagsDefault();
  const [tags, setTags] = useState(copies);
  const choices = useMemo(
    () =>
      others.flatMap((other) =>
        folderChoices(folderTreeOf(other.workspace.getState().snapshot, []).tree).map((choice) => ({
          ...choice,
          id: choiceKey(other.id, choice.id),
          name: choice.id === null ? other.name : choice.name,
          path: choice.id === null ? other.name : `${other.name} / ${choice.path}`,
        })),
      ),
    [others],
  );
  const verb = job.mode === 'move' ? 'Move' : 'Copy';
  return (
    <FolderPicker
      title={title}
      count={job.items.length}
      label={`${verb} “${title}” to another notebook`}
      placeholder={`${verb} to notebook…`}
      action={`${verb} here`}
      choices={choices}
      currentId={undefined}
      onChoose={(key) => {
        const [sourceId, folderId] = (key ?? '').split('\u0000');
        const target = others.find((other) => other.id === sourceId);
        if (target) onChoose(target, folderId ? folderId : null, copying ? tags : true);
      }}
      onClose={onClose}
      options={
        copying ? (
          <label className="display-toggle">
            <input
              type="checkbox"
              checked={tags}
              data-testid="copy-tags"
              onChange={(event) => setTags(event.target.checked)}
            />
            <span>Copy Tags</span>
          </label>
        ) : undefined
      }
    />
  );
}
