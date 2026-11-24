/**
 * Settings → Privacy (PEN-137, ac2, ac16, ac37): usage analytics and the logs, on this Mac. In
 * order: Share Usage Data; View Analytics Data, with the record's counts by state, which opens
 * Analytics Data (its own page under Privacy); the Analytics ID with Reset My Analytics ID and
 * Delete My Shared Data (which asks first, under the button); Logs with Show Log File; then
 * Advanced, closed until opened; and the Privacy Policy. The status is main's, kept current as
 * it changes (a terminal's `penmoss analytics off` shows here at once).
 */
import { countsLine } from '@penmoss/core/analytics';
import { Icon } from '@penmoss/ui/icons';
import { useId, useState } from 'react';
import type { DesktopAnalytics, DesktopAnalyticsStatus } from '../desktop/bridge';
import { SettingsHeader } from '../pages/SettingsHeader';
import { linkHandler, PRIVACY_DATA_PATH } from '../router';
import { ConfirmBlock } from '../shell/ConfirmBlock';
import { SettingRow, Switch } from '../theme/look-rows';
import { PrivacyPolicyLink } from './Consent';
import { AdvancedLimits } from './Limits';
import { flushRecorded, record } from './record';
import { analyticsBridge, copy, shortId, useAnalyticsStatus } from './status';
import './privacy.css';

export function PrivacySettings() {
  const analytics = analyticsBridge();
  const status = useAnalyticsStatus();
  const id = useId();
  if (!analytics) return null;
  return (
    <section
      className="settings-section privacy-settings"
      aria-labelledby={`${id}-h`}
      data-testid="privacy-settings"
    >
      <SettingsHeader id={`${id}-h`} title={copy('privacy.title')} />
      {status ? <PrivacyRows analytics={analytics} status={status} /> : null}
      <p className="privacy-policy">
        <PrivacyPolicyLink event="privacy.policy" />
      </p>
    </section>
  );
}

/** What the ID row last did, said under it. */
type IdNote = 'reset' | 'forgotten' | 'offline' | 'failed';

const ID_NOTES: Readonly<Record<IdNote, Parameters<typeof copy>[0]>> = {
  reset: 'privacy.resetId.done',
  forgotten: 'forget.done',
  offline: 'forget.offline',
  failed: 'forget.failed',
};

function PrivacyRows({
  analytics,
  status,
}: {
  readonly analytics: DesktopAnalytics;
  readonly status: DesktopAnalyticsStatus;
}) {
  const id = useId();
  /** The switch as just clicked, until main answers. */
  const [wanted, setWanted] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [forgetting, setForgetting] = useState(false);
  const [note, setNote] = useState<IdNote | null>(null);
  const sharing = wanted ?? status.consent === 'yes';
  const run = async (act: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await act().catch(() => null);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="lf-group">
        <SettingRow
          setting="share-usage-data"
          label={copy('privacy.share.label')}
          labelFor={`${id}-share`}
          help={copy('privacy.share.hint')}
          helpId={`${id}-share-help`}
        >
          <Switch
            id={`${id}-share`}
            checked={sharing}
            aria-describedby={`${id}-share-help`}
            data-event={sharing ? 'privacy.share.off' : 'privacy.share.on'}
            data-testid="privacy-share"
            onChange={(event) => {
              const on = event.target.checked;
              setWanted(on);
              record('setting', 'privacy.share', { value: on });
              void run(() => analytics.setSharing(on)).finally(() => setWanted(null));
            }}
          />
        </SettingRow>
        <div className="privacy-row-link" data-setting="view-analytics-data">
          <a
            href={PRIVACY_DATA_PATH}
            className="lf-row"
            data-ui="item"
            data-event="privacy.view-data"
            data-testid="privacy-view-data"
            onClick={linkHandler(PRIVACY_DATA_PATH)}
          >
            <span className="lf-row-text">
              <span className="lf-row-label">{copy('privacy.viewData.label')}</span>
              <span className="lf-row-help" data-testid="privacy-counts">
                {countsLine(status.counts)}
              </span>
            </span>
            <Icon name="chevR" size={16} className="privacy-row-chevron" />
          </a>
        </div>
        <div className="lf-row privacy-id-row" data-setting="analytics-id">
          <div className="lf-row-text">
            <span className="lf-row-label" id={`${id}-id`}>
              {copy('privacy.id.label')}
            </span>
            <span className="lf-row-help">{copy('privacy.id.hint')}</span>
            <code className="privacy-id" aria-labelledby={`${id}-id`} data-testid="privacy-id">
              {shortId(status.install)}
            </code>
            {note ? (
              <p
                className="lf-row-note"
                role={note === 'offline' || note === 'failed' ? 'alert' : 'status'}
                data-testid="privacy-id-note"
              >
                {copy(ID_NOTES[note])}
              </p>
            ) : null}
          </div>
          <div className="lf-row-control">
            <span data-setting="reset-my-analytics-id">
              <button
                type="button"
                className="btn"
                data-ui="item"
                data-event="privacy.reset-id"
                data-testid="privacy-reset-id"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    // What this page recorded first reaches main under the old ID (PEN-177).
                    flushRecorded();
                    await analytics.resetId();
                    record('setting', 'privacy.reset', { value: true });
                    setNote('reset');
                  })
                }
              >
                {copy('privacy.resetId.button')}
              </button>
            </span>
            <span data-setting="delete-my-shared-data">
              <button
                type="button"
                className="btn quiet danger"
                data-ui="item"
                data-event="privacy.forget"
                data-testid="privacy-forget"
                aria-expanded={forgetting}
                disabled={busy}
                onClick={() => setForgetting((open) => !open)}
              >
                {copy('privacy.forget.button')}
              </button>
            </span>
          </div>
          {forgetting ? (
            <ConfirmBlock
              className="privacy-confirm"
              title={copy('forget.title')}
              testId="privacy-forget-confirm"
              onCancel={() => setForgetting(false)}
            >
              <p className="privacy-confirm-body">
                {copy('forget.body', { id: shortId(status.install) })}
              </p>
              <span className="privacy-confirm-actions">
                <button
                  type="button"
                  className="btn quiet"
                  data-ui="dismiss"
                  data-event="privacy.forget.cancel"
                  data-testid="privacy-forget-confirm-cancel"
                  onClick={() => setForgetting(false)}
                >
                  {copy('confirm.cancel.button')}
                </button>
                <button
                  type="button"
                  className="btn danger"
                  data-ui="submit"
                  data-event="privacy.forget.confirm"
                  data-testid="privacy-forget-confirm-delete"
                  onClick={() => {
                    setForgetting(false);
                    void run(async () => {
                      flushRecorded();
                      const result = await analytics.forget().catch(() => null);
                      const outcome = result?.outcome ?? 'failed';
                      if (outcome === 'ok') record('setting', 'privacy.forget', { value: true });
                      setNote(
                        outcome === 'ok'
                          ? 'forgotten'
                          : outcome === 'offline'
                            ? 'offline'
                            : 'failed',
                      );
                    });
                  }}
                >
                  {copy('confirm.delete.button')}
                </button>
              </span>
            </ConfirmBlock>
          ) : null}
        </div>
        <SettingRow
          setting="logs"
          label={copy('privacy.logs.label')}
          labelId={`${id}-logs`}
          help={copy('privacy.logs.hint', { days: status.limits['logs.days'] })}
          helpId={`${id}-logs-help`}
        >
          <button
            type="button"
            className="btn"
            data-ui="item"
            data-event="privacy.show-log-file"
            data-testid="privacy-show-log"
            aria-describedby={`${id}-logs-help`}
            onClick={() => void analytics.showLogFile().catch(() => false)}
          >
            {copy('privacy.logs.button')}
          </button>
        </SettingRow>
      </div>
      <AdvancedLimits analytics={analytics} limits={status.limits} />
    </>
  );
}
