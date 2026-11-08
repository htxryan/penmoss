/**
 * Tab stays inside a modal dialog (T39). The palette, search, the theme
 * picker, quick capture and the shortcuts sheet are `aria-modal` dialogs over
 * the page, but Tab used to leave them for the page behind. One listener on
 * the document keeps it in the topmost one: from its last control Tab goes
 * to its first, Shift+Tab from its first to its last, and focus that is
 * outside it comes back in.
 */

/**
 * Where Tab should move instead of the browser's own choice, or null to let
 * the browser move it (within the dialog). `focusables` is in tab order.
 */
export function trappedFocus<T>(
  focusables: readonly T[],
  active: T | null,
  backwards: boolean,
): T | null {
  const first = focusables[0];
  const last = focusables.at(-1);
  if (first === undefined || last === undefined) return null;
  const at = active === null ? -1 : focusables.indexOf(active);
  if (at === -1) return backwards ? last : first;
  if (backwards && at === 0) return last;
  if (!backwards && at === focusables.length - 1) return first;
  return null;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** The controls Tab can reach in `root`, in document order (tabindex > 0 is not used here). */
function focusablesIn(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (element) => !element.closest('[hidden], [inert]') && element.getClientRects().length > 0,
  );
}

/** Keeps Tab in the topmost open modal dialog; returns the uninstaller. */
export function installModalFocusTrap(doc: Document): () => void {
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Tab' || event.defaultPrevented || event.altKey || event.ctrlKey) return;
    if (event.metaKey) return;
    const dialogs = doc.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]');
    const dialog = dialogs[dialogs.length - 1];
    if (!dialog) return;
    const active = doc.activeElement instanceof HTMLElement ? doc.activeElement : null;
    const next = trappedFocus(
      focusablesIn(dialog),
      active && dialog.contains(active) ? active : null,
      event.shiftKey,
    );
    if (!next) return;
    event.preventDefault();
    next.focus();
  };
  doc.addEventListener('keydown', onKeyDown, true);
  return () => doc.removeEventListener('keydown', onKeyDown, true);
}
