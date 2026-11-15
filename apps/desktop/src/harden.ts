/** What pages may do (A224): navigate only within the app, open note windows, nothing else. */
import { BrowserWindow, shell, type WebContents } from 'electron';
import { windows } from './app-state';
import { appPath, isAppUrl, isExternalUrl } from './security';
import { noteWindowPath, NoteWindowGate } from './windows';
import { openInMain } from './windows/main-window';
import { createNoteWindow } from './windows/note-window';

/** Pages open note windows a few at a time, and at most 20 (A712). */
/** Pages open note windows a few at a time, and at most 20 (A712). */
const noteWindowGate = new NoteWindowGate();

export function harden(contents: WebContents): void {
  const outward = (url: string) => {
    if (isExternalUrl(url)) void shell.openExternal(url);
  };
  contents.on('will-navigate', (event) => {
    if (isAppUrl(event.url)) return;
    event.preventDefault();
    outward(event.url);
  });
  contents.on('will-redirect', (event) => {
    if (!isAppUrl(event.url)) event.preventDefault();
  });
  contents.on('will-attach-webview', (event) => event.preventDefault());
  contents.setWindowOpenHandler(({ url }) => {
    // A note window (T45, A712): made here, with no opener, cascading from the window that
    // asked. Only an app page may ask.
    const notePath = noteWindowPath(url);
    if (notePath) {
      if (
        isAppUrl(contents.getURL()) &&
        noteWindowGate.allows(windows.notes().length, Date.now())
      ) {
        createNoteWindow(notePath, BrowserWindow.fromWebContents(contents));
      }
      return { action: 'deny' };
    }
    // A note opened "in a new tab", or a page a note window does not show: the main window.
    const path = appPath(url);
    if (path) openInMain(path);
    else outward(url);
    return { action: 'deny' };
  });
}
