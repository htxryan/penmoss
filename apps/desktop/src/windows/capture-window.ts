/**
 * The capture window (T30): hidden until the global hotkey, then shown in the upper third of
 * the display under the pointer, like Spotlight. Kept for the next capture.
 */
import { app, BrowserWindow, screen } from 'electron';
import { mac, state, windows } from '../app-state';
import { PAGE_ORIGIN } from '../config';
import { afterCapture } from '../hotkey';
import { sendEvent } from '../ipc';
import { captureWindowOptions, showOnEverySpace } from '../mac-window';
import {
  background,
  recordWindowEvents,
  SAVE_BEFORE_CLOSE_MS,
  storeNow,
  webPreferences,
} from './window-common';

const capture = {
  window: null as BrowserWindow | null,
  /** The window that had focus when the capture window opened (null: another app had it). */
  focusedBefore: null as BrowserWindow | null,
  /** The main window has been shown once (its first show, A904). */
  mainShownOnce: false,
  /** The capture window open now was shown before the main window's first show (A904). */
  whileStarting: false,
};

/** The capture window, once made. */
export const captureWindow = (): BrowserWindow | null => capture.window;

/** Makes the capture window, unless it is there already (it loads once the main window is up). */
export function ensureCaptureWindow(): void {
  capture.window ??= createCaptureWindow();
}

/** A Mac launch at login, not Ryan opening the app (A904). */
function startedOnItsOwn(): boolean {
  return app.getLoginItemSettings().wasOpenedAtLogin;
}

function createCaptureWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 560,
    height: 300,
    show: false,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    title: 'Quick Capture',
    backgroundColor: background(),
    ...captureWindowOptions(process.platform),
    webPreferences: webPreferences('capture'),
  });
  if (mac) showOnEverySpace(window);
  recordWindowEvents(window, 'capture');
  window.on('blur', () => {
    if (window.isVisible()) hideCapture();
  });
  // Kept for the next capture; it goes only when the app quits, once its last keystrokes are
  // stored, as the main window's are (A640).
  let stored = false;
  window.on('close', (event) => {
    if (!state.quitting) {
      event.preventDefault();
      hideCapture();
      return;
    }
    if (stored) return;
    event.preventDefault();
    void storeNow(window, SAVE_BEFORE_CLOSE_MS, 'close').then(() => {
      stored = true;
      // A prevented close also stops the quit it was part of: carry on with it (or, for an
      // update, with the closing of every window that comes before it).
      if (window.isDestroyed()) return;
      if (state.updating) window.close();
      else app.quit();
    });
  });
  void window.loadURL(`${PAGE_ORIGIN}/capture`);
  return window;
}

/**
 * Shows the main window when its page is first ready. A capture window already open (the
 * hotkey pressed while the app was starting, and its small page painted first) keeps the
 * focus: showing the main window as usual took it, and the capture window hides when it
 * loses focus, so the capture vanished (T39 pass 3, A904: capture.spec's first press after
 * a launch).
 */
export function showFirst(window: BrowserWindow): void {
  capture.mainShownOnce = true;
  if (capture.window && !capture.window.isDestroyed() && capture.window.isVisible()) {
    window.showInactive();
  } else {
    window.show();
  }
}

export function showCapture(): void {
  if (!capture.window || capture.window.isDestroyed()) capture.window = createCaptureWindow();
  const window = capture.window;
  const focused = BrowserWindow.getFocusedWindow();
  if (focused !== window) capture.focusedBefore = focused;
  // Before the main window's first show: the hotkey pressed while the app was starting (A904).
  if (!window.isVisible()) capture.whileStarting = !capture.mainShownOnce;
  // Upper third of the display under the pointer, like Spotlight.
  const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const [width] = window.getSize() as [number, number];
  window.setPosition(
    Math.round(workArea.x + (workArea.width - width) / 2),
    Math.round(workArea.y + workArea.height / 4),
  );
  const reveal = () => {
    window.show();
    window.focus();
    // The page reads the shared replica again (settings, folders), keeping its draft.
    sendEvent(window.webContents, 'captureShow');
    // What the main and note windows changed a moment ago (a time zone, an Inbox folder) may
    // not be stored yet: they store it now, and the capture window reads it again.
    const open = windows.all().filter((other) => !other.isDestroyed());
    if (open.length > 0) {
      void Promise.all(open.map((window) => storeNow(window))).then(() => {
        if (!window.isDestroyed()) sendEvent(window.webContents, 'storeChanged');
      });
    }
  };
  if (window.webContents.isLoading()) window.webContents.once('did-finish-load', reveal);
  else reveal();
}

export function hideCapture(): void {
  const window = capture.window;
  if (!window || window.isDestroyed() || !window.isVisible()) return;
  window.hide();
  // Back to the app the hotkey was pressed in, or to the main window Ryan just opened (A904).
  const next = afterCapture({
    mac,
    focusedBefore: capture.focusedBefore !== null,
    openedWhileStarting: capture.whileStarting,
    startedOnItsOwn: mac && startedOnItsOwn(),
  });
  if (next === 'hide-app') app.hide();
  else if (next === 'focus-main') windows.main?.focus();
  capture.focusedBefore = null;
  capture.whileStarting = false;
}
