/** The main window (T29): one, at its saved size and place, and what main sends its page. */
import { app, BrowserWindow, screen } from 'electron';
import { macWindows, mac, mainInbox, dataFile, log, started, state, windows } from '../app-state';
import { sendEvent } from '../ipc';
import { PAGE_ORIGIN } from '../config';
import { setKeepOnTop, titleBarOptions } from '../mac-window';
import type { MainDelivery } from '../main-inbox';
import {
  fitToDisplays,
  loadWindowState,
  MIN_HEIGHT,
  MIN_WIDTH,
  saveWindowState,
  type WindowState,
} from '../window-state';
import { showFirst } from './capture-window';
import { background, newTitleBar, storeBeforeClose, track, webPreferences } from './window-common';

export function createMainWindow(path = '/'): BrowserWindow {
  const stateFile = dataFile('window-state.json');
  const saved = fitToDisplays(
    loadWindowState(stateFile),
    screen.getAllDisplays().map((display) => display.workArea),
  );
  const titleBar = newTitleBar();
  const window = new BrowserWindow({
    ...(saved.x !== undefined && saved.y !== undefined ? { x: saved.x, y: saved.y } : {}),
    width: saved.width,
    height: saved.height,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    show: false,
    title: 'Penmoss',
    backgroundColor: background(),
    ...titleBarOptions(titleBar, process.platform),
    webPreferences: webPreferences('main', titleBar),
  });
  track(window, 'main', titleBar);
  // Its page listens again only once a new document asks (T51, A945); closed, nothing waits.
  const contentsId = window.webContents.id;
  window.webContents.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) mainInbox.navigated(contentsId);
  });
  window.on('closed', () => mainInbox.closed(contentsId));
  if (saved.maximized) window.maximize();
  if (saved.fullScreen) window.setFullScreen(true);
  // Pinned when it closed: pinned again (A721).
  if (macWindows && saved.keepOnTop) setKeepOnTop(window, true);
  window.once('ready-to-show', () => {
    showFirst(window);
    log(`window shown ${Date.now() - started} ms after launch`);
  });

  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  // Kept as it was when it started closing (A1577): hiding it, or taking it out of full
  // screen first, is not a change to keep.
  let closing = false;
  const save = () => {
    if (closing || window.isDestroyed()) return;
    const bounds = window.getNormalBounds();
    const next: WindowState = {
      ...bounds,
      maximized: window.isMaximized(),
      fullScreen: window.isFullScreen(),
      keepOnTop: macWindows && window.isAlwaysOnTop(),
    };
    try {
      saveWindowState(stateFile, next);
    } catch (error) {
      log(`could not save the window state: ${String(error)}`);
    }
  };
  const later = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 400);
  };
  window.on('resize', later);
  window.on('move', later);
  window.on('maximize', later);
  window.on('unmaximize', later);
  window.on('enter-full-screen', later);
  window.on('leave-full-screen', later);
  const saveNow = () => {
    if (saveTimer) clearTimeout(saveTimer);
    save();
  };
  state.saveMainState = saveNow;
  storeBeforeClose(window, () => {
    saveNow();
    closing = true;
  });
  window.on('closed', () => {
    if (state.saveMainState === saveNow) state.saveMainState = null;
    // Note windows stay open (A712). Elsewhere the app ends with its last window; a Mac keeps
    // it running (the capture hotkey). Not while the windows open again (A724), nor when a new
    // main window opened while this one stored and pushed out of sight (A1577): it is not the last.
    if (!mac && !state.reopening && !windows.main && windows.notes().length === 0) app.quit();
  });
  void window.loadURL(`${PAGE_ORIGIN}${path}`);
  return window;
}

export function deliverToMain(window: BrowserWindow, item: MainDelivery): void {
  const contents = window.webContents;
  if (mainInbox.deliver(contents.id, item) === 'held') return;
  if (item.kind === 'command')
    sendEvent(contents, 'menuCommand', { id: item.id, accelerator: null });
  else sendEvent(contents, 'openPath', item.path);
}

/** Shows the main window at `path` (a deep link, a menu command after the window was closed). */
export function openInMain(path: string | null): BrowserWindow {
  const main = windows.main;
  if (!main || main.isDestroyed()) return createMainWindow(path ?? '/');
  const window = main;
  // Sent once its page listens (T51, A945): a Quick Access note clicked while it loads opens.
  if (path) deliverToMain(window, { kind: 'path', path });
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  return window;
}
