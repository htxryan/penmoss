/** Note windows (T45, A712): a note in a window of its own. */
import { app, BrowserWindow, screen } from 'electron';
import { mac, macWindows, state, windows } from '../app-state';
import { PAGE_ORIGIN } from '../config';
import { setKeepOnTop, titleBarOptions } from '../mac-window';
import type { Rect } from '../window-state';
import { MIN_HEIGHT, MIN_WIDTH } from '../window-state';
import { cascadeBounds } from '../windows';
import { background, newTitleBar, storeBeforeClose, track, webPreferences } from './window-common';

/**
 * A note in a window of its own (T45, A712): `/window/notes/<id>`, 720×800, cascading from the
 * window in front (`from`, the one that asked). Never saved in window-state.json, so none
 * comes back after a relaunch; closing the main window leaves it open; quitting closes it.
 */
export function createNoteWindow(
  path: string,
  from: BrowserWindow | null,
  /** Where it was, its pin and state, when the windows open again for a new title bar (A724). */
  again?: {
    readonly bounds: Rect;
    readonly keepOnTop: boolean;
    readonly maximized: boolean;
    readonly fullScreen: boolean;
  },
): BrowserWindow {
  const near = from && !from.isDestroyed() ? from : windows.active;
  const nearBounds = near && !near.isDestroyed() ? near.getBounds() : null;
  const display = nearBounds ? screen.getDisplayMatching(nearBounds) : screen.getPrimaryDisplay();
  const titleBar = newTitleBar();
  const window = new BrowserWindow({
    ...(again?.bounds ?? cascadeBounds(nearBounds, display.workArea)),
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    show: false,
    title: 'Penmoss',
    backgroundColor: background(),
    ...titleBarOptions(titleBar, process.platform),
    webPreferences: webPreferences('note', titleBar),
  });
  track(window, 'note', titleBar);
  // A new note window starts unpinned (A721); one opened again keeps its pin.
  if (macWindows && again?.keepOnTop) setKeepOnTop(window, true);
  if (again?.maximized) window.maximize();
  if (again?.fullScreen) window.setFullScreen(true);
  window.once('ready-to-show', () => window.show());
  storeBeforeClose(window);
  window.on('closed', () => {
    if (!mac && !state.reopening && !windows.main && windows.notes().length === 0) app.quit();
  });
  void window.loadURL(`${PAGE_ORIGIN}${path}`);
  return window;
}
