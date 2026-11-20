import { formatCombo } from '@penmoss/editor/keys';
import { useEffect, useId, useState } from 'react';
import { Kbd } from '../commands/Kbd';
import { useKeyRecorder } from '../commands/recorder';
import { SettingRow } from '../theme/look-rows';
import { desktop, type CaptureHotkey } from './bridge';
import { acceleratorToCombo, comboToAccelerator } from './hotkey-keys';

/**
 * Settings → Quick Capture → Shortcut from Any App (T30, A226; PEN-146): the Mac app's
 * system-wide capture hotkey, recorded by pressing the keys like every other shortcut in
 * Settings (`useKeyRecorder`), where it was a typed field. It belongs to this Mac (another may
 * have the keys taken), so it is not a synced setting; the main process checks it (two
 * modifiers, one of them ⌘ or ⌃, and A90's rules), registers it, and says why when it refuses.
 */
export function CaptureHotkeySetting() {
  const bridge = desktop();
  const id = useId();
  const [current, setCurrent] = useState<CaptureHotkey | null>(null);
  const [recording, setRecording] = useState(false);
  const [message, setMessage] = useState<{ readonly text: string; readonly error: boolean } | null>(
    null,
  );

  useEffect(() => {
    void bridge?.capture.hotkey().then((hotkey) => {
      if (hotkey) setCurrent(hotkey);
    });
  }, [bridge]);

  const save = async (accelerator: string) => {
    if (!bridge || !current) return;
    const result = await bridge.capture.setHotkey(accelerator);
    const shown = (hotkey: CaptureHotkey) => formatCombo(acceleratorToCombo(hotkey.accelerator));
    // Refused outright (a shortcut too long to be one): the old one stays, and the row says so.
    if (!result) {
      setMessage({
        text: `That shortcut wasn’t saved: Quick Capture still opens with ${shown(current)}.`,
        error: true,
      });
      return;
    }
    setCurrent(result);
    setMessage(
      result.error
        ? { text: result.error, error: true }
        : { text: `Quick Capture now opens with ${shown(result)}.`, error: false },
    );
  };

  useKeyRecorder(recording, (combo) => {
    setRecording(false);
    if (combo === 'Escape') return;
    void save(comboToAccelerator(combo));
  });

  if (!bridge || !current) return null;
  const unset = !current.accelerator;
  const help = unset
    ? ' None is set.'
    : current.registered
      ? current.certain
        ? null
        : ' If nothing happens when you press it, another app may have it: choose another.'
      : ' Another app has this one, so it does nothing now.';
  return (
    <SettingRow
      setting="shortcut-from-any-app"
      label="Shortcut from Any App"
      labelId={`${id}-label`}
      help={`Opens Quick Capture over any app. Press Change, then the keys: ⌘ or ⌃ and one more modifier.${help ?? ''}`}
      helpId={`${id}-help`}
      testId="capture-hotkey"
      data-accelerator={current.accelerator}
      extra={
        message ? (
          <p className="lf-row-note" role={message.error ? 'alert' : 'status'}>
            {message.text}
          </p>
        ) : null
      }
    >
      {recording ? (
        <span className="chip" role="status">
          Press Keys… Esc Cancels
        </span>
      ) : (
        <span data-testid="capture-hotkey-keys">
          {unset ? (
            <span className="lf-none">None</span>
          ) : (
            <Kbd combo={acceleratorToCombo(current.accelerator)} />
          )}
        </span>
      )}
      <button
        data-event={
          recording
            ? 'settings.quick-capture.hotkey.cancel'
            : 'settings.quick-capture.hotkey.change'
        }
        type="button"
        className="btn quiet"
        data-ui="item"
        aria-describedby={`${id}-label`}
        onClick={() => {
          setMessage(null);
          setRecording((value) => !value);
        }}
      >
        {recording ? 'Cancel' : 'Change'}
      </button>
    </SettingRow>
  );
}
