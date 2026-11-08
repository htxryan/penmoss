import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';

const ITEMS = [
  '[role="menuitem"]:not([disabled])',
  '[role="menuitemradio"]:not([disabled])',
  '[role="menuitemcheckbox"]:not([disabled])',
].join(', ');

/**
 * An in-app context menu (T42, #104 item 1, A570), at the pointer or, opened from the keyboard
 * (the context-menu key or Shift+F10), at the row. A WAI-ARIA menu like `Menu`: focus starts on
 * the first item, arrows move, Home and End jump, Escape and Tab close it, and so does a press
 * outside it or choosing an item; `onClose` gives focus back. The Mac app shows no native menu
 * of its own, so the page's `contextmenu` event opens this one there too.
 *
 * Opened from a button (`anchor`, the sidebar's sort order, T52), it sits under it, fixed, so a
 * scrolling sidebar never clips it; a press on the button is the button's own (it closes the
 * menu). Focus starts on the checked item of a choice.
 */
export function ContextMenu({
  label,
  caption,
  x,
  y,
  anchor,
  onClose,
  children,
}: {
  /** The menu's accessible name, e.g. "3 notes: “A”, “B” and “C”". */
  readonly label: string;
  /** Shown above the items: what they act on, e.g. the selected notes (review S1). */
  readonly caption?: string | undefined;
  /** Where it opens, in viewport pixels. */
  readonly x: number;
  readonly y: number;
  /** The button that opened it, if any: presses on it are left to it. */
  readonly anchor?: RefObject<HTMLElement | null>;
  readonly onClose: () => void;
  readonly children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);

  // Kept inside the window: flipped left of or above the pointer when it would overflow.
  useLayoutEffect(() => {
    const menu = ref.current;
    if (!menu) return;
    const { offsetWidth: width, offsetHeight: height } = menu;
    const left = x + width + 8 > window.innerWidth ? Math.max(8, x - width) : x;
    const top = y + height + 8 > window.innerHeight ? Math.max(8, y - height) : y;
    setPlace({ left, top });
  }, [x, y]);
  // Focus once placed: a hidden element (before it is measured) cannot take it.
  useLayoutEffect(() => {
    if (!place) return;
    const menu = ref.current;
    (
      menu?.querySelector<HTMLElement>('[aria-checked="true"]:not([disabled])') ??
      menu?.querySelector<HTMLElement>(ITEMS)
    )?.focus();
  }, [place]);

  const latestClose = useRef(onClose);
  const latestAnchor = useRef(anchor);
  useLayoutEffect(() => {
    latestClose.current = onClose;
    latestAnchor.current = anchor;
  });
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (latestAnchor.current?.current?.contains(target)) return;
      if (!ref.current?.contains(target)) latestClose.current();
    };
    const onBlur = () => latestClose.current();
    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('blur', onBlur);
    window.addEventListener('resize', onBlur);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('resize', onBlur);
    };
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = [...(ref.current?.querySelectorAll<HTMLElement>(ITEMS) ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const move = (index: number) => {
      event.preventDefault();
      items[(index + items.length) % items.length]?.focus();
    };
    event.stopPropagation();
    if (event.key === 'ArrowDown') move(at + 1);
    else if (event.key === 'ArrowUp') move(at - 1);
    else if (event.key === 'Home') move(0);
    else if (event.key === 'End') move(items.length - 1);
    else if (event.key === 'Escape' || event.key === 'Tab') {
      event.preventDefault();
      onClose();
    }
  };

  return (
    <div
      ref={ref}
      className="menu context-menu"
      role="menu"
      aria-label={label}
      data-testid="context-menu"
      style={
        place ? { left: place.left, top: place.top } : { left: x, top: y, visibility: 'hidden' }
      }
      onKeyDown={onKeyDown}
      onContextMenu={(event) => event.preventDefault()}
    >
      {caption ? (
        // Already the menu's name for screen readers.
        <p className="menu-caption" aria-hidden="true" data-testid="context-menu-caption">
          {caption}
        </p>
      ) : null}
      {children}
    </div>
  );
}
