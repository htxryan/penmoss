/**
 * What the main, note and capture windows share (T29, T45, A712): how a page is asked to store
 * its notes and how long it may take, the window's web preferences, the theme's background,
 * the registry's tracking and storing before a window closes.
 */
import { join } from 'node:path';
import { app, BrowserWindow, ipcMain, nativeTheme, type IpcMainEvent } from 'electron';
import { config, macWindows, state, storeRequests, titleBars, windows } from '../app-state';
import { setMenus } from '../app-menu';
import { sendEvent } from '../ipc';
import { SEND, TITLE_BAR_ARG, VERSION_ARG, WINDOW_ARG } from '../ipc-contract';
import { watchWindowState } from '../mac-window-control';
import { titleBarStyle, type StoreResult, type TitleBarStyle } from '../mac-window';
import { gitNotebooks } from '../services';
import { StoreRequests, storeReply } from '../store-requests';
import { windowBackground } from '../theme';
import type { WindowKind } from '../windows';

/** How long a window may take to store its notes before it closes anyway. */
export const SAVE_BEFORE_CLOSE_MS = 3000;

/**
 * And, with git notebooks on this Mac, for the push the page waits for as it closes (#170 F8:
 * the page's `CLOSING_SYNC_MS`, 10 s, and a little more); a page that answers sooner closes sooner.
 */
export const GIT_PUSH_BEFORE_CLOSE_MS = 11_000;

/**
 * Asks a page to store everything now (before it closes, or before the
 * capture window reads the shared replica); resolves when it has, or after
 * SAVE_BEFORE_CLOSE_MS. Says how it went: reopening a window for a new title bar
 * goes ahead only when its page stored everything (A724).
 */
export function storeNow(
  window: BrowserWindow,
  waitMs = SAVE_BEFORE_CLOSE_MS,
  // `close` only as the window closes or the app quits: then the page pushes its git notebooks
  // too (#170 F8); `flush` stores only, starting and stopping no sync (#174 review).
  reason: 'close' | 'flush' = 'flush',
): Promise<StoreResult> {
  return new Promise((resolve) => {
    const contents = window.webContents;
    const finish = (result: StoreResult) => {
      clearTimeout(timer);
      ipcMain.removeListener(SEND.saved.channel, onSaved);
      resolve(result);
    };
    // Only this ask's own reply (#174 delta review): a quick flush's never ends a close.
    const request = storeRequests.make(reason);
    const onSaved = (event: IpcMainEvent, value: unknown) => {
      if (event.sender !== contents) return;
      const reply = storeReply(value);
      if (StoreRequests.answers(request, reply)) finish(reply!.ok ? 'saved' : 'failed');
    };
    const timer = setTimeout(() => finish('timeout'), waitMs);
    ipcMain.on(SEND.saved.channel, onSaved);
    if (contents.isDestroyed() || contents.isCrashed()) finish('gone');
    else sendEvent(contents, 'save', request);
  });
}

/** The style a new main or note window opens with: this Mac's setting (A724). */
export const newTitleBar = (): TitleBarStyle | null =>
  titleBarStyle(macWindows, state.preferences.compactTitleBar);

export function webPreferences(
  kind: WindowKind | 'capture',
  titleBar: TitleBarStyle | null = null,
) {
  return {
    preload: join(__dirname, 'preload.cjs'),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true,
    spellcheck: true,
    devTools: config.devTools,
    additionalArguments: [
      `${WINDOW_ARG}${kind}`,
      `${VERSION_ARG}${app.getVersion()}`,
      // Never the capture window's (A725): it has neither behaviour.
      ...(titleBar && kind !== 'capture' ? [`${TITLE_BAR_ARG}${titleBar}`] : []),
    ],
  };
}

/** The page's theme background (T28): the last theme it sent, or Penmoss before that. */
export const background = () =>
  windowBackground(state.preferences.windowTheme ?? null, nativeTheme.shouldUseDarkColors);

/**
 * The theme's mode for the title bar, menus and dialogs (Light or Dark as chosen,
 * or macOS's own for System); `updated` then paints the windows.
 */
export function applyMode(): void {
  const source = state.preferences.windowTheme?.mode ?? 'system';
  if (nativeTheme.themeSource !== source) nativeTheme.themeSource = source;
}

/** Paints every window in the theme's background again (a new theme, or macOS's appearance). */
export function applyBackground(): void {
  const colour = background();
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.setBackgroundColor(colour);
  }
}

/**
 * Puts a main or note window in the registry (A712): in front, it gets the menu bar with its
 * own page's menus; closed, it leaves.
 */
export function track(
  window: BrowserWindow,
  kind: WindowKind,
  titleBar: TitleBarStyle | null,
): void {
  windows.add(window, kind);
  titleBars.set(window, titleBar);
  if (macWindows) watchWindowState(window);
  window.on('focus', () => {
    windows.focused(window);
    const menus = windows.menusOf(window);
    if (menus) setMenus(menus);
  });
  // The Dock icon brings back the window minimized last (PEN-67).
  window.on('minimize', () => windows.minimized(window));
  window.on('restore', () => windows.restored(window));
  window.on('closed', () => {
    windows.remove(window);
    // No window came to the front (the last one closed, or the rest are minimized): the menu
    // bar leaves the closed window's menus, with what it greyed out, for the window menu
    // commands now go to, else the main window's last.
    setImmediate(() => {
      const front = BrowserWindow.getFocusedWindow();
      if (front && windows.kindOf(front.webContents)) return;
      const next = windows.active;
      const menus = (next && windows.menusOf(next)) ?? state.mainMenus;
      if (menus) setMenus(menus);
    });
  });
}

/** How long a closing window may take: longer while this Mac has git notebooks to push. */
export async function closingWait(): Promise<number> {
  const any = await gitNotebooks.list().then(
    (list) => list.length > 0,
    () => false,
  );
  return any ? SAVE_BEFORE_CLOSE_MS + GIT_PUSH_BEFORE_CLOSE_MS : SAVE_BEFORE_CLOSE_MS;
}

/** The last keystrokes go to IndexedDB before the page is torn down (⌘W, ⌘Q). */
export function storeBeforeClose(window: BrowserWindow, closing?: () => void): void {
  let stored = false;
  window.on('close', (event) => {
    closing?.();
    if (stored) return;
    event.preventDefault();
    const wasQuitting = state.quitting;
    void closingWait()
      .then((waitMs) => storeNow(window, waitMs, 'close'))
      .then(() => {
        stored = true;
        if (window.isDestroyed()) return;
        // A prevented close also stops the quit it was part of: carry on with it.
        if (wasQuitting && !state.updating) app.quit();
        else window.close();
      });
  });
}
