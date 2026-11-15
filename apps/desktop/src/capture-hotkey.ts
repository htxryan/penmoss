/** The capture hotkey (T30, A226): registered for the whole system, kept in preferences. */
import { globalShortcut } from 'electron';
import { log, preferencesFile, state } from './app-state';
import {
  defaultCaptureHotkey,
  HotkeyChangeGate,
  normaliseHotkey,
  registrationCertain,
} from './hotkey';
import { savePreferences } from './preferences';
import { refreshTray } from './tray-control';
import { showCapture } from './windows/capture-window';

export interface HotkeyState {
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

/** Only Settings → Keyboard Shortcuts may change it, just after a key press or click. */
export const hotkeyGate = new HotkeyChangeGate();

/** The hotkey as it is now. */
export const currentHotkey = (): HotkeyState => hotkey;

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

export function setHotkey(input: string): HotkeyState & { error?: string } {
  const parsed = normaliseHotkey(input, process.platform);
  if ('error' in parsed) return { ...hotkey, error: parsed.error };
  if (parsed.accelerator === hotkey.accelerator && hotkey.registered) return hotkey;
  if (hotkey.registered) globalShortcut.unregister(hotkey.accelerator);
  if (!registerHotkey(parsed.accelerator)) {
    hotkey = { ...hotkey, registered: hotkey.registered && registerHotkey(hotkey.accelerator) };
    return { ...hotkey, error: `${parsed.accelerator} is taken by another app` };
  }
  hotkey = { accelerator: parsed.accelerator, registered: true, certain };
  state.preferences = { ...state.preferences, captureHotkey: parsed.accelerator };
  savePreferences(preferencesFile(), state.preferences);
  // Quick Capture in the menu bar icon's menu shows the new keys.
  refreshTray();
  return hotkey;
}

/** Registers this Mac's stored choice, or the default, as the app starts. */
export function startHotkey(): void {
  // A stored choice is checked again (the file is only this Mac's, but it is still input).
  const stored = normaliseHotkey(state.preferences.captureHotkey ?? '', process.platform);
  const wanted =
    'accelerator' in stored ? stored.accelerator : defaultCaptureHotkey(process.platform);
  hotkey = { accelerator: wanted, registered: registerHotkey(wanted), certain };
  if (!hotkey.registered) log(`the capture hotkey ${wanted} is taken by another app`);
}
