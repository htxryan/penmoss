/**
 * Penmoss for Mac (T29, T30): the main process.
 *
 * One main window runs the bundled web app from `app://penmoss/`, so notes
 * open with no network (the web app's IndexedDB replica, A20), beside any
 * note windows (T45, A712: windows.ts); a hidden capture window waits for the
 * global hotkey (T30). Notes live in git notebooks, which the main process
 * syncs with this Mac's own git (T50, A853); there is no Penmoss server (D48,
 * D49). It builds the menus the page describes from its command registry,
 * writes multi-format clipboard entries, and turns `penmoss://` links into
 * in-app paths. Main and note windows can be kept on top and have the compact title bar on a Mac
 * (T46, T47: mac-window.ts), and the menu bar icon lists the Quick Access notes (T51: tray.ts).
 * Decisions: docs/decisions.md A220–A229, A710–A712, A720–A725, A945, A1051.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  app,
  autoUpdater,
  BrowserWindow,
  clipboard,
  ClipboardItem,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  net,
  protocol,
  safeStorage,
  screen,
  session,
  shell,
  systemPreferences,
  Tray,
  utilityProcess,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
  type WebContents,
} from 'electron';
import { killLiveGit, watchGitProcesses } from '@penmoss/git-notebook/system-git';
import { nodeNotebooks } from '@penmoss/cli/node';
import { AdminCheck, runHelper } from './admin-check';
import { GitNotebooks } from './git-notebooks';
import { GitHubBrowseHost } from './github-browse-host';
import { DeviceSignIn } from './github-device-sign-in';
import { chromiumInit, GitHubToken, screenshotsOf } from './github-token';
import { GitProcessFile } from './git-processes';
import { CHANNELS, TITLE_BAR_ARG, VERSION_ARG, WINDOW_ARG } from './channels';
import { EmbeddingService, parseSearchOptions, parseServiceNotes } from './embedding-service';
import { APP_SCHEME, DEEP_LINK_SCHEME, desktopConfig, PAGE_ORIGIN } from './config';
import { deepLinkFromArgv, parseDeepLink } from './deep-link';
import {
  afterCapture,
  writeLaunchLog,
  defaultCaptureHotkey,
  HotkeyChangeGate,
  loadPreferences,
  normaliseHotkey,
  registrationCertain,
  savePreferences,
  type Preferences,
} from './hotkey';
import {
  captureWindowOptions,
  macWindowsOn,
  mayReopen,
  parseKeepOnTop,
  setKeepOnTop,
  showOnEverySpace,
  titleBarOptions,
  titleBarStyle,
  type MacWindowState,
  type StoreResult,
  type TitleBarStyle,
} from './mac-window';
import { MainInbox, type MainDelivery } from './main-inbox';
import { menuTemplate, parseMenus, type MenuModel } from './menu';
import { serveAsset } from './protocol';
import {
  ALLOWED_PERMISSIONS,
  appPath,
  ClipboardGate,
  isAppFrame,
  isAppUrl,
  isAppWindowFrame,
  isExternalUrl,
} from './security';
import { encryptionUsable } from './sealing';
import { debouncedWriter, parseWindowTheme, windowBackground } from './theme';
import { StoreRequests, storeReply } from './store-requests';
import {
  describeMenu,
  parseQuickAccess,
  pinPath,
  TRAY_ICON,
  TRAY_TOOLTIP,
  trayMenuTemplate,
  type QuickAccessPin,
} from './tray';
import { CLI_FLAG, keptLoginPath, LocalAgents, loginShellPath } from './local-agents';
import { ReleaseNotes } from './release-notes';
import { Updates, updateMode } from './updater';
import {
  fitToDisplays,
  loadWindowState,
  MIN_HEIGHT,
  MIN_WIDTH,
  saveWindowState,
  type Rect,
  type WindowState,
} from './window-state';
import {
  cascadeBounds,
  NoteWindowGate,
  noteWindowPath,
  parseStoredIds,
  WindowRegistry,
  type WindowKind,
} from './windows';

const mac = process.platform === 'darwin';
const started = Date.now();

protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    // A standard, secure origin: IndexedDB, localStorage, fetch and the clipboard work as on https.
    privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true },
  },
]);
app.enableSandbox();
app.setName('Penmoss');

const config = desktopConfig({
  env: process.env,
  packaged: app.isPackaged,
  appPath: app.getAppPath(),
  resourcesPath: process.resourcesPath,
});
if (config.userData) app.setPath('userData', config.userData);

const dataFile = (name: string) => join(app.getPath('userData'), name);
const log = (message: string) => console.log(`[penmoss] ${message}`);

/** The main and note windows (T45, A712): the only way to find one. */
const windows = new WindowRegistry<BrowserWindow>();
/** The main window's menus as it last sent them: the menu bar's once no window is in front. */
let mainMenus: readonly MenuModel[] | null = null;
/** Pages open note windows a few at a time, and at most 20 (A712). */
const noteWindowGate = new NoteWindowGate();
let captureWindow: BrowserWindow | null = null;
/** The window that had focus when the capture window opened (null: another app had it). */
let focusedBeforeCapture: BrowserWindow | null = null;
/** The main window has been shown once (its first show, A904). */
let mainShownOnce = false;
/** The capture window open now was shown before the main window's first show (A904). */
let captureWhileStarting = false;

/** A Mac launch at login, not Ryan opening the app (A904). */
function startedOnItsOwn(): boolean {
  return app.getLoginItemSettings().wasOpenedAtLogin;
}
let quitting = false;
/**
 * Install and Restart asked to quit (PEN-120): the windows close once stored, and Electron's
 * updater then quits and hands over to ShipIt itself.
 */
let updating = false;
/** The windows are being stored, closed and opened again for a new title-bar style (A724). */
let reopening = false;
/** Input is held while they are (A724); for the suite. */
let holdingInput = false;

/** Keep on top and the compact title bar: on a Mac, or the suite standing in for one (A725). */
const macWindows = macWindowsOn(process.platform, config.testMacWindow);
/** The title-bar style each main and note window opened with (A722, A724). */
const titleBars = new WeakMap<BrowserWindow, TitleBarStyle | null>();
/** Whether each main and note window is in full screen, from its own events. */
const fullScreens = new WeakMap<BrowserWindow, boolean>();
/** Writes the main window's state now (its pin, A721), once it has a window. */
let saveMainState: (() => void) | null = null;

function broadcast(channel: string, value?: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(channel, value);
  }
}

/** Sends `channel` to every window but `except` (the one whose news it is). */
function notifyOthers(channel: string, except: WebContents | null, value?: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed() && window.webContents !== except) {
      window.webContents.send(channel, value);
    }
  }
}

// --- windows ---

/** How long a window may take to store its notes before it closes anyway. */
const SAVE_BEFORE_CLOSE_MS = 3000;
/**
 * And, with git notebooks on this Mac, for the push the page waits for as it closes (#170 F8:
 * the page's `CLOSING_SYNC_MS`, 10 s, and a little more); a page that answers sooner closes sooner.
 */
const GIT_PUSH_BEFORE_CLOSE_MS = 11_000;

/**
 * Asks a page to store everything now (before it closes, or before the
 * capture window reads the shared replica); resolves when it has, or after
 * SAVE_BEFORE_CLOSE_MS. Says how it went: reopening a window for a new title bar
 * goes ahead only when its page stored everything (A724).
 */
const storeRequests = new StoreRequests();

function storeNow(
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
      ipcMain.removeListener(CHANNELS.saved, onSaved);
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
    ipcMain.on(CHANNELS.saved, onSaved);
    if (contents.isDestroyed() || contents.isCrashed()) finish('gone');
    else contents.send(CHANNELS.save, request);
  });
}

/** The style a new main or note window opens with: this Mac's setting (A724). */
const newTitleBar = (): TitleBarStyle | null =>
  titleBarStyle(macWindows, preferences.compactTitleBar);

function webPreferences(kind: WindowKind | 'capture', titleBar: TitleBarStyle | null = null) {
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
const background = () =>
  windowBackground(preferences.windowTheme ?? null, nativeTheme.shouldUseDarkColors);

/**
 * The theme's mode for the title bar, menus and dialogs (Light or Dark as chosen,
 * or macOS's own for System); `updated` then paints the windows.
 */
function applyMode(): void {
  const source = preferences.windowTheme?.mode ?? 'system';
  if (nativeTheme.themeSource !== source) nativeTheme.themeSource = source;
}

/** Paints every window in the theme's background again (a new theme, or macOS's appearance). */
function applyBackground(): void {
  const colour = background();
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.setBackgroundColor(colour);
  }
}

function createMainWindow(path = '/'): BrowserWindow {
  const stateFile = dataFile('window-state.json');
  const state = fitToDisplays(
    loadWindowState(stateFile),
    screen.getAllDisplays().map((display) => display.workArea),
  );
  const titleBar = newTitleBar();
  const window = new BrowserWindow({
    ...(state.x !== undefined && state.y !== undefined ? { x: state.x, y: state.y } : {}),
    width: state.width,
    height: state.height,
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
  if (state.maximized) window.maximize();
  if (state.fullScreen) window.setFullScreen(true);
  // Pinned when it closed: pinned again (A721).
  if (macWindows && state.keepOnTop) setKeepOnTop(window, true);
  window.once('ready-to-show', () => {
    showFirst(window);
    log(`window shown ${Date.now() - started} ms after launch`);
  });

  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  const save = () => {
    if (window.isDestroyed()) return;
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
  saveMainState = saveNow;
  storeBeforeClose(window, saveNow);
  window.on('closed', () => {
    if (saveMainState === saveNow) saveMainState = null;
    // Note windows stay open (A712). Elsewhere the app ends with its last window; a Mac keeps
    // it running (the capture hotkey). Not while the windows open again (A724).
    if (!mac && !reopening && windows.notes().length === 0) app.quit();
  });
  void window.loadURL(`${PAGE_ORIGIN}${path}`);
  return window;
}

/**
 * Puts a main or note window in the registry (A712): in front, it gets the menu bar with its
 * own page's menus; closed, it leaves.
 */
function track(window: BrowserWindow, kind: WindowKind, titleBar: TitleBarStyle | null): void {
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
      const menus = (next && windows.menusOf(next)) ?? mainMenus;
      if (menus) setMenus(menus);
    });
  });
}

/** How long a closing window may take: longer while this Mac has git notebooks to push. */
async function closingWait(): Promise<number> {
  const any = await gitNotebooks.list().then(
    (list) => list.length > 0,
    () => false,
  );
  return any ? SAVE_BEFORE_CLOSE_MS + GIT_PUSH_BEFORE_CLOSE_MS : SAVE_BEFORE_CLOSE_MS;
}

/** The last keystrokes go to IndexedDB before the page is torn down (⌘W, ⌘Q). */
function storeBeforeClose(window: BrowserWindow, closing?: () => void): void {
  let stored = false;
  window.on('close', (event) => {
    closing?.();
    if (stored) return;
    event.preventDefault();
    const wasQuitting = quitting;
    void closingWait()
      .then((waitMs) => storeNow(window, waitMs, 'close'))
      .then(() => {
        stored = true;
        if (window.isDestroyed()) return;
        // A prevented close also stops the quit it was part of: carry on with it.
        if (wasQuitting && !updating) app.quit();
        else window.close();
      });
  });
}

/**
 * A note in a window of its own (T45, A712): `/window/notes/<id>`, 720×800, cascading from the
 * window in front (`from`, the one that asked). Never saved in window-state.json, so none
 * comes back after a relaunch; closing the main window leaves it open; quitting closes it.
 */
function createNoteWindow(
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
    if (!mac && !reopening && !windows.main && windows.notes().length === 0) app.quit();
  });
  void window.loadURL(`${PAGE_ORIGIN}${path}`);
  return window;
}

/**
 * What main sends the main window's page from outside it, held until that page listens (T51,
 * A945): see main-inbox.ts. Its page asks for what is held (`menuCommandPending`) once it does.
 */
const mainInbox = new MainInbox();

function deliverToMain(window: BrowserWindow, item: MainDelivery): void {
  const contents = window.webContents;
  if (mainInbox.deliver(contents.id, item) === 'held') return;
  if (item.kind === 'command')
    contents.send(CHANNELS.menuCommand, { id: item.id, accelerator: null });
  else contents.send(CHANNELS.openPath, item.path);
}

/** Shows the main window at `path` (a deep link, a menu command after the window was closed). */
function openInMain(path: string | null): BrowserWindow {
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
  window.on('blur', () => {
    if (window.isVisible()) hideCapture();
  });
  // Kept for the next capture; it goes only when the app quits, once its last keystrokes are
  // stored, as the main window's are (A640).
  let stored = false;
  window.on('close', (event) => {
    if (!quitting) {
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
      if (updating) window.close();
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
function showFirst(window: BrowserWindow): void {
  mainShownOnce = true;
  if (captureWindow && !captureWindow.isDestroyed() && captureWindow.isVisible()) {
    window.showInactive();
  } else {
    window.show();
  }
}

function showCapture(): void {
  if (!captureWindow || captureWindow.isDestroyed()) captureWindow = createCaptureWindow();
  const window = captureWindow;
  const focused = BrowserWindow.getFocusedWindow();
  if (focused !== window) focusedBeforeCapture = focused;
  // Before the main window's first show: the hotkey pressed while the app was starting (A904).
  if (!window.isVisible()) captureWhileStarting = !mainShownOnce;
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
    window.webContents.send(CHANNELS.captureShow);
    // What the main and note windows changed a moment ago (a time zone, an Inbox folder) may
    // not be stored yet: they store it now, and the capture window reads it again.
    const open = windows.all().filter((other) => !other.isDestroyed());
    if (open.length > 0) {
      void Promise.all(open.map((window) => storeNow(window))).then(() => {
        if (!window.isDestroyed()) window.webContents.send(CHANNELS.storeChanged);
      });
    }
  };
  if (window.webContents.isLoading()) window.webContents.once('did-finish-load', reveal);
  else reveal();
}

function hideCapture(): void {
  const window = captureWindow;
  if (!window || window.isDestroyed() || !window.isVisible()) return;
  window.hide();
  // Back to the app the hotkey was pressed in, or to the main window Ryan just opened (A904).
  const next = afterCapture({
    mac,
    focusedBefore: focusedBeforeCapture !== null,
    openedWhileStarting: captureWhileStarting,
    startedOnItsOwn: mac && startedOnItsOwn(),
  });
  if (next === 'hide-app') app.hide();
  else if (next === 'focus-main') windows.main?.focus();
  focusedBeforeCapture = null;
  captureWhileStarting = false;
}

// --- keep on top and the compact title bar (T46, T47; A720–A725) ---

function windowState(window: BrowserWindow): MacWindowState {
  return {
    keepOnTop: window.isAlwaysOnTop(),
    fullScreen: fullScreens.get(window) ?? window.isFullScreen(),
  };
}

/** Tells a window's page its state: the pin button, the menu's tick and the title bar follow. */
function sendWindowState(window: BrowserWindow): void {
  if (!window.isDestroyed()) {
    window.webContents.send(CHANNELS.windowStateChanged, windowState(window));
  }
}

/** Full screen hides the lights, and the page the room it left for them (A722). */
function watchWindowState(window: BrowserWindow): void {
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
function keepOnTop(window: BrowserWindow, on: boolean): MacWindowState {
  setKeepOnTop(window, on);
  if (window === windows.main) saveMainState?.();
  sendWindowState(window);
  return windowState(window);
}

/**
 * Keystrokes and menu commands are dropped while the windows store and reopen (A724), so
 * nothing typed after the save is lost when they close. Clicks still reach the page (blocking
 * them would let them fall through to the app behind): a click changes no text by itself.
 */
function holdInput(open: readonly BrowserWindow[]): () => void {
  const block = (event: Electron.Event) => event.preventDefault();
  for (const window of open) {
    if (!window.isDestroyed()) window.webContents.on('before-input-event', block);
  }
  holdingInput = true;
  return () => {
    holdingInput = false;
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
async function setCompactTitleBar(
  from: BrowserWindow,
  compact: boolean,
): Promise<{ compact: boolean; reopened: boolean }> {
  const current = preferences.compactTitleBar !== false;
  const unchanged = { compact: current, reopened: false };
  if (compact === current || reopening) return unchanged;
  const { response } = await dialog.showMessageBox(from, {
    type: 'question',
    message: compact ? 'Use the compact title bar?' : 'Use the standard title bar?',
    detail:
      'Penmoss closes its windows and opens them again to change the title bar. Your notes are saved first.',
    buttons: ['Reopen Windows', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response !== 0 || reopening || quitting) return unchanged;
  reopening = true;
  const open = windows.all().filter((window) => !window.isDestroyed());
  // Nothing typed after the save may be lost: input waits until the windows are gone.
  const release = holdInput(open);
  const refuse = async (detail: string) => {
    release();
    reopening = false;
    if (!from.isDestroyed()) {
      await dialog.showMessageBox(from, {
        type: 'warning',
        message: 'The title bar was not changed',
        detail,
        buttons: ['OK'],
      });
    }
    return unchanged;
  };
  const stored = await Promise.all(open.map((window) => storeNow(window)));
  // Quitting while the windows stored their notes (the quit's store answers the same waits):
  // nothing changes, and the quit goes on.
  if (quitting) {
    release();
    reopening = false;
    return unchanged;
  }
  if (!mayReopen(stored)) {
    return refuse(
      'A window could not save its notes in time, so Penmoss left the windows open. Try again in a moment.',
    );
  }
  const next = { ...preferences, compactTitleBar: compact };
  try {
    savePreferences(preferencesFile(), next);
  } catch (error) {
    log(`could not save the title-bar setting: ${String(error)}`);
    return refuse('Penmoss could not save the setting on this Mac.');
  }
  preferences = next;
  // After the page has its answer: its window is about to go. Input stays held until then.
  setImmediate(() => {
    try {
      if (!quitting) reopenWindows(open);
    } finally {
      release();
      reopening = false;
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
function reopenWindows(open: readonly BrowserWindow[]): void {
  const front = windows.active;
  saveMainState?.();
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

// --- the capture hotkey (T30) ---

const preferencesFile = () => dataFile('preferences.json');
let preferences: Preferences = {};
/** The chosen theme is kept for the next launch once changes pause (T28). */
const themeWriter = debouncedWriter(() => savePreferences(preferencesFile(), preferences), 500);
interface HotkeyState {
  readonly accelerator: string;
  readonly registered: boolean;
  /** False on a Mac: registered may still mean another app takes the keys first. */
  readonly certain: boolean;
}
const certain = registrationCertain(process.platform);
let hotkey: HotkeyState = {
  accelerator: defaultCaptureHotkey(process.platform),
  registered: false,
  certain,
};
const hotkeyGate = new HotkeyChangeGate();

/** Registers the hotkey, and checks it took where the system can say so. */
function registerHotkey(accelerator: string): boolean {
  try {
    return (
      globalShortcut.register(accelerator, showCapture) && globalShortcut.isRegistered(accelerator)
    );
  } catch {
    return false;
  }
}

function setHotkey(input: string): HotkeyState & { error?: string } {
  const parsed = normaliseHotkey(input, process.platform);
  if ('error' in parsed) return { ...hotkey, error: parsed.error };
  if (parsed.accelerator === hotkey.accelerator && hotkey.registered) return hotkey;
  if (hotkey.registered) globalShortcut.unregister(hotkey.accelerator);
  if (!registerHotkey(parsed.accelerator)) {
    hotkey = { ...hotkey, registered: hotkey.registered && registerHotkey(hotkey.accelerator) };
    return { ...hotkey, error: `${parsed.accelerator} is taken by another app` };
  }
  hotkey = { accelerator: parsed.accelerator, registered: true, certain };
  preferences = { ...preferences, captureHotkey: parsed.accelerator };
  savePreferences(preferencesFile(), preferences);
  // Quick Capture in the menu bar icon's menu shows the new keys.
  refreshTray();
  return hotkey;
}

// --- the menu bar icon (T51 item 17, A945) ---

/** The menu bar icon, while the preference shows it (on a Mac only: the suite keeps the menu). */
let tray: Tray | null = null;
/** The menu it shows, or null while it is off (the Playwright suite reads it). */
let trayTemplate: MenuItemConstructorOptions[] | null = null;
/** The Quick Access notes the main window's page sent last (A946), kept while it is closed. */
let quickAccessPins: readonly QuickAccessPin[] = [];

/**
 * Runs a page command in the main window (shown, or made again), not the window in front:
 * Open Today's Journal opens there, whichever window was in front.
 */
function runInMain(id: string): void {
  if (holdingInput) return;
  deliverToMain(openInMain(null), { kind: 'command', id });
}

/** The icon's menu as it should be now; null while the preference is off. */
function wantedTrayTemplate(): MenuItemConstructorOptions[] | null {
  if (!macWindows || preferences.menuBarIcon === false) return null;
  return trayMenuTemplate(quickAccessPins, hotkey.registered ? hotkey.accelerator : null, {
    capture: () => showCapture(),
    today: () => runInMain('journal.today'),
    openNote: (id) => {
      if (!holdingInput) openInMain(pinPath(id));
    },
    showMain: () => openInMain(null),
  });
}

/**
 * Shows, rebuilds or removes the menu bar icon to match the preference and the pins. The icon
 * is a template image (`dist/tray/trayTemplate.png` and `@2x`), so macOS draws it to suit a
 * light or dark menu bar. Off a Mac (the suite under xvfb) only the menu is kept, not an icon.
 */
function refreshTray(): void {
  trayTemplate = wantedTrayTemplate();
  if (!trayTemplate) {
    tray?.destroy();
    tray = null;
    return;
  }
  if (!mac) return;
  try {
    if (!tray) {
      const image = nativeImage.createFromPath(join(__dirname, 'tray', TRAY_ICON));
      image.setTemplateImage(true);
      tray = new Tray(image);
      tray.setToolTip(TRAY_TOOLTIP);
    }
    tray.setContextMenu(Menu.buildFromTemplate(trayTemplate));
  } catch (error) {
    log(`could not show the menu bar icon: ${String(error)}`);
  }
}

/** Settings → Display → Show Penmoss in the Menu Bar (A945): saved for this Mac, then applied. */
function setMenuBarIcon(shown: boolean): boolean {
  const current = preferences.menuBarIcon !== false;
  if (current !== shown) {
    const next = { ...preferences, menuBarIcon: shown };
    try {
      savePreferences(preferencesFile(), next);
    } catch (error) {
      log(`could not save the menu bar icon setting: ${String(error)}`);
      return current;
    }
    preferences = next;
  }
  refreshTray();
  return preferences.menuBarIcon !== false;
}

// --- IPC: only from the app's own pages ---

const fromApp = (event: IpcMainEvent | IpcMainInvokeEvent): boolean => isAppFrame(event);
/** From a main or note window's page, never the capture window's (A503, A712). */
const fromAppWindow = (event: IpcMainEvent | IpcMainInvokeEvent): boolean =>
  isAppWindowFrame(event, (contents) => windows.kindOf(contents));
/** From the main window's page alone: Settings (T54). */
const fromMainWindow = (event: IpcMainEvent | IpcMainInvokeEvent): boolean =>
  fromAppWindow(event) && windows.kindOf(event.sender) === 'main';
const clipboardGate = new ClipboardGate();

/**
 * Touch ID or the Mac's password before an owner check on a git notebook (removing it, Delete
 * for good; T41, D34, A504, A855), never a plain confirmation: Touch
 * ID itself where the Mac has it, else the signed helper in the app, which only answers with its
 * exit code.
 */
const adminCheck = new AdminCheck({
  helper: config.authHelper,
  run: runHelper,
  // Main's own checks ask Touch ID itself where the Mac has it (T50, A855); the suite's stand-in
  // answers them all.
  touchId:
    mac && !config.testAuthHelper
      ? {
          can: () => systemPreferences.canPromptTouchID(),
          prompt: (reason) => systemPreferences.promptTouchID(reason),
        }
      : null,
});
// --- git notebooks (T50 G3, G5; A853–A857) ---

/** Whether safeStorage really encrypts here (sealing.ts). */
const sealable = async () =>
  encryptionUsable({
    platform: process.platform,
    available: await safeStorage.isAsyncEncryptionAvailable(),
    backend: process.platform === 'linux' ? safeStorage.getSelectedStorageBackend() : 'unknown',
    allowBasicText: config.allowBasicTextStorage,
  });
const gitNotebooks = new GitNotebooks({
  dir: app.getPath('userData'),
  seal: async (plain) =>
    (await sealable()) ? (await safeStorage.encryptStringAsync(plain)).toString('base64') : null,
  unseal: async (sealed) => {
    if (!(await sealable())) return null;
    return (await safeStorage.decryptStringAsync(Buffer.from(sealed, 'base64'))).result;
  },
  ownerCheck: (words) => adminCheck.confirmOwn(words),
  platform: process.platform,
  ...(config.gitEnv ? { gitEnv: config.gitEnv } : {}),
  log,
  onChange: () => {
    broadcast(CHANNELS.gitChanged);
    // Every agent on this Mac reaches every notebook in the app (D52).
    void localAgents.ensureAll();
  },
});
/**
 * Release notes for Settings → Updates (PEN-108): fetched from beside the channel's update feed
 * on every check and when Settings asks, at most once an hour, and kept in userData.
 */
const releaseNotes = new ReleaseNotes({
  mode: () => updateMode(app.isPackaged, process.resourcesPath),
  dir: app.getPath('userData'),
  log,
  onChange: (file) => broadcast(CHANNELS.updatesNotesChanged, file),
});
/** Auto-Update from GitHub Releases, Stable or Alpha (T64 item 2, A1112, A1196): no token. */
const updates = new Updates({
  mode: () => updateMode(app.isPackaged, process.resourcesPath),
  version: () => config.testVersion ?? app.getVersion(),
  dir: app.getPath('userData'),
  log,
  onChange: (state) => {
    if (state.phase === 'checking') void releaseNotes.refresh(state.channel);
    broadcast(CHANNELS.updatesChanged, state);
  },
});
/** The CLI's `~/.penmoss` (A992): agents' clones, and search by meaning's model and vectors. */
const penmossHome = process.env['PENMOSS_HOME'] || join(homedir(), '.penmoss');
/**
 * Search by meaning (T76, A1152, A1157, A1158): the embedding service in a utilityProcess, which
 * downloads the model unless the setting is off, holds the indexing lease and answers the
 * page's queries. Main relays the page's named calls to it and restarts it after a crash.
 */
const meaning =
  config.testMeaning === 'off'
    ? null
    : new EmbeddingService({
        writeSetting: async (enabled) => {
          await mkdir(penmossHome, { recursive: true });
          await writeFile(
            join(penmossHome, 'meaning.json'),
            `${JSON.stringify({ enabled }, null, 2)}\n`,
          );
        },
        fork: () => {
          const child = utilityProcess.fork(join(__dirname, 'embed-utility.cjs'), [], {
            serviceName: 'Penmoss Search by Meaning',
            stdio: ['ignore', 'pipe', 'pipe'],
            env: {
              ...process.env,
              PENMOSS_HOME: penmossHome,
              ...(config.testMeaning === 'no-download' ? { PENMOSS_MEANING_DOWNLOAD: '0' } : {}),
            },
          });
          const forward = (chunk: Buffer) => {
            for (const line of chunk.toString('utf8').split('\n')) if (line.trim()) log(line);
          };
          child.stdout?.on('data', forward);
          child.stderr?.on('data', forward);
          return child;
        },
        onStatus: (status) => broadcast(CHANNELS.meaningChanged, status),
        log,
      });
/**
 * The person's own GitHub token (T57, A1010–A1012): Send feedback is filed with it from here.
 * Sealed like the git tokens. Updates no longer need it (A1112).
 */
const githubToken = new GitHubToken({
  dir: app.getPath('userData'),
  seal: async (plain) =>
    (await sealable()) ? (await safeStorage.encryptStringAsync(plain)).toString('base64') : null,
  unseal: async (sealed) => {
    if (!(await sealable())) return null;
    return (await safeStorage.decryptStringAsync(Buffer.from(sealed, 'base64'))).result;
  },
  fetch: (url, init) => net.fetch(url instanceof Request ? url : String(url), chromiumInit(init)),
  api: config.githubApi,
  log,
  onChange: () => {
    broadcast(CHANNELS.githubTokenChanged);
  },
});
/**
 * Add a Git Notebook's GitHub browsing (T81, A1163–A1165): git's own credential, asked for on
 * each call, sent only to the GitHub API base; the page sees repositories and folders.
 */
const githubBrowse = new GitHubBrowseHost({
  fetch: (url, init) => net.fetch(url, chromiumInit(init)),
  api: config.githubApi,
  gitEnv: config.gitEnv,
  // Penmoss's own sign-in when git has none (T82, A1171).
  penmossToken: () => githubToken.token(),
  onPenmossRefused: () => githubToken.refused(),
});
/**
 * Sign in with GitHub (T82, A1170): the device flow for Penmoss's OAuth app. The token goes to
 * the GitHub Token store; the page sees the code to enter and the outcome.
 */
const githubSignIn = new DeviceSignIn({
  fetch: (url, init) => net.fetch(url, init),
  clientId: config.githubClientId,
  web: config.githubWeb,
  // The suite's fake GitHub (unpackaged builds only) opens no browser: it is only logged.
  openExternal: (url) =>
    config.githubWeb ? Promise.resolve(log(`sign-in page ${url}`)) : shell.openExternal(url),
  keep: async (token) => {
    const login = await githubBrowse.loginOf(token);
    return { kept: await githubToken.saveSignedIn(token, login), login };
  },
  onChange: (state) => broadcast(CHANNELS.githubSignInChanged, state),
  log,
});
/**
 * Agents on this Mac with no account (T54, A992–A994): the `penmoss` command, which is this binary
 * with `--penmoss-cli`, and agents' clones of a git notebook in the CLI's own `~/.penmoss`.
 */
/** The terminal's PATH, asked of the login shell as the app starts and kept (A1124). */
const loginPath = keptLoginPath(() => loginShellPath(process.env['SHELL'] || '/bin/zsh'));
const localAgents = new LocalAgents({
  cli: [app.getPath('exe'), ...(app.isPackaged ? [] : [app.getAppPath()]), CLI_FLAG],
  home: config.testHome ?? homedir(),
  shell: process.env['SHELL'] || '/bin/zsh',
  loginPath: loginPath.get,
  notebooks: () =>
    nodeNotebooks({
      home: penmossHome,
      env: process.env,
      platform: process.platform,
      ...(process.getuid ? { uid: process.getuid() } : {}),
      ...(config.gitEnv ? { gitEnv: config.gitEnv } : {}),
      terminal: () => false,
    }),
  notebook: (localId) => gitNotebooks.forAgent(localId),
  all: () => gitNotebooks.forAgents(),
  ownerCheck: (words) => adminCheck.confirmOwn(words),
  log,
});
/** Every git a git notebook runs, so a crashed run's leftovers die at the next launch (A853). */
const gitProcesses = new GitProcessFile(dataFile('git-processes.json'), { log });
/** The owner checks need a person behind them: refused without a key press or click (A855). */
const NEEDS_A_PERSON = {
  ok: false,
  error: { code: 'not_confirmed', message: 'Not done: confirm with a click or a key press.' },
} as const;

const MAX_CLIPBOARD_CHARS = 64 * 1024 * 1024;
const MARKDOWN_FORMAT: Partial<Record<NodeJS.Platform, string>> = {
  darwin: 'electron application/osclipboard;format="net.daringfireball.markdown"',
  linux: 'electron application/osclipboard;format="text/markdown"',
};

/** One clipboard entry with every format the page gave (T29's clipboard bridge). */
async function writeClipboard(data: unknown): Promise<boolean> {
  if (typeof data !== 'object' || data === null) return false;
  const { text, html, markdown } = data as Record<string, unknown>;
  const valid = (value: unknown) =>
    value === undefined || (typeof value === 'string' && value.length <= MAX_CLIPBOARD_CHARS);
  if (typeof text !== 'string' || !valid(text) || !valid(html) || !valid(markdown)) return false;
  const entry: Record<string, string> = { 'text/plain': text };
  if (typeof html === 'string') entry['text/html'] = html;
  const markdownFormat = MARKDOWN_FORMAT[process.platform];
  if (typeof markdown === 'string' && markdownFormat) entry[markdownFormat] = markdown;
  await clipboard.write([new ClipboardItem(entry)]);
  return true;
}

function sendMenuCommand(id: string, accelerator: string | null): void {
  // Not while the windows store and reopen for a new title bar (A724).
  if (holdingInput) return;
  // A menu click is a user's choice the page never sees: its copy command may write.
  clipboardGate.menuCommand(Date.now());
  // To the window in front (A712); with none open, the main window, made again.
  const active = windows.active;
  const window =
    active && !active.isDestroyed() && active !== windows.main ? active : openInMain(null);
  // A minimized note window shows first, as the main window does: ⌘N or Move to Trash
  // never acts where you cannot see it.
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  const send = () => window.webContents.send(CHANNELS.menuCommand, { id, accelerator });
  if (window.webContents.isLoading()) window.webContents.once('did-finish-load', send);
  else send();
}

function setMenus(menus: readonly MenuModel[]): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      menuTemplate(menus, {
        platform: process.platform,
        appName: app.name,
        devTools: config.devTools,
        onCommand: sendMenuCommand,
        onShowMain: () => openInMain(null),
      }),
    ),
  );
}

function registerIpc(): void {
  // The theme on screen (T28): kept for the next launch, and painted behind every window.
  ipcMain.on(CHANNELS.themeSet, (event, value: unknown) => {
    if (!fromAppWindow(event)) return;
    const theme = parseWindowTheme(value);
    if (!theme) return;
    const before = preferences.windowTheme;
    if (before?.light !== theme.light || before.dark !== theme.dark || before.mode !== theme.mode) {
      preferences = { ...preferences, windowTheme: theme };
      // Written once edits pause (a dragged colour sends many), and on quit.
      themeWriter.schedule(undefined);
    }
    applyMode();
    applyBackground();
  });
  // Each window sends its own menus; the menu bar shows those of the window in front (A712).
  ipcMain.on(CHANNELS.menuSet, (event, value: unknown) => {
    const window = fromAppWindow(event) ? windows.windowOf(event.sender) : null;
    const menus = window ? parseMenus(value) : null;
    if (!window || !menus) return;
    if (window === windows.main) mainMenus = menus;
    if (windows.setMenus(window, menus)) setMenus(menus);
  });
  // `gesture`: the preload's `navigator.userActivation.isActive`, which page scripts cannot set.
  ipcMain.handle(CHANNELS.clipboardWrite, (event, data: unknown, gesture: unknown) =>
    fromApp(event) && clipboardGate.allows({ gesture: gesture === true, now: Date.now() })
      ? writeClipboard(data)
      : false,
  );
  ipcMain.on(CHANNELS.captureDone, (event, saved: unknown) => {
    if (!fromApp(event) || event.sender !== captureWindow?.webContents) return;
    hideCapture();
    // The other windows read the capture from IndexedDB now, not on their next write.
    if (saved === true) notifyOthers(CHANNELS.storeChanged, event.sender);
  });
  // A page stored records (T45, A711): every other window reads them now, offline too.
  ipcMain.on(CHANNELS.stored, (event, ids: unknown) => {
    if (!fromApp(event)) return;
    // The main and note windows only: the hidden capture window reads the store again as it
    // shows (showCapture), and reading each write would have it upload them a second time.
    const changed = parseStoredIds(ids);
    for (const window of windows.all()) {
      if (!window.isDestroyed() && window.webContents !== event.sender) {
        window.webContents.send(CHANNELS.storeChanged, changed);
      }
    }
  });
  // Keep on top and the compact title bar (T46, T47): a main or note window's own (A720–A724).
  const macWindowOf = (event: IpcMainEvent | IpcMainInvokeEvent) =>
    macWindows && fromAppWindow(event) ? windows.windowOf(event.sender) : null;
  ipcMain.handle(CHANNELS.windowState, (event) => {
    const window = macWindowOf(event);
    return window ? windowState(window) : null;
  });
  ipcMain.handle(CHANNELS.keepOnTop, (event, value: unknown) => {
    const window = macWindowOf(event);
    const on = parseKeepOnTop(value);
    if (!window || on === null) return null;
    return keepOnTop(window, on);
  });
  // Only just after a key press or click in the page (the preload's user activation).
  ipcMain.handle(CHANNELS.compactTitleBar, (event, value: unknown, gesture: unknown) => {
    const window = macWindowOf(event);
    if (!window || typeof value !== 'boolean' || gesture !== true) return null;
    return setCompactTitleBar(window, value);
  });
  // The menu bar icon (T51 item 17, A945): read by Settings → Display in a main or note window,
  // changed only just after a key press or click there.
  ipcMain.handle(CHANNELS.menuBarIconGet, (event) =>
    macWindowOf(event) ? preferences.menuBarIcon !== false : null,
  );
  ipcMain.handle(CHANNELS.menuBarIconSet, (event, value: unknown, gesture: unknown) => {
    if (!macWindowOf(event) || typeof value !== 'boolean' || gesture !== true) return null;
    return setMenuBarIcon(value);
  });
  // A command held for the main window while it loaded (A945): its page asks once it listens.
  // Asking says the page listens now: later ones are sent to it straight away.
  ipcMain.handle(CHANNELS.menuCommandPending, (event) => {
    if (!fromApp(event) || !windows.main || event.sender !== windows.main.webContents) return null;
    const item = mainInbox.take(event.sender.id);
    if (!item) return null;
    return item.kind === 'command' ? item.id : { path: item.path };
  });
  // Its Quick Access notes (A946): from the main window's page only, checked.
  ipcMain.on(CHANNELS.quickAccessSet, (event, value: unknown) => {
    const window = macWindowOf(event);
    const pins = window && window === windows.main ? parseQuickAccess(value) : null;
    if (!pins) return;
    quickAccessPins = pins;
    refreshTray();
  });
  // Send feedback (T49, A798): the asking window's own page, never another window's, as PNG.
  // Git notebooks (T50, A853–A857): main and note windows only. Main checks every argument.
  // Listed to the capture window too, which files captures in the Journal notebook (A827).
  ipcMain.handle(CHANNELS.gitList, (event) => (fromApp(event) ? gitNotebooks.list() : []));
  ipcMain.handle(CHANNELS.gitAdd, async (event, input: unknown) => {
    if (!fromAppWindow(event) || typeof input !== 'object' || input === null) return null;
    const fields = input as Record<string, unknown>;
    // A repository picked through Penmoss's sign-in gets its token (A1171): from the main
    // window's Add, and only for a github.com address over HTTPS.
    const signedIn =
      fields['githubSignIn'] === true &&
      fromMainWindow(event) &&
      typeof fields['remote'] === 'string' &&
      fields['remote'].startsWith('https://github.com/');
    return gitNotebooks.add({
      remote: fields['remote'],
      branch: fields['branch'],
      dir: fields['dir'],
      name: fields['name'],
      token: signedIn ? await githubToken.token() : null,
    });
  });
  ipcMain.handle(
    CHANNELS.gitRemove,
    (event, localId: unknown, unpushed: unknown, gesture: unknown) => {
      if (!fromAppWindow(event)) return null;
      return gesture === true ? gitNotebooks.remove(localId, unpushed) : NEEDS_A_PERSON;
    },
  );
  ipcMain.handle(
    CHANNELS.gitUpdate,
    (event, localId: unknown, patch: unknown, gesture: unknown) => {
      if (!fromAppWindow(event)) return null;
      // Who commits is the person's to set (#174 review): after a click or a key press in the app.
      const author = typeof patch === 'object' && patch !== null && 'author' in patch;
      if (author && gesture !== true) return NEEDS_A_PERSON;
      return gitNotebooks.update(localId, patch);
    },
  );
  ipcMain.handle(CHANNELS.gitToken, (event, localId: unknown, token: unknown) =>
    fromAppWindow(event) ? gitNotebooks.setToken(localId, token) : null,
  );
  ipcMain.handle(
    CHANNELS.gitPurgeCheck,
    (event, localId: unknown, noteId: unknown, gesture: unknown) => {
      if (!fromAppWindow(event)) return null;
      return gesture === true ? gitNotebooks.purgeCheck(localId, noteId) : NEEDS_A_PERSON;
    },
  );
  ipcMain.handle(
    CHANNELS.gitRestoreCheck,
    (event, localId: unknown, noteId: unknown, revert: unknown, gesture: unknown) => {
      if (!fromAppWindow(event)) return null;
      return gesture === true ? gitNotebooks.restoreCheck(localId, noteId, revert) : NEEDS_A_PERSON;
    },
  );
  ipcMain.handle(CHANNELS.gitPurgesToConfirm, (event, localId: unknown, also: unknown) =>
    fromAppWindow(event) ? gitNotebooks.purgesToConfirm(localId, also ?? []) : null,
  );
  ipcMain.handle(CHANNELS.gitSecret, (event, localId: unknown, value: unknown) =>
    fromAppWindow(event) ? gitNotebooks.writerSecret(localId, value) : null,
  );
  ipcMain.handle(CHANNELS.gitOp, (event, localId: unknown, op: unknown, args: unknown) =>
    fromAppWindow(event) ? gitNotebooks.op(localId, op, args) : null,
  );
  // Answered once main has stopped them, so the page counts a sync stopped only when it is.
  ipcMain.handle(CHANNELS.gitCancel, (event, localId: unknown) => {
    if (fromAppWindow(event) && typeof localId === 'string') gitNotebooks.cancel(localId);
    return null;
  });
  ipcMain.handle(CHANNELS.gitIdentity, (event) =>
    fromAppWindow(event) ? gitNotebooks.identity() : null,
  );
  // Browsing GitHub in Add a Git Notebook (T81, A1165): the main window only, where adding is.
  ipcMain.handle(CHANNELS.gitGithubRepos, (event) =>
    fromMainWindow(event) ? githubBrowse.repos() : null,
  );
  ipcMain.handle(CHANNELS.gitGithubFolders, (event, fullName: unknown, branch: unknown) =>
    fromMainWindow(event) ? githubBrowse.folders(fullName, branch) : null,
  );
  ipcMain.handle(CHANNELS.gitGithubOwners, (event) =>
    fromMainWindow(event) ? githubBrowse.owners() : null,
  );
  ipcMain.handle(
    CHANNELS.gitGithubCreate,
    (event, owner: unknown, name: unknown, gesture: unknown) => {
      if (!fromMainWindow(event)) return null;
      return gesture === true ? githubBrowse.create(owner, name) : NEEDS_A_PERSON;
    },
  );
  // Sign in with GitHub (T82, A1170): the main window only; starting it is the person's.
  ipcMain.handle(CHANNELS.githubSignInStatus, async (event) =>
    fromMainWindow(event)
      ? {
          available: githubSignIn.available,
          state: githubSignIn.state(),
          login: (await githubToken.status()).login,
        }
      : null,
  );
  ipcMain.handle(CHANNELS.githubSignInStart, (event, gesture: unknown) => {
    if (!fromMainWindow(event)) return null;
    return gesture === true ? githubSignIn.start() : NEEDS_A_PERSON;
  });
  ipcMain.handle(CHANNELS.githubSignInCancel, (event) => {
    if (fromMainWindow(event)) githubSignIn.cancel();
    return null;
  });
  // Agents on this Mac (T54, A992, A993): the main window's Settings only.
  ipcMain.handle(CHANNELS.agentsList, (event, localId: unknown) =>
    fromMainWindow(event) ? localAgents.list(localId) : null,
  );
  ipcMain.handle(
    CHANNELS.agentsConnect,
    (event, localId: unknown, label: unknown, gesture: unknown) => {
      if (!fromMainWindow(event)) return null;
      return gesture === true ? localAgents.connect(localId, label) : NEEDS_A_PERSON;
    },
  );
  ipcMain.handle(
    CHANNELS.agentsDisconnect,
    (event, name: unknown, force: unknown, gesture: unknown) => {
      if (!fromMainWindow(event)) return null;
      return gesture === true ? localAgents.disconnect(name, force) : NEEDS_A_PERSON;
    },
  );
  ipcMain.handle(CHANNELS.cliStatus, (event) =>
    fromMainWindow(event) ? localAgents.cliStatus() : null,
  );
  ipcMain.handle(CHANNELS.cliInstall, (event, gesture: unknown) => {
    if (!fromMainWindow(event)) return null;
    return gesture === true ? localAgents.installCli() : NEEDS_A_PERSON;
  });
  ipcMain.handle(CHANNELS.cliRemove, (event, gesture: unknown) => {
    if (!fromMainWindow(event)) return null;
    return gesture === true ? localAgents.removeCli() : NEEDS_A_PERSON;
  });
  // Search by meaning (T76): main and note windows search; the switch is the main window's,
  // after a click or key press (A1158). The page's notes and options are checked first.
  ipcMain.handle(CHANNELS.meaningStatus, (event) =>
    fromAppWindow(event) ? (meaning?.status() ?? null) : null,
  );
  ipcMain.handle(CHANNELS.meaningUpdate, (event, notebookId: unknown, notes: unknown) => {
    const parsed = parseServiceNotes(notes);
    if (!fromAppWindow(event) || typeof notebookId !== 'string' || !parsed) return [];
    return meaning?.update(notebookId, parsed) ?? [];
  });
  ipcMain.handle(CHANNELS.meaningClose, (event, notebookId: unknown) => {
    if (!fromAppWindow(event) || typeof notebookId !== 'string') return null;
    return meaning?.close(notebookId) ?? null;
  });
  ipcMain.handle(
    CHANNELS.meaningSearch,
    (event, notebookId: unknown, query: unknown, options: unknown) => {
      const parsed = parseSearchOptions(options);
      if (!fromAppWindow(event) || typeof notebookId !== 'string') return null;
      if (typeof query !== 'string' || query.length > 2_000 || !parsed) return null;
      return meaning?.search(notebookId, query, parsed) ?? null;
    },
  );
  ipcMain.handle(CHANNELS.meaningSetEnabled, (event, on: unknown, gesture: unknown) => {
    if (!fromMainWindow(event) || typeof on !== 'boolean' || gesture !== true) return null;
    return meaning?.setEnabled(on) ?? null;
  });
  // Auto-Update (A1112, A1196): anyone may read the state and check; the switch, the channel and
  // Install and Restart are the person's, after a click or key press (main window only).
  ipcMain.handle(CHANNELS.updatesState, (event) =>
    fromAppWindow(event) ? updates.current() : null,
  );
  ipcMain.handle(CHANNELS.updatesCheck, (event) => (fromAppWindow(event) ? updates.check() : null));
  ipcMain.handle(CHANNELS.updatesSetAuto, (event, on: unknown, gesture: unknown) => {
    if (!fromMainWindow(event) || typeof on !== 'boolean') return null;
    return gesture === true ? updates.setAuto(on) : null;
  });
  ipcMain.handle(CHANNELS.updatesSetChannel, (event, channel: unknown, gesture: unknown) => {
    if (!fromMainWindow(event) || (channel !== 'stable' && channel !== 'alpha')) return null;
    return gesture === true ? updates.setChannel(channel) : null;
  });
  ipcMain.handle(CHANNELS.updatesInstall, (event, gesture: unknown) => {
    if (!fromMainWindow(event)) return null;
    return gesture === true ? updates.install() : null;
  });
  // The notice after an update (PEN-110): answered after a click, in the main window.
  ipcMain.handle(CHANNELS.updatesAcknowledge, (event, gesture: unknown) => {
    if (!fromMainWindow(event)) return null;
    return gesture === true ? updates.acknowledge() : null;
  });
  // Release notes (PEN-108): the cached file at once; a newer one follows as a change.
  ipcMain.handle(CHANNELS.updatesNotes, async (event) => {
    if (!fromAppWindow(event)) return null;
    void updates.current().then((state) => releaseNotes.refresh(state.channel));
    return releaseNotes.current();
  });
  // The GitHub token (A1012): what it is is never sent back; saving and removing it are the
  // person's, after a click or key press in Settings (main window only).
  ipcMain.handle(CHANNELS.githubTokenStatus, (event) =>
    fromAppWindow(event) ? githubToken.status() : null,
  );
  ipcMain.handle(CHANNELS.githubTokenSave, (event, token: unknown, gesture: unknown) => {
    if (!fromMainWindow(event)) return null;
    return gesture === true
      ? githubToken.save(token)
      : { ok: false, message: NEEDS_A_PERSON.error.message };
  });
  ipcMain.handle(CHANNELS.githubTokenRemove, async (event, gesture: unknown) => {
    if (!fromMainWindow(event)) return null;
    return gesture === true
      ? { ok: true, status: await githubToken.remove() }
      : { ok: false, message: NEEDS_A_PERSON.error.message };
  });
  // Send feedback filed here with that token (A1010, A1011): the outbox's entry, as it was sent.
  ipcMain.handle(CHANNELS.feedbackFile, (event, payload: unknown, screenshots: unknown) => {
    if (!fromAppWindow(event)) return null;
    const shots = screenshotsOf(screenshots);
    if (!shots) {
      return {
        status: 400,
        body: { error: { code: 'invalid_request', message: 'Screenshots are not readable' } },
      };
    }
    return githubToken.file(payload, shots);
  });
  ipcMain.handle(CHANNELS.feedbackCapture, async (event) => {
    if (!fromAppWindow(event)) return null;
    try {
      const image = await event.sender.capturePage();
      return image.isEmpty() ? null : new Uint8Array(image.toPNG());
    } catch {
      return null;
    }
  });
  ipcMain.handle(CHANNELS.captureHotkey, (event) => (fromApp(event) ? hotkey : null));
  // Only Settings → Keyboard Shortcuts, after a key press or click: from a main or note
  // window's app frame (A712; Settings shows in the main window), never the capture window.
  ipcMain.handle(CHANNELS.captureSetHotkey, (event, value: unknown, gesture: unknown) => {
    if (!fromAppWindow(event)) return null;
    if (typeof value !== 'string' || value.length > 100) return null;
    const refused = hotkeyGate.check({
      url: event.senderFrame?.url ?? '',
      gesture: gesture === true,
      now: Date.now(),
    });
    return refused ? { ...hotkey, error: refused } : setHotkey(value);
  });
}

// --- what pages may do (A224) ---

function harden(contents: WebContents): void {
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

app.on('web-contents-created', (_event, contents) => harden(contents));

// --- deep links ---

function handleLink(link: string): void {
  const parsed = parseDeepLink(link);
  if (!parsed) return;
  if (parsed.kind === 'capture') showCapture();
  else openInMain(parsed.path);
}

let pendingLink = deepLinkFromArgv(process.argv);
app.on('open-url', (event, url) => {
  event.preventDefault();
  if (app.isReady()) handleLink(url);
  else pendingLink = url;
});

// --- start ---

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const link = deepLinkFromArgv(argv);
    if (link) handleLink(link);
    else openInMain(null);
  });
  if (app.isPackaged) app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME);

  void app.whenReady().then(() => {
    protocol.handle(APP_SCHEME, (request) => serveAsset(config.webRoot, request));
    const allowed = (permission: string) => ALLOWED_PERMISSIONS.has(permission);
    session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) =>
      callback(allowed(permission)),
    );
    session.defaultSession.setPermissionCheckHandler((_contents, permission) =>
      allowed(permission),
    );
    // What a crashed run left running is killed first; every git from here on is recorded (A853).
    gitProcesses.cleanUp();
    // Every agent on this Mac reaches every notebook in the app (D52), after the launch settles.
    setTimeout(() => void localAgents.ensureAll(), 3_000).unref();
    watchGitProcesses(gitProcesses);
    registerIpc();
    setMenus([]);

    const parsed = pendingLink ? parseDeepLink(pendingLink) : null;
    pendingLink = null;
    // Read before the first window, which opens in the remembered theme's background.
    preferences = loadPreferences(preferencesFile());
    // How macOS says this launch started (A904), for a Mac run to check wasOpenedAtLogin: a
    // debug log beside the preferences (launch.log), nothing shown.
    if (process.platform === 'darwin') {
      const settings = app.getLoginItemSettings();
      log(`launch: wasOpenedAtLogin=${String(settings.wasOpenedAtLogin)}`);
      try {
        writeLaunchLog(dataFile('launch.log'), settings, new Date());
      } catch (error) {
        log(`could not write the launch log: ${String(error)}`);
      }
    }
    nativeTheme.on('updated', applyBackground);
    applyMode();
    createMainWindow(parsed?.kind === 'path' ? parsed.path : '/');

    // A stored choice is checked again (the file is only this Mac's, but it is still input).
    const stored = normaliseHotkey(preferences.captureHotkey ?? '', process.platform);
    const wanted =
      'accelerator' in stored ? stored.accelerator : defaultCaptureHotkey(process.platform);
    hotkey = { accelerator: wanted, registered: registerHotkey(wanted), certain };
    if (!hotkey.registered) log(`the capture hotkey ${wanted} is taken by another app`);
    // The menu bar icon, when this Mac's preference shows it (A945); its notes come from the page.
    refreshTray();
    // The capture window loads once the main window is up, so it costs launch nothing.
    windows.main?.webContents.once('did-finish-load', () => {
      captureWindow ??= createCaptureWindow();
      if (parsed?.kind === 'capture') showCapture();
    });

    // Search by meaning's service (T76), once the first window is up, so launch waits for nothing.
    setTimeout(() => meaning?.start(), 2_000).unref();
    // Auto-Update (A1112): checks 10 s after launch, and hourly, while its switch is on.
    setTimeout(() => void updates.start(), 10_000);
    // Settings → Agents says whether the command's folder is on PATH: asked now, not as it opens.
    loginPath.warm();
  });

  // The Dock icon (A712, PEN-67): with no window visible, the window minimized last comes
  // back, and the others stay minimized; otherwise the main window, made again when only note
  // windows are open. Electron tells macOS not to restore one itself when none is visible.
  app.on('activate', (_event, hasVisibleWindows) => {
    const minimized = hasVisibleWindows ? null : windows.lastMinimized();
    if (minimized) {
      minimized.restore();
      minimized.focus();
      return;
    }
    if (!windows.main) createMainWindow();
  });
  app.on('before-quit', () => {
    quitting = true;
  });
  // Install and Restart (PEN-120, A1337): Electron's quitAndInstall closes every window before
  // `before-quit`, so the quit starts here, or the capture window would only hide, the app would
  // never quit, and ShipIt would wait for an exit that never comes. Each window stores its last
  // keystrokes and closes; once none is left, the updater quits into the update.
  autoUpdater.on('before-quit-for-update', () => {
    quitting = true;
    updating = true;
  });
  app.on('will-quit', () => {
    // No git outlives the app (A853): a sync still running is stopped, the notebook keeps it.
    killLiveGit();
    meaning?.stop();
    themeWriter.flush();
    // What pages kept in local storage as they went (A626) reaches the disk before the app ends.
    session.defaultSession.flushStorageData();
    globalShortcut.unregisterAll();
  });
  app.on('window-all-closed', () => {
    if (!mac && !reopening) app.quit();
  });
  // Ended by a signal (a terminal's Ctrl-C, a logout, `kill`): git first, then quit as usual, so
  // the windows still store their notes (A853). The CLI's `killGitOnSignals` does the same.
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(signal, () => {
      killLiveGit();
      app.quit();
    });
  }
}

if (mac) {
  void app.whenReady().then(() => {
    app.dock?.setMenu(
      Menu.buildFromTemplate([{ label: 'Quick Capture', click: () => showCapture() }]),
    );
  });
}

/** For the Playwright suite (main process only; pages cannot reach it). */
Object.assign(globalThis, {
  penmossDesktop: {
    showCapture,
    // The main window's first show (A904), for a test that orders it after a capture.
    showFirst: () => windows.main && showFirst(windows.main),
    hotkey: () => hotkey,
    captureWindow: () => captureWindow,
    mainWindow: () => windows.main,
    noteWindows: () => windows.notes(),
    activeWindow: () => windows.active,
    config,
    // T46, T47: the style each window opened with, and whether input is held while the
    // windows reopen (main process only).
    titleBarOf: (window: BrowserWindow) => titleBars.get(window) ?? null,
    holdingInput: () => holdingInput,
    // T51 (A945): the menu bar icon's menu (null while it is off), whether the Mac shows the
    // icon, and a click on one of its items by id, as the suite cannot open a menu bar menu.
    trayMenu: () => (trayTemplate ? describeMenu(trayTemplate) : null),
    trayShown: () => tray !== null,
    clickTrayItem: (id: string) => {
      const item = trayTemplate?.find((entry) => entry.id === id);
      if (!item?.click) return false;
      (item.click as () => void)();
      return true;
    },
    // T50: the git notebooks main keeps (no tokens: those are sealed in their own file).
    gitNotebooks: () => gitNotebooks.list(),
    // T76: the embedding service's process id (the suite kills it) and its status.
    meaningPid: () => meaning?.pid() ?? null,
    meaningStatus: () => meaning?.status() ?? null,
  },
});
