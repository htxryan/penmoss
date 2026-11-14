/**
 * Settings → Updates (the switch, the channel, Check Now and Install and Restart, then the release
 * notes, PEN-108) and the notice a newer build brings (T64 item 2, A1112, A1196), in the sidebar or
 * as a toast (PEN-135; its model is notice.ts). The Mac app only.
 */
import { Icon } from '@penmoss/ui/icons';
import { useId, useState } from 'react';
import type { DesktopUpdateChannel } from '../desktop/bridge';
import { navigate } from '../router';
import { UPDATES_PATH, type UpdateNoticeModel } from './notice';
import { ReleaseNotes } from './ReleaseNotes';
import { nameOf, updateStatus, useUpdates } from './updates';
import { ToastSlot } from '../toasts/ToastSlot';

const CHANNELS: ReadonlyArray<{ value: DesktopUpdateChannel; label: string }> = [
  { value: 'stable', label: 'Stable' },
  { value: 'alpha', label: 'Alpha' },
];

export function UpdatesSettings() {
  const found = useUpdates();
  const id = useId();
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
      <h2 id={`${id}-h`}>Updates</h2>
      <p className="muted">
        {state?.current ? `This is ${nameOf(state.current)}. ` : null}
        New builds come from GitHub Releases.
      </p>
      {state && !state.supported ? (
        <p className="muted" data-testid="updates-unsupported">
          This build is not signed, so it cannot update itself: install new builds by hand.
        </p>
      ) : null}
      <fieldset className="display-toggles">
        <legend className="sr-only">Auto-Update</legend>
        <label className="display-toggle" htmlFor={`${id}-auto`}>
          <input
            id={`${id}-auto`}
            type="checkbox"
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
          <span>Auto-Update</span>
        </label>
        <p id={`${id}-help`} className="muted settings-help">
          Checks for a new build when Penmoss starts and every hour, and tells you when there is
          one. Nothing downloads until you choose Install and Restart. This Mac only.
        </p>
      </fieldset>
      <fieldset
        className="appearance-group"
        disabled={busy || working || state?.phase === 'ready' || !state?.supported}
        data-testid="updates-channel-setting"
      >
        <legend>Update Channel</legend>
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
        <p id={`${id}-alpha`} className="muted appearance-note">
          Alpha: Every build from main. Newest features, may break.
        </p>
      </fieldset>
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
      <div className="row">
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
      </div>
      {state ? (
        <ReleaseNotes
          current={state.current}
          offered={offered || state.phase === 'downloading' ? state.version : null}
        />
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
        <div className="toast toast-with-action" data-tone="info" data-testid="update-notice">
          <Icon name="refresh" />
          <span>{shown.text}</span>
          {shown.dismiss ? (
            <>
              <button
                type="button"
                className="btn primary"
                data-ui="submit"
                onClick={shown.install}
                data-testid="update-install"
              >
                Install and Restart
              </button>
              <button
                type="button"
                className="toast-close"
                data-ui="dismiss"
                aria-label="Dismiss"
                onClick={shown.dismiss}
              >
                <Icon name="close" size={14} />
              </button>
            </>
          ) : null}
        </div>
      ) : shown?.kind === 'updated' ? (
        <div className="toast toast-with-action" data-tone="info" data-testid="updated-notice">
          <Icon name="refresh" />
          <span>Updated to {shown.version}.</span>
          <button
            type="button"
            className="btn primary"
            data-ui="submit"
            onClick={shown.whatsNew}
            data-testid="updated-whats-new"
          >
            What's New
          </button>
          <button
            type="button"
            className="toast-close"
            data-ui="dismiss"
            aria-label="Dismiss"
            onClick={shown.dismiss}
            data-testid="updated-dismiss"
          >
            <Icon name="close" size={14} />
          </button>
        </div>
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
