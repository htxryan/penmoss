import { useEffect, useId, useState } from 'react';
import { SettingRow, Switch } from '../theme/look-rows';
import { desktop } from './bridge';

/**
 * Settings → Quick Capture → Show in the Menu Bar (T51 item 17, A945; on Quick Capture since
 * PEN-146, where it was on Display): an icon in the Mac's menu bar whose menu holds Quick
 * Capture, Open Today's Journal and the Quick Access notes. On by default (T53 item 6). It is
 * this Mac's own choice (the desktop app's preferences), not a synced setting, and shows only in
 * the Mac app.
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
    <SettingRow
      setting="show-in-the-menu-bar"
      label="Show in the Menu Bar"
      labelFor={id}
      help="Quick Capture, Open Today’s Journal and your Quick Access notes, a click away from any app."
      helpId={`${id}-help`}
      testId="menu-bar-icon-setting"
    >
      <Switch
        id={id}
        checked={shown === true}
        disabled={busy || shown === null}
        aria-describedby={`${id}-help`}
        data-event="settings.menu-bar-icon"
        data-testid="menu-bar-icon"
        onChange={(event) => void change(event.target.checked)}
      />
    </SettingRow>
  );
}
