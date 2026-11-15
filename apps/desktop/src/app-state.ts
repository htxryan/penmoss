/**
 * What every part of the main process shares (T29): the app's setup before it is ready, its
 * configuration, the window registry and the few flags that change how windows close and
 * reopen. main.ts imports this first, so the scheme, the sandbox and the user-data folder are
 * set before anything else runs.
 */
import { join } from 'node:path';
import { app, protocol, type BrowserWindow } from 'electron';
import { APP_SCHEME, desktopConfig } from './config';
import { savePreferences, type Preferences } from './preferences';
import { macWindowsOn, type TitleBarStyle } from './mac-window';
import { MainInbox } from './main-inbox';
import type { MenuModel } from './menu';
import { StoreRequests } from './store-requests';
import { debouncedWriter } from './theme';
import { WindowRegistry } from './windows';

protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    // A standard, secure origin: IndexedDB, localStorage, fetch and the clipboard work as on https.
    privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true },
  },
]);
app.enableSandbox();
app.setName('Penmoss');

export const mac = process.platform === 'darwin';
export const started = Date.now();

export const config = desktopConfig({
  env: process.env,
  packaged: app.isPackaged,
  appPath: app.getAppPath(),
  resourcesPath: process.resourcesPath,
});
if (config.userData) app.setPath('userData', config.userData);

export const dataFile = (name: string) => join(app.getPath('userData'), name);
export const log = (message: string) => console.log(`[penmoss] ${message}`);

/** The main and note windows (T45, A712): the only way to find one. */
export const windows = new WindowRegistry<BrowserWindow>();

/** Keep on top and the compact title bar: on a Mac, or the suite standing in for one (A725). */
export const macWindows = macWindowsOn(process.platform, config.testMacWindow);
/** The title-bar style each main and note window opened with (A722, A724). */
export const titleBars = new WeakMap<BrowserWindow, TitleBarStyle | null>();
/** Whether each main and note window is in full screen, from its own events. */
export const fullScreens = new WeakMap<BrowserWindow, boolean>();

/**
 * What main sends the main window's page from outside it, held until that page listens (T51,
 * A945): see main-inbox.ts. Its page asks for what is held (`menuCommandPending`) once it does.
 */
export const mainInbox = new MainInbox();
/** Each ask for a window to store has its own id (#174 review): store-requests.ts. */
export const storeRequests = new StoreRequests();

export const preferencesFile = () => dataFile('preferences.json');

/** The app's flags and this Mac's preferences, changed as it runs. */
export const state = {
  /** This Mac's preferences (preferences.ts), read before the first window. */
  preferences: {} as Preferences,
  /** The main window's menus as it last sent them: the menu bar's once no window is in front. */
  mainMenus: null as readonly MenuModel[] | null,
  quitting: false,
  /**
   * Install and Restart asked to quit (PEN-120): the windows close once stored, and Electron's
   * updater then quits and hands over to ShipIt itself.
   */
  updating: false,
  /** The windows are being stored, closed and opened again for a new title-bar style (A724). */
  reopening: false,
  /** Input is held while they are (A724); for the suite. */
  holdingInput: false,
  /** Writes the main window's state now (its pin, A721), once it has a window. */
  saveMainState: null as (() => void) | null,
};

/** The chosen theme is kept for the next launch once changes pause (T28). */
export const themeWriter = debouncedWriter(
  () => savePreferences(preferencesFile(), state.preferences),
  500,
);
