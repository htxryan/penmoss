/**
 * The folder tree's keys (T7, A570), as a WAI-ARIA tree with a roving tab stop: ↑/↓ move (with
 * Shift, the selection grows), ←/→ close and open, Home and End, Enter opens, Space selects a
 * note, the context-menu key or Shift+F10 opens the menu, and Escape leaves one note selected.
 * Alt+↑/↓, F2 and Delete are commands (tree-commands.ts).
 */
import type { KeyboardEvent } from 'react';
import { rowKey, type FolderRow, type NoteRow, type Row } from './model';
import { noteRange } from './selection';
import type { TreeSelection } from './tree-selection';
import { rowElement } from './tree-dom';

export interface TreeKeysContext {
  readonly rows: readonly Row[];
  readonly rowOf: (element: HTMLElement | null) => Row | undefined;
  readonly selection: TreeSelection;
  readonly focusRow: (key: string) => void;
  readonly setExpanded: (ids: readonly string[], open?: boolean) => void;
  /** Enter on a note, as a click. */
  readonly openNote: (row: NoteRow) => void;
  /** Enter on a folder, as a click. */
  readonly activateFolder: (row: FolderRow) => void;
}

/** Handles a key pressed on one of the tree's rows (not in a name field). */
export function onTreeKeyDown(event: KeyboardEvent<HTMLDivElement>, context: TreeKeysContext) {
  const { rows, rowOf, selection, focusRow, setExpanded, openNote, activateFolder } = context;
  const { anchor, selected, setAnchor, setSelection } = selection;
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
      selection.toggleSelected(row);
      return;
    case 'ContextMenu':
    case 'F10': {
      if (event.key === 'F10' && !event.shiftKey) return;
      handled();
      const rect = (event.target as HTMLElement).getBoundingClientRect();
      selection.openMenu(row, rect.left + 24, rect.bottom);
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
}
