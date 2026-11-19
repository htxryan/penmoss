/**
 * Keep on top and the compact title bar (T46, T47; A720–A725): a main or note window's own
 * state, and reopening every window for a new title-bar style.
 */
import { BrowserWindow, dialog } from 'electron';
import { fullScreens, log, preferencesFile, state, windows } from './app-state';
import { savePreferences } from './preferences';
import { sendEvent } from './ipc';
import { mayReopen, setKeepOnTop, type MacWindowState } from './mac-window';
import { appPath } from './security';
import { createMainWindow } from './windows/main-window';
import { createNoteWindow } from './windows/note-window';
import { storeNow } from './windows/window-common';

export function windowState(window: BrowserWindow): MacWindowState {
  return {
    keepOnTop: window.isAlwaysOnTop(),
    fullScreen: fullScreens.get(window) ?? window.isFullScreen(),
  };
}

/** Tells a window's page its state: the pin button, the menu's tick and the title bar follow. */
export function sendWindowState(window: BrowserWindow): void {
  if (!window.isDestroyed()) {
    sendEvent(window.webContents, 'windowStateChanged', windowState(window));
  }
}

/** Full screen hides the lights, and the page the room it left for them (A722). */
export function watchWindowState(window: BrowserWindow): void {
  window.on('enter-full-screen', () => {
    fullScreens.set(window, true);
    sendWindowState(window);
  });
  window.on('leave-full-screen', () => {
    fullScreens.set(window, false);
    sendWindowState(window);
  });
  // macOS and Windows say when something else changed it.
  window.on('always-on-top-changed', () => sendWindowState(window));
}

/** Pins or unpins a main or note window (A720); the main window's pin is saved (A721). */
export function keepOnTop(window: BrowserWindow, on: boolean): MacWindowState {
  setKeepOnTop(window, on);
  if (window === windows.main) state.saveMainState?.();
  sendWindowState(window);
  return windowState(window);
}

/**
 * Keystrokes and menu commands are dropped while the windows store and reopen (A724), so
 * nothing typed after the save is lost when they close. Clicks still reach the page (blocking
 * them would let them fall through to the app behind): a click changes no text by itself.
 */
export function holdInput(open: readonly BrowserWindow[]): () => void {
  const block = (event: Electron.Event) => event.preventDefault();
  for (const window of open) {
    if (!window.isDestroyed()) window.webContents.on('before-input-event', block);
  }
  state.holdingInput = true;
  return () => {
    state.holdingInput = false;
    for (const window of open) {
      if (!window.isDestroyed()) window.webContents.removeListener('before-input-event', block);
    }
  };
}

/**
 * Settings → Appearance → Compact title bar (A724). Electron cannot restyle an open window, so
 * this asks first, then holds input, has every main and note window store its notes, and
 * reopens them all. A window that could not store everything stops it: nothing changes, and a
 * dialog says so. Answers whether it is on now, and whether the windows reopen.
 */
export async function setCompactTitleBar(
  from: BrowserWindow,
  compact: boolean,
): Promise<{ compact: boolean; reopened: boolean }> {
  const current = state.preferences.compactTitleBar !== false;
  const unchanged = { compact: current, reopened: false };
  if (compact === current || state.reopening) return unchanged;
  const { response } = await dialog.showMessageBox(from, {
    type: 'question',
    message: compact ? 'Use the Compact Title Bar?' : 'Use the Standard Title Bar?',
    detail:
      'Penmoss closes its windows and opens them again to change the title bar. Your notes are saved first.',
    buttons: ['Reopen Windows', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response !== 0 || state.reopening || state.quitting) return unchanged;
  state.reopening = true;
  const open = windows.all().filter((window) => !window.isDestroyed());
  // Nothing typed after the save may be lost: input waits until the windows are gone.
  const release = holdInput(open);
  const refuse = async (detail: string) => {
    release();
    state.reopening = false;
    if (!from.isDestroyed()) {
      await dialog.showMessageBox(from, {
        type: 'warning',
        message: 'The Title Bar Was Not Changed',
        detail,
        buttons: ['OK'],
      });
    }
    return unchanged;
  };
  const stored = await Promise.all(open.map((window) => storeNow(window)));
  // Quitting while the windows stored their notes (the quit's store answers the same waits):
  // nothing changes, and the quit goes on.
  if (state.quitting) {
    release();
    state.reopening = false;
    return unchanged;
  }
  if (!mayReopen(stored)) {
    return refuse(
      'A window could not save its notes in time, so Penmoss left the windows open. Try again in a moment.',
    );
  }
  const next = { ...state.preferences, compactTitleBar: compact };
  try {
    savePreferences(preferencesFile(), next);
  } catch (error) {
    log(`could not save the title-bar setting: ${String(error)}`);
    return refuse('Penmoss could not save the setting on this Mac.');
  }
  state.preferences = next;
  // After the page has its answer: its window is about to go. Input stays held until then.
  setImmediate(() => {
    try {
      if (!state.quitting) reopenWindows(open);
    } finally {
      release();
      state.reopening = false;
    }
  });
  return { compact, reopened: true };
}

/**
 * Closes `open` (main and note windows whose notes are stored) and opens each again where it
 * was: the same page, place, pin, and maximized or full-screen state, each with the new title
 * bar (A724). The window that was in front opens last and comes to the front. One that cannot
 * be made again is logged, and the rest still open.
 */
export function reopenWindows(open: readonly BrowserWindow[]): void {
  const front = windows.active;
  state.saveMainState?.();
  const plans = open
    .filter((window) => !window.isDestroyed())
    .map((window) => ({
      kind: windows.kindOf(window.webContents),
      path: appPath(window.webContents.getURL()) ?? '/',
      bounds: window.getNormalBounds(),
      keepOnTop: window.isAlwaysOnTop(),
      maximized: window.isMaximized(),
      fullScreen: windowState(window).fullScreen,
      front: window === front,
    }));
  for (const window of open) {
    if (window.isDestroyed()) continue;
    window.destroy();
    // Whether or not `closed` has run yet, the registry no longer has it (one main window).
    windows.remove(window);
  }
  // The main window first (menus fall back on it), the one in front last.
  const order = [...plans].sort(
    (a, b) =>
      Number(a.front) - Number(b.front) || Number(b.kind === 'main') - Number(a.kind === 'main'),
  );
  for (const plan of order) {
    try {
      // The main window's place, pin and state come from window-state.json, saved above.
      const window =
        plan.kind === 'main'
          ? createMainWindow(plan.path)
          : createNoteWindow(plan.path, null, plan);
      if (plan.front) {
        window.once('ready-to-show', () => {
          if (!window.isDestroyed()) window.focus();
        });
      }
    } catch (error) {
      log(`could not reopen a ${plan.kind ?? 'closed'} window: ${String(error)}`);
    }
  }
}
