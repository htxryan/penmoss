import { useEffect, useId, useState } from 'react';
import { desktop, type CaptureHotkey } from './bridge';

/**
 * The Mac app's system-wide capture hotkey (T30, A226), under Settings →
 * Keyboard shortcuts. It belongs to this Mac (another may have it taken),
 * so it is not a synced setting; the main process checks and registers it.
 */
export function CaptureHotkeySetting() {
  const bridge = desktop();
  const id = useId();
  const [current, setCurrent] = useState<CaptureHotkey | null>(null);
  const [draft, setDraft] = useState('');
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    void bridge?.capture.hotkey().then((hotkey) => {
      setCurrent(hotkey);
      setDraft(hotkey.accelerator);
    });
  }, [bridge]);

  if (!bridge || !current) return null;
  const save = async () => {
    const result = await bridge.capture.setHotkey(draft);
    setCurrent(result);
    setDraft(result.accelerator);
    setMessage(result.error ?? `Quick capture now opens with ${result.accelerator}.`);
  };
  return (
    <form
      className="settings-field"
      data-testid="capture-hotkey"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <label htmlFor={id}>Quick capture from any app</label>
      <p className="muted settings-help">
        A system-wide shortcut for the capture window, such as <code>Control+Alt+Command+N</code>.
        Two modifiers or more, one of them Command or Control, and not one that copies, pastes,
        undoes or edits text.
        {current.registered
          ? current.certain
            ? null
            : ' If nothing happens when you press it, it may be in use by another app: choose another.'
          : ' Another app has this one, so it does nothing now.'}
      </p>
      <div className="settings-actions">
        <input
          id={id}
          className="input"
          value={draft}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => setDraft(event.target.value)}
        />
        <button type="submit" className="btn" data-ui="submit">
          Save
        </button>
      </div>
      {message ? <p role="status">{message}</p> : null}
    </form>
  );
}
