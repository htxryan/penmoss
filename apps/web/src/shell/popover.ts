/**
 * A popover beside a button (T51 items 9 and 10: the glyph and colour pickers): open and
 * closed, closed by Escape, by a press outside it and by focus leaving it, focus given back
 * to its button when Escape closes it. And arrow keys across a grid of choices.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';

export interface PopoverOptions {
  /**
   * Runs as it closes, by any way, while its panel is still there: the colour picker keeps a
   * hex typed but not yet entered (T51 review), which a press outside would otherwise lose, as
   * the field goes without a blur.
   */
  readonly beforeClose?: () => void;
}

export function usePopover<Panel extends HTMLElement = HTMLDivElement>(
  options: PopoverOptions = {},
) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<Panel>(null);
  const beforeClose = useRef(options.beforeClose);
  useLayoutEffect(() => {
    beforeClose.current = options.beforeClose;
  });
  const close = useCallback((refocus: boolean) => {
    beforeClose.current?.();
    setOpen(false);
    if (refocus) button.current?.focus();
  }, []);
  useEffect(() => {
    if (!open) return;
    const outside = (target: EventTarget | null) =>
      target instanceof Node &&
      !panel.current?.contains(target) &&
      !button.current?.contains(target);
    const onPointerDown = (event: PointerEvent) => {
      if (outside(event.target)) close(false);
    };
    const onFocusIn = (event: FocusEvent) => {
      if (outside(event.target)) close(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('focusin', onFocusIn);
    };
  }, [open, close]);
  /** On the panel: Escape closes it (and nothing behind it hears the key). */
  const onPanelKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    close(true);
  };
  return { open, setOpen, button, panel, close, onPanelKeyDown };
}

/**
 * Where an arrow key, Home or End moves to in a grid of `count` items `columns` wide, from
 * `index`; null for any other key. Left and right run on across rows; up and down stop at
 * the edges.
 */
export function gridMove(
  key: string,
  index: number,
  count: number,
  columns: number,
): number | null {
  if (count === 0) return null;
  switch (key) {
    case 'ArrowRight':
      return (index + 1) % count;
    case 'ArrowLeft':
      return (index - 1 + count) % count;
    case 'ArrowDown':
      return index + columns < count ? index + columns : index;
    case 'ArrowUp':
      return index - columns >= 0 ? index - columns : index;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}

/**
 * Arrow keys across the buttons of a grid (`[data-grid-item]` inside `grid`), `columns` wide:
 * the one moved to takes focus, and the key goes no further.
 */
export function onGridKeyDown(event: KeyboardEvent<HTMLElement>, columns: number): void {
  const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[data-grid-item]')];
  const at = items.indexOf(document.activeElement as HTMLElement);
  if (at < 0) return;
  const next = gridMove(event.key, at, items.length, columns);
  if (next === null) return;
  event.preventDefault();
  event.stopPropagation();
  for (const [index, item] of items.entries()) item.tabIndex = index === next ? 0 : -1;
  items[next]!.focus();
}
