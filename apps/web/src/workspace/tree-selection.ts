/**
 * What is selected in the sidebar's folder tree (T42, A570; T68, #230) and its context menu:
 * the notes chosen with Shift and ⌘ (Ctrl off a Mac), the folders picked beside them, and the
 * menu's target, which is the selection when the row right-clicked is in it.
 */
import { useState, type Dispatch, type SetStateAction } from 'react';
import { rowKey, type ItemRef, type NoteRow, type Row } from './model';
import {
  menuTargets,
  noteRange,
  rowRange,
  selectionAfterOpen,
  toggled,
  visibleFolders,
  visibleSelection,
} from './selection';

/** The open context menu (A570): where, on what, and the row focus goes back to. */
export type ContextTarget =
  | { readonly kind: 'notes'; readonly ids: readonly string[] }
  | { readonly kind: 'folder'; readonly id: string }
  /** Folders and notes picked together (T68, #230): what goes to another notebook at once. */
  | { readonly kind: 'items'; readonly items: readonly ItemRef[] };

export interface MenuState {
  readonly x: number;
  readonly y: number;
  readonly target: ContextTarget;
  readonly rowKey: string;
}

export interface TreeSelection {
  /** The selected notes still shown, in the order chosen. */
  readonly selected: readonly string[];
  readonly setSelection: Dispatch<SetStateAction<readonly string[]>>;
  /** Where a Shift range of notes starts. */
  readonly anchor: string | null;
  readonly setAnchor: Dispatch<SetStateAction<string | null>>;
  /** The folders picked with Shift- or ⌘-click (T68) still shown, in tree order. */
  readonly pickedFolders: readonly string[];
  readonly setPicked: Dispatch<SetStateAction<readonly string[]>>;
  /** The row a Shift range with a folder in it starts from. */
  readonly pickAnchor: string | null;
  readonly setPickAnchor: Dispatch<SetStateAction<string | null>>;
  /** Shift-click with a folder at either end: the notes and folders between (T68, #230). */
  readonly pickRange: (row: Row) => void;
  /** Shift: the notes from the anchor (or the open note) to `row`. */
  readonly selectRange: (row: NoteRow) => void;
  /** ⌘ (Ctrl) or Space: one note in or out. */
  readonly toggleSelected: (row: NoteRow) => void;
  readonly menu: MenuState | null;
  readonly setMenu: Dispatch<SetStateAction<MenuState | null>>;
  /** The context menu on `row` at (x, y), on what is picked when `row` is among it. */
  readonly openMenu: (row: Row, x: number, y: number) => void;
}

/** The tree's selection over its shown `rows`, with `activeId` the open note. */
export function useTreeSelection(rows: readonly Row[], activeId: string | null): TreeSelection {
  /** Selected notes (A570), in the order chosen; `anchor` is where a Shift range starts. */
  const [selection, setSelection] = useState<readonly string[]>([]);
  const [anchor, setAnchor] = useState<string | null>(null);
  /**
   * Folders picked with Shift- or ⌘-click (T68, #230), beside the selected notes, and the row
   * a Shift range with a folder in it starts from.
   */
  const [picked, setPicked] = useState<readonly string[]>([]);
  const [pickAnchor, setPickAnchor] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
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

  const selected = visibleSelection(rows, selection);
  const pickedFolders = visibleFolders(rows, picked);

  const pickRange = (row: Row) => {
    const from = pickAnchor ?? (activeId === null ? null : rowKey({ kind: 'note', id: activeId }));
    const between = rowRange(rows, from, row.key);
    setSelection(between.filter((each) => each.kind === 'note').map((each) => each.id));
    setPicked(between.filter((each) => each.kind === 'folder').map((each) => each.id));
    if (from === null) setPickAnchor(row.key);
  };

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

  return {
    selected,
    setSelection,
    anchor,
    setAnchor,
    pickedFolders,
    setPicked,
    pickAnchor,
    setPickAnchor,
    pickRange,
    selectRange,
    toggleSelected,
    menu,
    setMenu,
    openMenu,
  };
}
