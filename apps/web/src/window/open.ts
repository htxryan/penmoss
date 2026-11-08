/**
 * Where a note opens besides here (T45, D37): a window of its own, and the main window for
 * every page a note window does not show.
 *
 * - **Web:** `window.open` with `popup` features, from the click or key press, so popup
 *   blockers let it through. A blocked window says so, with a link that opens it in a tab.
 *   Such a window keeps its opener, which shows any page that is not a note (`openInMain`).
 * - **Mac app:** the main process makes the note window itself and denies the page's
 *   `window.open` (A712), so no window is returned and none has an opener; an app path that
 *   is not a note window goes to the main window, which it makes again if it was closed.
 */
import { useSyncExternalStore } from 'react';
import { desktop } from '../desktop/bridge';

/** A note's window (T45, A710), at a heading when given. */
export function noteWindowPath(id: string, heading: string | null = null): string {
  const path = `/window/notes/${encodeURIComponent(id)}`;
  return heading ? `${path}?heading=${encodeURIComponent(heading)}` : path;
}

/** The web's note window: a popup the size of the Mac app's (A712). */
export const NOTE_WINDOW_FEATURES = 'popup,width=720,height=800';

/** What a note window posts to the window that opened it, to show a page there (T45). */
export const OPEN_IN_MAIN_MESSAGE = 'penmoss:open-in-main';

/** An in-app path another window may ask this one to open: `/…`, never `//host` or `/\`. */
export const isAppPath = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 2048 && /^\/(?![/\\])/.test(value);

/** A note window the browser refused to open, offered as a link instead. */
export interface BlockedWindow {
  readonly path: string;
}

class BlockedStore {
  private current: BlockedWindow | null = null;
  private readonly listeners = new Set<() => void>();

  get = (): BlockedWindow | null => this.current;

  set(next: BlockedWindow | null): void {
    if (next === this.current) return;
    this.current = next;
    for (const listener of this.listeners) listener();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
}

/** The window last refused by the browser's popup blocker (the toast's). */
export const blockedWindow = new BlockedStore();

export function useBlockedWindow(): BlockedWindow | null {
  return useSyncExternalStore(blockedWindow.subscribe, blockedWindow.get, () => null);
}

/**
 * Opens the note in a new window (T45, A710): always a new one, so several can show one note.
 * Call it from the click or key press that asked, so a browser lets the popup through.
 */
export function openNoteWindow(id: string, heading: string | null = null): void {
  const path = noteWindowPath(id, heading);
  const opened = window.open(path, '_blank', NOTE_WINDOW_FEATURES);
  // The Mac app makes the window itself and returns none (A712).
  if (opened || desktop()) return;
  blockedWindow.set({ path });
}

/** The window that opened this one, while it is open and Penmoss's own (same origin). */
function liveOpener(): Window | null {
  const opener = window.opener as Window | null;
  if (!opener || opener.closed) return null;
  try {
    return opener.location.origin === window.location.origin ? opener : null;
  } catch {
    return null; // Another origin's page.
  }
}

/**
 * Shows `path` in the main window (T45): in the Mac app the main process opens it there,
 * making the main window again if it was closed (A712); in a browser the window that opened
 * this one shows it (a note window passes it on to its own opener), or a new tab when it has
 * gone.
 */
export function openInMain(path: string): void {
  if (desktop()) {
    // An app path from window.open goes to the main window (A224, A712).
    window.open(path, '_blank');
    return;
  }
  const opener = liveOpener();
  if (opener) {
    opener.postMessage({ type: OPEN_IN_MAIN_MESSAGE, path }, window.location.origin);
    opener.focus();
    return;
  }
  window.open(path, '_blank');
}

/**
 * Opens what another of this browser's Penmoss windows asks (`openInMain`): only a message
 * from this origin, naming an in-app path. Returns the unsubscribe.
 */
export function listenForOpenInMain(open: (path: string) => void): () => void {
  const onMessage = (event: MessageEvent) => {
    if (event.origin !== window.location.origin || event.source === window) return;
    const data = event.data as { readonly type?: unknown; readonly path?: unknown } | null;
    if (data?.type !== OPEN_IN_MAIN_MESSAGE || !isAppPath(data.path)) return;
    window.focus();
    open(data.path);
  };
  window.addEventListener('message', onMessage);
  return () => window.removeEventListener('message', onMessage);
}
