/**
 * Where a note opens besides here (T45, D37): a window of its own, and the main window for
 * every page a note window does not show. The Mac app's main process makes the note window
 * itself and denies the page's `window.open` (A712), so no window is returned and none has an
 * opener; an app path that is not a note window goes to the main window, which it makes again
 * if it was closed.
 */

/** A note's window (T45, A710), at a heading when given. */
export function noteWindowPath(id: string, heading: string | null = null): string {
  const path = `/window/notes/${encodeURIComponent(id)}`;
  return heading ? `${path}?heading=${encodeURIComponent(heading)}` : path;
}

/** The longest a new note window waits for this window to store its notes (A1591). */
export const STORE_BEFORE_OPEN_MS = 1000;

let storeFirst: (() => Promise<void>) | null = null;

/**
 * How this window stores its notes before it opens a note window (A1591): the Mac app sets it
 * (main.tsx). The new window reads the note from the shared store, so without it a note window
 * opened a moment after typing showed the note without its last keystrokes. Typed into there
 * too, both windows' new text then merged side by side, interleaved.
 */
export function setStoreBeforeNoteWindow(store: (() => Promise<void>) | null): void {
  storeFirst = store;
}

/**
 * Opens the note in a new window (T45, A710): always a new one, so several can show one note.
 * In the Mac app, once this window has stored its notes, or after STORE_BEFORE_OPEN_MS at most.
 */
export function openNoteWindow(id: string, heading: string | null = null): void {
  const path = noteWindowPath(id, heading);
  const store = storeFirst;
  if (!store) {
    window.open(path, '_blank');
    return;
  }
  let opened = false;
  const open = () => {
    if (opened) return;
    opened = true;
    clearTimeout(timer);
    window.open(path, '_blank');
  };
  const timer = setTimeout(open, STORE_BEFORE_OPEN_MS);
  void store().then(open, open);
}

/**
 * Shows `path` in the main window (T45): the main process opens it there, making the main
 * window again if it was closed (A224, A712).
 */
export function openInMain(path: string): void {
  window.open(path, '_blank');
}
