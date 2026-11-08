import { useEffect, useId, useState } from 'react';
import { desktop } from './bridge';

/**
 * Settings → Display → Show Penmoss in the Menu Bar (T51 item 17, A945): an icon in the Mac's
 * menu bar whose menu holds Quick Capture, Open Today's Journal and the Quick Access notes. On
 * by default (T53 item 6). It is this Mac's own choice (the desktop app's preferences), not a synced setting,
 * and shows only in the Mac app.
 */
export function MenuBarIconSetting() {
  const menuBar = desktop()?.menuBar;
  const id = useId();
  const [shown, setShown] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!menuBar) return;
    let live = true;
    void menuBar
      .shown()
      .catch(() => null)
      .then((value) => {
        if (live) setShown(value === true);
      });
    return () => {
      live = false;
    };
  }, [menuBar]);
  if (!menuBar) return null;
  const change = async (next: boolean) => {
    setBusy(true);
    setShown(next);
    const answer = await menuBar.setShown(next).catch(() => null);
    // Refused (no key press or click behind it) or failed: as the Mac has it.
    if (answer !== next) setShown(answer ?? !next);
    setBusy(false);
  };
  return (
    <fieldset className="display-toggles" data-testid="menu-bar-icon-setting">
      <legend>Menu bar</legend>
      <label className="display-toggle" htmlFor={id}>
        <input
          id={id}
          type="checkbox"
          checked={shown === true}
          disabled={busy || shown === null}
          aria-describedby={`${id}-help`}
          data-testid="menu-bar-icon"
          onChange={(event) => void change(event.target.checked)}
        />
        <span>Show Penmoss in the Menu Bar</span>
      </label>
      <p id={`${id}-help`} className="muted settings-help">
        An icon in the Mac’s menu bar with Quick Capture, Open Today’s Journal and your Quick Access
        notes, a click away from any app. This Mac only.
      </p>
    </fieldset>
  );
}
