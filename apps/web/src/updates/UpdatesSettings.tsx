/**
 * Settings → Updates (PEN-108, PEN-146): a card with this version, whether it is current, the
 * channel and the last check, and Check Now (or Install and Restart); then Update Automatically
 * and Update Channel as rows with their help; then What's New, the release notes (T64 item 2,
 * A1112, A1196). Also the notice a newer build brings, in the sidebar or as a toast (PEN-135; its
 * model is notice.ts). The Mac app only.
 */
import { Icon } from '@penmoss/ui/icons';
import { useEffect, useId, useState } from 'react';
import type { DesktopUpdateChannel } from '../desktop/bridge';
import { navigate } from '../router';
import { GroupHead, SettingRow, Switch } from '../theme/look-rows';
import { UPDATES_PATH, type UpdateNoticeModel } from './notice';
import { versionLabel } from './notes';
import { ReleaseNotes } from './ReleaseNotes';
import { checkedLine, updateChip, updateStatus, useUpdates } from './updates';
import { ActionToast } from '../toasts/ActionToast';
import { ToastSlot } from '../toasts/ToastSlot';
import { SettingsHeader } from '../pages/SettingsHeader';

const CHANNELS: ReadonlyArray<{ value: DesktopUpdateChannel; label: string }> = [
  { value: 'stable', label: 'Stable' },
  { value: 'alpha', label: 'Alpha' },
];

/** Now, again each minute, so "checked 5 minutes ago" keeps true while the page is open. */
function useMinute(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

export function UpdatesSettings() {
  const found = useUpdates();
  const id = useId();
  const now = useMinute();
  const [busy, setBusy] = useState(false);
  /** The switch as just clicked, until main answers. */
  const [wanted, setWanted] = useState<boolean | null>(null);
  /** The channel as just chosen, until main answers. */
  const [chosen, setChosen] = useState<DesktopUpdateChannel | null>(null);
  if (!found) return null;
  const { updates, state } = found;
  const offered = state?.phase === 'available' || state?.phase === 'ready';
  const working = state?.phase === 'checking' || state?.phase === 'downloading';
  const channel = chosen ?? state?.channel ?? 'stable';
  const chip = state ? updateChip(state) : null;
  const run = async (act: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await act().catch(() => null);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      className="settings-section"
      aria-labelledby={`${id}-h`}
      data-testid="updates-settings"
    >
      <SettingsHeader
        id={`${id}-h`}
        title="Updates"
        intro="The version you have, and how it updates."
      />
      <div className="updates-card" data-setting="version" data-testid="updates-version">
        <div className="updates-card-head">
          <strong className="updates-card-name">
            Penmoss{state?.current ? ` ${versionLabel(state.current)}` : ''}
          </strong>
          {chip ? (
            <span className="chip" data-phase={state?.phase} data-testid="updates-chip">
              {chip}
            </span>
          ) : null}
          <span className="updates-card-actions">
            {offered ? (
              <button
                type="button"
                className="btn primary"
                data-ui="submit"
                disabled={busy}
                onClick={() => void run(() => updates.install())}
                data-testid="updates-install"
              >
                <Icon name="arrowR" size={14} />
                Install and Restart
              </button>
            ) : null}
            <button
              type="button"
              className="btn"
              disabled={busy || working || !state?.supported}
              data-ui="submit"
              onClick={() => void run(() => updates.check())}
              data-testid="updates-check"
            >
              <Icon name="refresh" size={14} />
              Check Now
            </button>
          </span>
        </div>
        {state ? (
          <p className="muted updates-card-line" data-testid="updates-checked">
            {checkedLine(state, now)}
          </p>
        ) : null}
        {state ? (
          <p
            role="status"
            className="updates-status"
            data-testid="updates-status"
            data-phase={state.phase}
          >
            {updateStatus(state)}
          </p>
        ) : null}
        {state && !state.supported ? (
          <p className="muted updates-card-line" data-testid="updates-unsupported">
            This build is not signed, so it cannot update itself: install new builds by hand.
          </p>
        ) : null}
      </div>
      <div className="lf-group">
        <SettingRow
          setting="update-automatically"
          label="Update Automatically"
          labelFor={`${id}-auto`}
          help="Checks at launch and every hour, and tells you when there is a new build. Nothing downloads until you choose Install and Restart."
          helpId={`${id}-help`}
        >
          <Switch
            id={`${id}-auto`}
            checked={wanted ?? state?.auto === true}
            disabled={busy || !state?.supported}
            aria-describedby={`${id}-help`}
            data-testid="updates-auto"
            onChange={(event) => {
              const next = event.target.checked;
              setWanted(next);
              void run(() => updates.setAuto(next)).finally(() => setWanted(null));
            }}
          />
        </SettingRow>
        <SettingRow
          setting="update-channel"
          label="Update Channel"
          labelId={`${id}-channel-label`}
          help="Alpha gets every build from main: newest features, may break."
          helpId={`${id}-alpha`}
          testId="updates-channel-setting"
        >
          <fieldset
            className="seg-field"
            disabled={busy || working || state?.phase === 'ready' || !state?.supported}
            aria-labelledby={`${id}-channel-label`}
          >
            <div className="seg" data-testid="updates-channel">
              {CHANNELS.map((item) => (
                <label key={item.value} className="seg-option">
                  <input
                    type="radio"
                    name={`${id}-channel`}
                    value={item.value}
                    checked={channel === item.value}
                    aria-describedby={item.value === 'alpha' ? `${id}-alpha` : undefined}
                    onChange={() => {
                      setChosen(item.value);
                      void run(() => updates.setChannel(item.value)).finally(() => setChosen(null));
                    }}
                  />
                  <span className="bold-steady" data-label={item.label}>
                    {item.label}
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        </SettingRow>
      </div>
      {state ? (
        <div data-setting="whats-new" className="updates-whats-new">
          <GroupHead>What’s New</GroupHead>
          <ReleaseNotes
            current={state.current}
            offered={offered || state.phase === 'downloading' ? state.version : null}
          />
        </div>
      ) : null}
    </section>
  );
}

/**
 * The notice as a toast at the window's foot (A1305, A1306): only where the sidebar is a drawer
 * (a narrow window); elsewhere it is in the sidebar's bottom panel (PEN-135 item 10).
 */
export function UpdateNotice({ notice: shown }: { readonly notice: UpdateNoticeModel | null }) {
  return (
    <ToastSlot>
      {shown?.kind === 'offered' ? (
        <ActionToast
          tone="info"
          testId="update-notice"
          icon={<Icon name="refresh" />}
          actions={
            shown.dismiss ? (
              <button
                type="button"
                className="btn primary"
                data-ui="submit"
                onClick={shown.install}
                data-testid="update-install"
              >
                Install and Restart
              </button>
            ) : null
          }
          onDismiss={shown.dismiss ?? undefined}
        >
          {shown.text}
        </ActionToast>
      ) : shown?.kind === 'updated' ? (
        <ActionToast
          tone="info"
          testId="updated-notice"
          icon={<Icon name="refresh" />}
          actions={
            <button
              type="button"
              className="btn primary"
              data-ui="submit"
              onClick={shown.whatsNew}
              data-testid="updated-whats-new"
            >
              What's New
            </button>
          }
          onDismiss={shown.dismiss}
          dismissTestId="updated-dismiss"
        >
          Updated to {shown.version}.
        </ActionToast>
      ) : null}
    </ToastSlot>
  );
}

/**
 * The notice in the sidebar's bottom panel, above Settings and Feedback (PEN-135 item 10): one
 * compact line with its icon, what it says, its button (What's New, or Install and Restart) and
 * ✕. On the rail it is one icon button with a dot: after an update it opens What's New, as the
 * line's button does; a build on offer opens Settings → Updates, which has Install and Restart and
 * the download's progress. Its name and tooltip say which.
 */
export function SidebarUpdateNotice({
  notice,
  rail,
}: {
  readonly notice: UpdateNoticeModel | null;
  readonly rail: boolean;
}) {
  if (!notice) return null;
  if (rail) {
    const label =
      notice.kind === 'updated'
        ? `Updated to ${notice.version}: What's New`
        : `${notice.text.replace(/\.$/, '')}: Settings → Updates`;
    return (
      <button
        type="button"
        className="icon-btn sb-update-dot"
        data-ui="submit"
        aria-label={label}
        data-tip={label}
        data-kind={notice.kind}
        data-testid={notice.kind === 'updated' ? 'updated-notice' : 'update-notice'}
        onClick={notice.kind === 'updated' ? notice.whatsNew : () => navigate(UPDATES_PATH)}
      >
        <Icon name="refresh" size={18} />
        <span className="sb-update-badge" aria-hidden="true" />
      </button>
    );
  }
  return notice.kind === 'updated' ? (
    <div className="sb-update" data-kind="updated" data-testid="updated-notice">
      <Icon name="refresh" size={14} />
      <span className="sb-update-text">Updated to {notice.version}.</span>
      <button
        type="button"
        className="sb-update-action"
        data-ui="submit"
        onClick={notice.whatsNew}
        data-testid="updated-whats-new"
      >
        What's New
      </button>
      <button
        type="button"
        className="icon-btn sb-update-close"
        data-ui="dismiss"
        aria-label="Dismiss"
        data-tip="Dismiss"
        onClick={notice.dismiss}
        data-testid="updated-dismiss"
      >
        <Icon name="close" size={14} />
      </button>
    </div>
  ) : (
    <div
      className="sb-update"
      data-kind="offered"
      data-phase={notice.phase}
      data-testid="update-notice"
    >
      <Icon name="refresh" size={14} />
      <span className="sb-update-text">{notice.text}</span>
      {notice.dismiss ? (
        <>
          <button
            type="button"
            className="sb-update-action"
            data-ui="submit"
            onClick={notice.install}
            data-testid="update-install"
          >
            Install and Restart
          </button>
          <button
            type="button"
            className="icon-btn sb-update-close"
            data-ui="dismiss"
            aria-label="Dismiss"
            data-tip="Dismiss"
            onClick={notice.dismiss}
          >
            <Icon name="close" size={14} />
          </button>
        </>
      ) : null}
    </div>
  );
}
