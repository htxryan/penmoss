import type { KeyboardEvent } from 'react';

/** A menu's items that can be chosen now, of any kind. */
export const MENU_ITEMS = [
  '[role="menuitem"]:not([disabled])',
  '[role="menuitemcheckbox"]:not([disabled])',
  '[role="menuitemradio"]:not([disabled])',
].join(', ');

/**
 * A WAI-ARIA menu's keys (`Menu`, `ContextMenu`): the arrows move between its items, wrapping,
 * Home and End jump to the first and last, and Escape and Tab close it. Other keys pass by.
 */
export function menuKeyDown(
  container: HTMLElement | null,
  event: KeyboardEvent<HTMLElement>,
  close: () => void,
): void {
  const items = [...(container?.querySelectorAll<HTMLElement>(MENU_ITEMS) ?? [])];
  const at = items.indexOf(document.activeElement as HTMLElement);
  const move = (index: number) => {
    event.preventDefault();
    items[(index + items.length) % items.length]?.focus();
  };
  if (event.key === 'ArrowDown') move(at + 1);
  else if (event.key === 'ArrowUp') move(at - 1);
  else if (event.key === 'Home') move(0);
  else if (event.key === 'End') move(items.length - 1);
  else if (event.key === 'Escape' || event.key === 'Tab') {
    event.preventDefault();
    close();
  }
}
