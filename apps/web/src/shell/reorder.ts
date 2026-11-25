/**
 * A list whose rows reorder by drag and from the keyboard (PEN-146; the sidebar's sections and
 * the line symbols in Settings): each row has a handle to drag it by, a row dropped on another
 * goes before or after it by the half it lands in, and Alt+↑ or Alt+↓ anywhere in a row (or ↑
 * and ↓ on its handle) moves it one place. What had focus keeps it, and the move is said in
 * words for a screen reader (`said`, for a live region).
 */
import { useState, type DragEvent, type KeyboardEvent } from 'react';

/** Where Alt and an arrow mean something else: text, a list to choose from, a popover. */
const TYPED =
  'input:not([type="checkbox"]):not([type="radio"]), textarea, select, [contenteditable="true"], [role="dialog"]';

interface ReorderRowProps {
  readonly 'data-reorder-id': string;
  readonly 'data-dragging'?: '';
  readonly 'data-drop'?: 'before' | 'after';
  readonly onDragOver: (event: DragEvent<HTMLElement>) => void;
  readonly onDragLeave: (event: DragEvent<HTMLElement>) => void;
  readonly onDrop: (event: DragEvent<HTMLElement>) => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
}

interface ReorderHandleProps {
  readonly draggable: true;
  readonly 'data-reorder-handle': '';
  readonly 'aria-keyshortcuts': string;
  readonly onDragStart: (event: DragEvent<HTMLElement>) => void;
  readonly onDragEnd: () => void;
}

export interface Reorder<T extends string> {
  readonly rowProps: (id: T) => ReorderRowProps;
  readonly handleProps: (id: T) => ReorderHandleProps;
  /** The last move in words, for a live region; empty until a row moves. */
  readonly said: string;
}

/**
 * `ids` in their order now; `onMove(id, index)` puts `id` at `index` of the list it ends in.
 * `describe` says a move ("Recent Notes moved to 2 of 5."), or the caller says it itself.
 */
export function useReorder<T extends string>({
  ids,
  type,
  onMove,
  describe,
  disabled = false,
}: {
  readonly ids: readonly T[];
  /** The drag's data type, so only this list's rows drop here. */
  readonly type: string;
  readonly onMove: (id: T, index: number) => void;
  readonly describe?: (id: T, index: number, total: number) => string;
  readonly disabled?: boolean;
}): Reorder<T> {
  const [dragging, setDragging] = useState<T | null>(null);
  const [hint, setHint] = useState<{ id: T; after: boolean } | null>(null);
  const [said, setSaid] = useState('');

  const move = (id: T, index: number) => {
    const at = Math.max(0, Math.min(index, ids.length - 1));
    if (ids.indexOf(id) === at) return;
    onMove(id, at);
    if (describe) setSaid(describe(id, at, ids.length));
  };

  const place = (event: DragEvent<HTMLElement>, id: T) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { id, after: event.clientY > rect.top + rect.height / 2 };
  };

  const rowProps = (id: T): ReorderRowProps => ({
    'data-reorder-id': id,
    ...(dragging === id ? { 'data-dragging': '' as const } : {}),
    ...(hint?.id === id && dragging !== id
      ? { 'data-drop': hint.after ? ('after' as const) : ('before' as const) }
      : {}),
    onDragOver: (event) => {
      if (!dragging || !event.dataTransfer.types.includes(type)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      const next = place(event, id);
      if (hint?.id !== next.id || hint.after !== next.after) setHint(next);
    },
    onDragLeave: (event) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setHint(null);
    },
    onDrop: (event) => {
      if (!dragging) return;
      event.preventDefault();
      const { after } = place(event, id);
      setHint(null);
      setDragging(null);
      if (dragging === id) return;
      const rest = ids.filter((each) => each !== dragging);
      move(dragging, rest.indexOf(id) + (after ? 1 : 0));
    },
    onKeyDown: (event) => {
      if (disabled || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
      const target = event.target as HTMLElement;
      const onHandle = target.hasAttribute('data-reorder-handle');
      if (!event.altKey && !onHandle) return;
      // A field's own keys, and a popover open from the row (a picker), keep theirs.
      if (target.closest(TYPED)) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey) return;
      event.preventDefault();
      event.stopPropagation();
      const from = ids.indexOf(id);
      const to = from + (event.key === 'ArrowUp' ? -1 : 1);
      if (to < 0 || to >= ids.length) return;
      // Moving a row moves its element, which loses focus: give it back.
      const focused = document.activeElement as HTMLElement | null;
      move(id, to);
      requestAnimationFrame(() => {
        if (focused?.isConnected && document.activeElement !== focused) focused.focus();
      });
    },
  });

  const handleProps = (id: T): ReorderHandleProps => ({
    draggable: true,
    'data-reorder-handle': '',
    'aria-keyshortcuts': 'Alt+ArrowUp Alt+ArrowDown',
    onDragStart: (event) => {
      if (disabled) {
        event.preventDefault();
        return;
      }
      event.dataTransfer.setData(type, id);
      event.dataTransfer.effectAllowed = 'move';
      const row = event.currentTarget.closest<HTMLElement>('[data-reorder-id]');
      if (row) event.dataTransfer.setDragImage(row, 16, 12);
      setDragging(id);
    },
    onDragEnd: () => {
      setDragging(null);
      setHint(null);
    },
  });

  return { rowProps, handleProps, said };
}
