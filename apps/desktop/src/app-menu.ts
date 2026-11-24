/** The app's menus (T29, A712): built from the page's own description, sent to the window in front. */
import { app, Menu } from 'electron';
import { config, state, windows } from './app-state';
import { sendEvent } from './ipc';
import { menuTemplate, type MenuModel } from './menu';
import { ClipboardGate } from './security';
import { analytics } from './services';
import { openInMain } from './windows/main-window';

/** The clipboard is written only just after a key press or click, or a menu command (A224). */
export const clipboardGate = new ClipboardGate();

function sendMenuCommand(id: string, accelerator: string | null): void {
  // Not while the windows store and reopen for a new title bar (A724).
  if (state.holdingInput) return;
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
  const send = () => sendEvent(window.webContents, 'menuCommand', { id, accelerator });
  if (window.webContents.isLoading()) window.webContents.once('did-finish-load', send);
  else send();
}

export function setMenus(menus: readonly MenuModel[]): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      menuTemplate(menus, {
        platform: process.platform,
        appName: app.name,
        devTools: config.devTools,
        // A command's click is recorded by the page, which runs it (source `menu`): not here too.
        onCommand: sendMenuCommand,
        onShowMain: () => {
          analytics.record('menu', 'window.main', { source: 'menubar' });
          openInMain(null);
        },
      }),
    ),
  );
}
