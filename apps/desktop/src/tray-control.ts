/**
 * The menu bar icon (T51 item 17, A945): shown while this Mac's preference says so, with the
 * Quick Access notes the main window's page sent (A946).
 */
import { join } from 'node:path';
import { Menu, nativeImage, Tray, type MenuItemConstructorOptions } from 'electron';
import { log, mac, macWindows, preferencesFile, state } from './app-state';
import { currentHotkey } from './capture-hotkey';
import { savePreferences } from './preferences';
import { pinPath, TRAY_ICON, TRAY_TOOLTIP, trayMenuTemplate, type QuickAccessPin } from './tray';
import { analytics } from './services';
import { recordSetting } from './setting-events';
import { deliverToMain, openInMain } from './windows/main-window';
import { showCapture } from './windows/capture-window';

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
  if (state.holdingInput) return;
  deliverToMain(openInMain(null), { kind: 'command', id });
}

/** The icon's menu as it should be now; null while the preference is off. */
function wantedTrayTemplate(): MenuItemConstructorOptions[] | null {
  if (!macWindows || state.preferences.menuBarIcon === false) return null;
  const hotkey = currentHotkey();
  // Each item is recorded by its catalogue name (PEN-137), never a note's id or title.
  const chosen = (name: string) => analytics.record('menu', name, { source: 'tray' });
  return trayMenuTemplate(quickAccessPins, hotkey.registered ? hotkey.accelerator : null, {
    capture: () => {
      chosen('tray.capture');
      showCapture();
    },
    today: () => {
      chosen('tray.today');
      runInMain('journal.today');
    },
    openNote: (id) => {
      chosen('tray.quickAccess');
      if (!state.holdingInput) openInMain(pinPath(id));
    },
    showMain: () => {
      chosen('tray.open');
      openInMain(null);
    },
  });
}

/**
 * Shows, rebuilds or removes the menu bar icon to match the preference and the pins. The icon
 * is a template image (`dist/tray/trayTemplate.png` and `@2x`), so macOS draws it to suit a
 * light or dark menu bar. Off a Mac (the suite under xvfb) only the menu is kept, not an icon.
 */
export function refreshTray(): void {
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

/** Settings → Quick Capture → Show in the Menu Bar (A945): saved for this Mac, then applied. */
export function setMenuBarIcon(shown: boolean): boolean {
  const current = state.preferences.menuBarIcon !== false;
  if (current !== shown) {
    const next = { ...state.preferences, menuBarIcon: shown };
    try {
      savePreferences(preferencesFile(), next);
    } catch (error) {
      log(`could not save the menu bar icon setting: ${String(error)}`);
      return current;
    }
    state.preferences = next;
    // Recorded once it is saved (PEN-175); a save that failed records nothing.
    recordSetting('menuBar.icon', shown);
  }
  refreshTray();
  return state.preferences.menuBarIcon !== false;
}

/** The Quick Access notes the main window's page sent (A946): the menu lists them. */
export function setQuickAccess(pins: readonly QuickAccessPin[]): void {
  quickAccessPins = pins;
  refreshTray();
}

/** For the Playwright suite: the menu (null while it is off), and whether the icon shows. */
export const trayMenu = (): MenuItemConstructorOptions[] | null => trayTemplate;
export const trayShown = (): boolean => tray !== null;
