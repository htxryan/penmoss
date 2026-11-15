/**
 * The modal pickers' keys and rows (T20's palette, Quick Open, the ⌘E switcher, Move to Folder,
 * Switch Theme and Search; the parts they render are in `picker.tsx`): one list driven from one
 * field, with the same keys everywhere: ↑ and ↓ wrap, ⌘/Ctrl+Home and ⌘/Ctrl+End go to the
 * ends, Return chooses, Escape closes. Each picker brings its own items, rows and words.
 */
import { useId, type HTMLAttributes, type KeyboardEvent } from 'react';

export interface PickerListOptions {
  /** The rows, as the picker shows them now. */
  readonly items: readonly unknown[];
  /** The active row (kept by the picker, which resets it as its query changes). */
  readonly active: number;
  readonly setActive: (index: number) => void;
  /** Return on the active row; it is the picker's to check the row exists. */
  readonly onChoose: (index: number) => void;
  readonly onClose: () => void;
  /** What the rows' ids are called, after the picker's id (`option`, `result`, `recent`). */
  readonly optionName?: string;
}

export interface PickerList {
  /** The active row, within the rows there are. */
  readonly current: number;
  /** The rows it was given (the list scrolls its active row into view when they change). */
  readonly items: readonly unknown[];
  readonly listId: string;
  /** The active row's id, for `aria-activedescendant` (undefined with no rows). */
  readonly activeId: string | undefined;
  readonly onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  /** A row's props: its id and role, selected when active, active under the pointer. */
  readonly optionProps: (index: number) => HTMLAttributes<HTMLDivElement> & {
    readonly 'data-index': number;
  };
}

export function usePickerList({
  items,
  active,
  setActive,
  onChoose,
  onClose,
  optionName = 'option',
}: PickerListOptions): PickerList {
  const id = useId();
  const count = items.length;
  const current = Math.min(active, Math.max(0, count - 1));

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.nativeEvent.isComposing) return;
    const rows = Math.max(1, count);
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        setActive((current + 1) % rows);
        break;
      case 'ArrowUp':
        event.preventDefault();
        setActive((current - 1 + rows) % rows);
        break;
      case 'Home':
      case 'End':
        // Plain Home and End move the caret in the field.
        if (!event.ctrlKey && !event.metaKey) return;
        event.preventDefault();
        setActive(event.key === 'Home' ? 0 : rows - 1);
        break;
      case 'Enter':
        event.preventDefault();
        onChoose(current);
        break;
      case 'Escape':
        event.preventDefault();
        event.stopPropagation();
        onClose();
        break;
    }
  };

  const optionId = (index: number) => `${id}-${optionName}-${index}`;
  return {
    current,
    items,
    listId: `${id}-list`,
    activeId: count > 0 ? optionId(current) : undefined,
    onKeyDown,
    optionProps: (index) => ({
      id: optionId(index),
      role: 'option',
      'aria-selected': index === current,
      'data-index': index,
      onMouseMove: () => {
        if (index !== current) setActive(index);
      },
      // The field keeps the focus, so the keys still reach it.
      onMouseDown: (event) => event.preventDefault(),
    }),
  };
}
