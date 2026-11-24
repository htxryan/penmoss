/** The capture hotkey (T30, A226): registered for the whole system, kept in preferences. */
import { globalShortcut } from 'electron';
import { KEYS_PATTERN } from '@penmoss/core/analytics';
import { log, preferencesFile, state } from './app-state';
import {
  defaultCaptureHotkey,
  HotkeyChangeGate,
  hotkeyCombo,
  normaliseHotkey,
  registrationCertain,
} from './hotkey';
import { savePreferences } from './preferences';
import { analytics } from './services';
import { recordSetting } from './setting-events';
import { refreshTray } from './tray-control';
import { showCapture } from './windows/capture-window';

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

/** Only Settings → Quick Capture may change it, just after a key press or click. */
export const hotkeyGate = new HotkeyChangeGate();

/** The hotkey as it is now. */
export const currentHotkey = (): HotkeyState => hotkey;

/**
 * The hotkey was pressed (PEN-137): recorded as the command it runs, Quick Capture, from the
 * hotkey, with its normalised keys and whether they are this Mac's own choice (O8).
 */
function captureFromHotkey(accelerator: string): void {
  const keys = hotkeyCombo(accelerator, process.platform);
  analytics.record('command', 'app.capture', {
    source: 'hotkey',
    ...(keys && KEYS_PATTERN.test(keys) ? { keys } : {}),
    custom: accelerator !== defaultCaptureHotkey(process.platform),
  });
  showCapture();
}

/** Registers the hotkey, and checks it took where the system can say so. */
function registerHotkey(accelerator: string): boolean {
  try {
    return (
      globalShortcut.register(accelerator, () => captureFromHotkey(accelerator)) &&
      globalShortcut.isRegistered(accelerator)
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
  // Once saved (PEN-175): only that the keys changed (`changed: true`), never which keys.
  recordSetting('capture.hotkey', null);
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
