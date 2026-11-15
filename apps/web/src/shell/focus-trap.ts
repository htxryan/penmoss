/**
 * Tab stays inside a modal dialog (T39). The palette, search, the theme
 * picker, quick capture and the shortcuts sheet are `aria-modal` dialogs over
 * the page, but Tab used to leave them for the page behind. One listener on
 * the document keeps it in the topmost one: from its last control Tab goes
 * to its first, Shift+Tab from its first to its last, and focus that is
 * outside it comes back in.
 *
 * A dialog may own a part of the page beside it (`aria-owns`): History's panel stays usable beside
 * View This Version (A1572). Tab then goes round the dialog's controls and the owned part's, in
 * that order, since the browser's own order would leave for the page between them.
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

/** The control after (or before) `active` in `focusables`, going round; the first (or last) if none. */
export function cycledFocus<T>(
  focusables: readonly T[],
  active: T | null,
  backwards: boolean,
): T | null {
  const count = focusables.length;
  if (count === 0) return null;
  const at = active === null ? -1 : focusables.indexOf(active);
  if (at === -1) return backwards ? focusables[count - 1]! : focusables[0]!;
  return focusables[(at + (backwards ? count - 1 : 1)) % count]!;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** The controls Tab can reach in `root`, in document order (tabindex > 0 is not used here). */
function focusablesIn(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (element) => !element.closest('[hidden], [inert]') && element.getClientRects().length > 0,
  );
}

/** The dialog, then the parts of the page it owns (`aria-owns`), in that order. */
function regionsOf(dialog: HTMLElement): HTMLElement[] {
  const doc = dialog.ownerDocument;
  const owned = (dialog.getAttribute('aria-owns') ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .map((id) => doc.getElementById(id))
    .filter((element): element is HTMLElement => element !== null);
  return [dialog, ...owned];
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
    const regions = regionsOf(dialog);
    const inside = active && regions.some((region) => region.contains(active)) ? active : null;
    const focusables = regions.flatMap(focusablesIn);
    const next =
      regions.length > 1
        ? cycledFocus(focusables, inside, event.shiftKey)
        : trappedFocus(focusables, inside, event.shiftKey);
    if (!next) return;
    event.preventDefault();
    next.focus();
  };
  doc.addEventListener('keydown', onKeyDown, true);
  return () => doc.removeEventListener('keydown', onKeyDown, true);
}
