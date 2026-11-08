/**
 * Settings → Updates (the switch, the channel, Check Now and Install and Restart) and the notice a
 * newer build brings (T64 item 2, A1112, A1196). The Mac app only.
 */
import { Icon } from '@penmoss/ui/icons';
import { useId, useState } from 'react';
import type { DesktopUpdateChannel } from '../desktop/bridge';
import { nameOf, updateStatus, useUpdates } from './updates';

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
    </section>
  );
}

/**
 * The notice a newer build brings (T64 item 2): at the window's foot until dismissed, with
 * Install and Restart, and the download's progress after it.
 */
export function UpdateNotice() {
  const found = useUpdates();
  const [dismissed, setDismissed] = useState<string | null>(null);
  const state = found?.state ?? null;
  const shown =
    state &&
    state.version &&
    (state.phase === 'available' || state.phase === 'downloading' || state.phase === 'ready') &&
    (state.phase !== 'available' || dismissed !== state.version)
      ? state
      : null;
  return (
    <div role="status" className="toast-live">
      {shown && found ? (
        <div className="toast toast-with-action" data-testid="update-notice">
          <Icon name="refresh" />
          <span>{updateStatus(shown)}</span>
          {shown.phase === 'available' ? (
            <>
              <button
                type="button"
                className="btn primary"
                data-ui="submit"
                onClick={() => void found.updates.install().catch(() => null)}
                data-testid="update-install"
              >
                Install and Restart
              </button>
              <button
                type="button"
                className="toast-close"
                data-ui="dismiss"
                aria-label="Dismiss"
                onClick={() => setDismissed(shown.version)}
              >
                <Icon name="close" size={14} />
              </button>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
