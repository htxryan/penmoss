/**
 * Penmoss for Mac (T29, T30): the main process, as it starts and quits.
 *
 * One main window runs the bundled web app from `app://penmoss/`, so notes
 * open with no network (the web app's IndexedDB replica, A20), beside any
 * note windows (T45, A712: windows/); a hidden capture window waits for the
 * global hotkey (T30). Notes live in git notebooks, which the main process
 * syncs with this Mac's own git (T50, A853; services.ts); there is no Penmoss
 * server (D48, D49). It builds the menus the page describes from its command
 * registry (app-menu.ts), writes multi-format clipboard entries, and turns
 * `penmoss://` links into in-app paths. Main and note windows can be kept on
 * top and have the compact title bar on a Mac (T46, T47: mac-window-control.ts),
 * and the menu bar icon lists the Quick Access notes (T51: tray-control.ts). The
 * page reaches all of it through the IPC contract (ipc-contract.ts, ipc/).
 * Decisions: docs/decisions.md A220–A229, A710–A712, A720–A725, A945, A1051, A1479.
 */
// First: the scheme, the sandbox and the user-data folder are set as it loads.
import {
  config,
  dataFile,
  log,
  logAt,
  logFile,
  mac,
  macWindows,
  preferencesFile,
  state,
  themeWriter,
  titleBars,
  windows,
} from './app-state';
import {
  app,
  autoUpdater,
  globalShortcut,
  ipcMain,
  Menu,
  nativeTheme,
  protocol,
  session,
  type BrowserWindow,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from 'electron';
import { killLiveGit, watchGitProcesses } from '@penmoss/git-notebook/system-git';
import { countBucket, durationBucket } from '@penmoss/core/analytics';
import { setMenus } from './app-menu';
import { killBoundedGroups } from './bounded-exec';
import { currentHotkey, startHotkey } from './capture-hotkey';
import { APP_SCHEME, DEEP_LINK_SCHEME } from './config';
import { deepLinkFromArgv, parseDeepLink } from './deep-link';
import { harden } from './harden';
import { writeLaunchLog } from './launch-log';
import { loadPreferences } from './preferences';
import { IpcHandlers } from './ipc';
import { registerAgentsIpc } from './ipc/agents';
import { registerAnalyticsIpc } from './ipc/analytics';
import { registerFeedbackIpc } from './ipc/feedback';
import { registerGitIpc } from './ipc/git';
import { registerGitHubIpc } from './ipc/github';
import { registerMeaningIpc } from './ipc/meaning';
import { registerUpdatesIpc } from './ipc/updates';
import { registerWindowIpc } from './ipc/window';
import { serveAsset } from './protocol';
import { ALLOWED_PERMISSIONS, downloadDialog, isAppFrame, isAppWindowFrame } from './security';
import {
  analytics,
  consentWatcher,
  gitNotebooks,
  gitProcesses,
  localAgents,
  loginPath,
  meaning,
  startAnalytics,
  updates,
} from './services';
import { describeMenu } from './tray';
import { refreshTray, trayMenu, trayShown } from './tray-control';
import {
  captureWindow,
  ensureCaptureWindow,
  showCapture,
  showFirst,
} from './windows/capture-window';
import { createMainWindow, openInMain } from './windows/main-window';
import { applyBackground, applyMode, startQuitting } from './windows/window-common';

// --- IPC: only from the app's own pages ---

const fromApp = (event: IpcMainEvent | IpcMainInvokeEvent): boolean => isAppFrame(event);
/** From a main or note window's page, never the capture window's (A503, A712). */
const fromAppWindow = (event: IpcMainEvent | IpcMainInvokeEvent): boolean =>
  isAppWindowFrame(event, (contents) => windows.kindOf(contents));
/** From the main window's page alone: Settings (T54). */
const fromMainWindow = (event: IpcMainEvent | IpcMainInvokeEvent): boolean =>
  fromAppWindow(event) && windows.kindOf(event.sender) === 'main';
/** A main or note window with keep on top and the compact title bar (T46, T47; A720–A724). */
const macWindowOf = (event: IpcMainEvent | IpcMainInvokeEvent) =>
  macWindows && fromAppWindow(event) ? windows.windowOf(event.sender) : null;

function registerIpc(): void {
  // Who may call what, and which calls need a key press or click: ipc-contract.ts.
  const ipc = new IpcHandlers(ipcMain, (from, event) => {
    switch (from) {
      case 'app':
        return fromApp(event);
      case 'window':
        return fromAppWindow(event);
      case 'main':
        return fromMainWindow(event);
      case 'mac':
        return macWindowOf(event) !== null;
    }
  });
  registerWindowIpc(ipc, macWindowOf);
  registerGitIpc(ipc, fromMainWindow);
  registerGitHubIpc(ipc);
  registerAgentsIpc(ipc);
  registerMeaningIpc(ipc);
  registerUpdatesIpc(ipc);
  registerFeedbackIpc(ipc);
  registerAnalyticsIpc(ipc);
}

// --- the log file and usage analytics (PEN-137) ---

// What would take the main process down, and the pages and helpers that end, reach the log file.
// A monitor only: Electron's own handling of an uncaught exception is unchanged.
process.on('uncaughtExceptionMonitor', (error, origin) => {
  logAt(
    'error',
    `${origin}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
  );
});
app.on('render-process-gone', (_event, _contents, details) => {
  logAt('error', `a page ended: ${details.reason} (${details.exitCode})`);
});
app.on('child-process-gone', (_event, details) => {
  logAt('warn', `${details.type} ended: ${details.reason} (${details.exitCode})`);
});

/** Since when the app has been in front (for `background`'s duration). */
let activeSince: number | null = null;
app.on('did-become-active', () => {
  activeSince = Date.now();
  analytics.record('app', 'foreground');
});
app.on('did-resign-active', () => {
  const active = activeSince === null ? 0 : Date.now() - activeSince;
  activeSince = null;
  analytics.record('app', 'background', { active: durationBucket(active) });
  analytics.background();
});

/** Records the launch once the notebooks are counted (a count's bucket only, never a name). */
function recordLaunch(): void {
  void gitNotebooks
    .list()
    .then((list) => list.length)
    .catch(() => 0)
    .then((notebooks) => analytics.record('app', 'launch', { notebooks: countBucket(notebooks) }));
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
    // A download (the drawing editor's Save To… and Export Image…) asks where to save it (R2-19):
    // Electron shows the save dialog itself when no path is set, with these options.
    session.defaultSession.on('will-download', (_event, item) => {
      item.setSaveDialogOptions(downloadDialog(item.getFilename(), app.getPath('downloads')));
    });
    // What a crashed run left running is killed first; every git from here on is recorded (A853).
    gitProcesses.cleanUp();
    // Every agent on this Mac reaches every notebook in the app (D52), after the launch settles.
    setTimeout(() => void localAgents.ensureAll(), 3_000).unref();
    // The app's `penmoss` script, written before the CLI bundle, runs it from now on (PEN-121).
    void localAgents.refreshCli();
    watchGitProcesses(gitProcesses);
    registerIpc();
    // Usage analytics (PEN-137): the record's worker, the send timer and the consent watcher.
    log(`Penmoss ${app.getVersion()} starting`);
    startAnalytics();
    recordLaunch();
    setMenus([]);

    const parsed = pendingLink ? parseDeepLink(pendingLink) : null;
    pendingLink = null;
    // Read before the first window, which opens in the remembered theme's background.
    state.preferences = loadPreferences(preferencesFile());
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

    startHotkey();
    // The menu bar icon, when this Mac's preference shows it (A945); its notes come from the page.
    refreshTray();
    // The capture window loads once the main window is up, so it costs launch nothing.
    windows.main?.webContents.once('did-finish-load', () => {
      ensureCaptureWindow();
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
    // Quitting, the windows are going (A1577): none comes back or is made.
    if (state.quitting) return;
    const minimized = hasVisibleWindows ? null : windows.lastMinimized();
    if (minimized) {
      minimized.restore();
      minimized.focus();
      return;
    }
    if (!windows.main) createMainWindow();
  });
  app.on('before-quit', () => {
    // `quit`, and what waits is sent (not waited for) while the windows store.
    analytics.quitting();
    state.quitting = true;
    // Every window off the screen at once, storing side by side (A1577).
    startQuitting();
  });
  // Install and Restart (PEN-120, A1337): Electron's quitAndInstall closes every window before
  // `before-quit`, so the quit starts here, or the capture window would only hide, the app would
  // never quit, and ShipIt would wait for an exit that never comes. Each window stores its last
  // keystrokes and closes; once none is left, the updater quits into the update.
  autoUpdater.on('before-quit-for-update', () => {
    state.quitting = true;
    state.updating = true;
    startQuitting();
  });
  // The usage record and the log file are written and closed before the app ends (PEN-137): the
  // quit waits for them once, at most 1.5 s. Not when quitting into an update, which ShipIt
  // waits on.
  let recordsClosed = false;
  app.on('will-quit', (event) => {
    if (!recordsClosed && !state.updating) {
      event.preventDefault();
      recordsClosed = true;
      consentWatcher.close();
      void Promise.all([analytics.close(1500), logFile.close()])
        .catch(() => undefined)
        .finally(() => app.quit());
      return;
    }
    // No git outlives the app (A853): a sync still running is stopped, the notebook keeps it.
    killLiveGit();
    // Nor does any other program main started and is waiting for (A1480).
    killBoundedGroups();
    meaning?.stop();
    themeWriter.flush();
    // What pages kept in local storage as they went (A626) reaches the disk before the app ends.
    session.defaultSession.flushStorageData();
    globalShortcut.unregisterAll();
  });
  app.on('window-all-closed', () => {
    if (!mac && !state.reopening) app.quit();
  });
  // Ended by a signal (a terminal's Ctrl-C, a logout, `kill`): git first, then quit as usual, so
  // the windows still store their notes (A853). The CLI's `killGitOnSignals` does the same.
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(signal, () => {
      killLiveGit();
      killBoundedGroups();
      app.quit();
    });
  }
}

if (mac) {
  void app.whenReady().then(() => {
    app.dock?.setMenu(
      Menu.buildFromTemplate([
        {
          label: 'Quick Capture',
          click: () => {
            analytics.record('menu', 'dock.capture', { source: 'context' });
            showCapture();
          },
        },
      ]),
    );
  });
}

// For the Playwright suite (main process only; pages cannot reach it). A packaged app has none.
if (!app.isPackaged) {
  Object.assign(globalThis, {
    penmossDesktop: {
      showCapture,
      // The main window's first show (A904), for a test that orders it after a capture.
      showFirst: () => windows.main && showFirst(windows.main),
      hotkey: currentHotkey,
      captureWindow,
      mainWindow: () => windows.main,
      noteWindows: () => windows.notes(),
      activeWindow: () => windows.active,
      config,
      // T46, T47: the style each window opened with, and whether input is held while the
      // windows reopen (main process only).
      titleBarOf: (window: BrowserWindow) => titleBars.get(window) ?? null,
      holdingInput: () => state.holdingInput,
      // T51 (A945): the menu bar icon's menu (null while it is off), whether the Mac shows the
      // icon, and a click on one of its items by id, as the suite cannot open a menu bar menu.
      trayMenu: () => {
        const template = trayMenu();
        return template ? describeMenu(template) : null;
      },
      trayShown,
      clickTrayItem: (id: string) => {
        const item = trayMenu()?.find((entry) => entry.id === id);
        if (!item?.click) return false;
        (item.click as () => void)();
        return true;
      },
      // T50: the git notebooks main keeps (no tokens: those are sealed in their own file).
      gitNotebooks: () => gitNotebooks.list(),
      // T76: the embedding service's process id (the suite kills it) and its status.
      meaningPid: () => meaning?.pid() ?? null,
      meaningStatus: () => meaning?.status() ?? null,
      // PEN-137: send what waits now (not in a minute), and where the log file is.
      analyticsSend: () => analytics.sendNow(),
      logFile: () => logFile.path,
    },
  });
}
