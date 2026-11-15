/** Main's events to the windows (ipc-contract.ts `Events`): to all, or all but one. */
import { BrowserWindow, type WebContents } from 'electron';
import { sendEvent, type EventValue } from './ipc';
import type { EventName } from './ipc-contract';

export function broadcast<K extends EventName>(name: K, ...value: EventValue<K>): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) sendEvent(window.webContents, name, ...value);
  }
}

/** Sends `name` to every window but `except` (the one whose news it is). */
export function notifyOthers<K extends EventName>(
  except: WebContents | null,
  name: K,
  ...value: EventValue<K>
): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed() && window.webContents !== except) {
      sendEvent(window.webContents, name, ...value);
    }
  }
}
