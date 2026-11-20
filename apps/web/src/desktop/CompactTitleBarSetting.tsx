import { useId, useState } from 'react';
import { SettingRow, Switch } from '../theme/look-rows';
import { desktop } from './bridge';

/**
 * Settings → Appearance → Window → Compact Title Bar (T47, D39, A724; a row since PEN-146): the traffic lights in the app's
 * own top row, or macOS's title bar. On by default. It is this Mac's own choice (the desktop
 * app's preferences), not a synced setting, and shows only in the Mac app. Electron cannot
 * restyle an open window, so the app asks first, then reopens its windows; Cancel leaves it.
 */
export function CompactTitleBarSetting() {
  const mac = desktop()?.macWindow;
  const id = useId();
  const [compact, setCompact] = useState(mac?.titleBar === 'compact');
  const [busy, setBusy] = useState(false);
  if (!mac) return null;
  const change = async (next: boolean) => {
    setBusy(true);
    setCompact(next);
    const answer = await mac.setCompactTitleBar(next).catch(() => null);
    // Cancelled (or refused): back as it was. Otherwise the window is about to reopen.
    if (!answer?.reopened) setCompact(answer?.compact ?? mac.titleBar === 'compact');
    setBusy(false);
  };
  return (
    <SettingRow
      setting="compact-title-bar"
      label="Compact Title Bar"
      labelFor={id}
      help="The window buttons sit in Penmoss’s own top row, which you drag to move the window. Changing it reopens the windows; your notes are saved first."
      testId="compact-title-bar-setting"
    >
      <Switch
        id={id}
        checked={compact}
        disabled={busy}
        data-event="settings.compact-title-bar"
        data-testid="compact-title-bar"
        onChange={(event) => void change(event.target.checked)}
      />
    </SettingRow>
  );
}
