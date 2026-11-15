/**
 * Dragging rows in the folder tree (T7): a drop on a row goes beside or into it; on the tree's
 * empty space, to the top level. A note dragged out of the tree carries its id, so Quick Access
 * can pin it (T53 item 10).
 */
import type { WorkspaceTree } from '@penmoss/core/workspace';
import { useRef, useState, type Dispatch, type DragEvent, type SetStateAction } from 'react';
import { NOTE_DRAG_TYPE } from '../notes/note-drag';
import {
  dropZone,
  planDrop,
  rowKey,
  sortModeOf,
  type DropTarget,
  type DropZone,
  type ItemRef,
  type MovePlan,
  type Row,
} from './model';
import { rowElement } from './tree-dom';

/** Where a drop would land now: on a row, on the top level, or nowhere. */
export type DropHint = { readonly key: string; readonly zone: DropZone } | 'root' | null;

export interface TreeDrop {
  readonly dropHint: DropHint;
  readonly onDragStart: (event: DragEvent<HTMLDivElement>) => void;
  readonly onDragEnd: () => void;
  readonly onDragOver: (event: DragEvent<HTMLElement>) => void;
  readonly onDragLeave: (event: DragEvent<HTMLElement>) => void;
  readonly onDrop: (event: DragEvent<HTMLElement>) => void;
}

/** The tree's drag and drop: `run` applies a drop's move, and its row then takes focus. */
export function useTreeDrop({
  tree,
  rowOf,
  selected,
  setSelection,
  run,
  focusRow,
}: {
  tree: WorkspaceTree;
  rowOf: (element: HTMLElement | null) => Row | undefined;
  selected: readonly string[];
  setSelection: Dispatch<SetStateAction<readonly string[]>>;
  run: (plan: MovePlan) => boolean;
  focusRow: (key: string) => void;
}): TreeDrop {
  const [dropHint, setDropHint] = useState<DropHint>(null);
  const dragged = useRef<ItemRef | null>(null);

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

  return { dropHint, onDragStart, onDragEnd, onDragOver, onDragLeave, onDrop };
}
