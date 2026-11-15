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

/** Opens the note in a new window (T45, A710): always a new one, so several can show one note. */
export function openNoteWindow(id: string, heading: string | null = null): void {
  window.open(noteWindowPath(id, heading), '_blank');
}

/**
 * Shows `path` in the main window (T45): the main process opens it there, making the main
 * window again if it was closed (A224, A712).
 */
export function openInMain(path: string): void {
  window.open(path, '_blank');
}
