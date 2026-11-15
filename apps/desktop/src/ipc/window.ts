/**
 * The windows' own IPC (T28–T30, T45–T47, T51): the theme, each window's menus, the clipboard,
 * the capture window, what a page stored, keep on top and the compact title bar, the menu bar
 * icon, what main held for the main window, and the capture hotkey.
 */
import type { BrowserWindow, IpcMainEvent, IpcMainInvokeEvent } from 'electron';
import { mainInbox, state, themeWriter, windows } from '../app-state';
import { clipboardGate, setMenus } from '../app-menu';
import { notifyOthers } from '../broadcast';
import { currentHotkey, hotkeyGate, setHotkey } from '../capture-hotkey';
import { writeClipboard } from '../clipboard';
import { sendEvent, type IpcHandlers } from '../ipc';
import { keepOnTop, setCompactTitleBar, windowState } from '../mac-window-control';
import { parseKeepOnTop } from '../mac-window';
import { parseMenus } from '../menu';
import { parseWindowTheme } from '../theme';
import { parseQuickAccess } from '../tray';
import { setMenuBarIcon, setQuickAccess } from '../tray-control';
import { parseStoredIds } from '../windows';
import { captureWindow, hideCapture } from '../windows/capture-window';
import { applyBackground, applyMode } from '../windows/window-common';

export function registerWindowIpc(
  ipc: IpcHandlers,
  /** The main or note window with the Mac's window behaviours that sent this (A725). */
  macWindowOf: (event: IpcMainEvent | IpcMainInvokeEvent) => BrowserWindow | null,
): void {
  // The theme on screen (T28): kept for the next launch, and painted behind every window.
  ipc.on('themeSet', (_call, value) => {
    const theme = parseWindowTheme(value);
    if (!theme) return;
    const before = state.preferences.windowTheme;
    if (before?.light !== theme.light || before.dark !== theme.dark || before.mode !== theme.mode) {
      state.preferences = { ...state.preferences, windowTheme: theme };
      // Written once edits pause (a dragged colour sends many), and on quit.
      themeWriter.schedule(undefined);
    }
    applyMode();
    applyBackground();
  });
  // Each window sends its own menus; the menu bar shows those of the window in front (A712).
  ipc.on('menuSet', ({ event }, value) => {
    const window = windows.windowOf(event.sender);
    const menus = window ? parseMenus(value) : null;
    if (!window || !menus) return;
    if (window === windows.main) state.mainMenus = menus;
    if (windows.setMenus(window, menus)) setMenus(menus);
  });
  // `gesture`: the preload's `navigator.userActivation.isActive`, which page scripts cannot set.
  ipc.handle('clipboardWrite', ({ gesture }, data) =>
    clipboardGate.allows({ gesture, now: Date.now() }) ? writeClipboard(data) : false,
  );
  ipc.on('captureDone', ({ event }, saved) => {
    if (event.sender !== captureWindow()?.webContents) return;
    hideCapture();
    // The other windows read the capture from IndexedDB now, not on their next write.
    if (saved === true) notifyOthers(event.sender, 'storeChanged');
  });
  // A page stored records (T45, A711): every other window reads them now, offline too.
  ipc.on('stored', ({ event }, ids) => {
    // The main and note windows only: the hidden capture window reads the store again as it
    // shows (showCapture), and reading each write would have it upload them a second time.
    const changed = parseStoredIds(ids);
    for (const window of windows.all()) {
      if (!window.isDestroyed() && window.webContents !== event.sender) {
        sendEvent(window.webContents, 'storeChanged', changed);
      }
    }
  });
  // Keep on top and the compact title bar (T46, T47): a main or note window's own (A720–A724).
  ipc.handle('windowState', ({ event }) => {
    const window = macWindowOf(event);
    return window ? windowState(window) : null;
  });
  ipc.handle('keepOnTop', ({ event }, value) => {
    const window = macWindowOf(event);
    const on = parseKeepOnTop(value);
    if (!window || on === null) return null;
    return keepOnTop(window, on);
  });
  // Only just after a key press or click in the page (the preload's user activation).
  ipc.handle('compactTitleBar', ({ event }, value) => {
    const window = macWindowOf(event);
    if (!window || typeof value !== 'boolean') return null;
    return setCompactTitleBar(window, value);
  });
  // The menu bar icon (T51 item 17, A945): read by Settings → Display in a main or note window,
  // changed only just after a key press or click there.
  ipc.handle('menuBarIconGet', () => state.preferences.menuBarIcon !== false);
  ipc.handle('menuBarIconSet', (_call, value) =>
    typeof value === 'boolean' ? setMenuBarIcon(value) : null,
  );
  // A command held for the main window while it loaded (A945): its page asks once it listens.
  // Asking says the page listens now: later ones are sent to it straight away.
  ipc.handle('menuCommandPending', ({ event }) => {
    if (!windows.main || event.sender !== windows.main.webContents) return null;
    const item = mainInbox.take(event.sender.id);
    if (!item) return null;
    return item.kind === 'command' ? item.id : { path: item.path };
  });
  // Its Quick Access notes (A946): from the main window's page only, checked.
  ipc.on('quickAccessSet', ({ event }, value) => {
    const pins = macWindowOf(event) === windows.main ? parseQuickAccess(value) : null;
    if (pins) setQuickAccess(pins);
  });
  ipc.handle('captureHotkey', () => currentHotkey());
  // Only Settings → Keyboard Shortcuts, after a key press or click: from a main or note
  // window's app frame (A712; Settings shows in the main window), never the capture window.
  ipc.handle('captureSetHotkey', ({ event, gesture }, value) => {
    if (typeof value !== 'string' || value.length > 100) return null;
    const refused = hotkeyGate.check({
      url: event.senderFrame?.url ?? '',
      gesture,
      now: Date.now(),
    });
    return refused ? { ...currentHotkey(), error: refused } : setHotkey(value);
  });
}
