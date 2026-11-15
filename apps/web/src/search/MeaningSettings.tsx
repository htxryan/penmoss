/**
 * Settings → Search by Meaning (T78, A1158; PEN-146): the switch, named for what it does (Find
 * Notes by Meaning), what the Mac's embedding service is doing with a progress bar, and the
 * model with its size and licence. On by default. Off stops it and removes the model and the
 * vectors from this Mac, so it asks first and names the size; agents' `penmoss` on this Mac
 * follows the same setting (`~/.penmoss/meaning.json`). The Mac app only.
 */
import { useId, useState } from 'react';
import type { DesktopMeaningStatus } from '../desktop/bridge';
import { SettingRow, Switch } from '../theme/look-rows';
import {
  meaningProgress,
  meaningStatusText,
  megabytes,
  modelName,
  useMeaningStatus,
  waitingText,
} from './meaning-status';
import { SettingsHeader } from '../pages/SettingsHeader';

/** The model's size as its rows and the question say it. */
const sizeOf = (status: DesktopMeaningStatus | null) =>
  status?.totalBytes ? megabytes(status.totalBytes) : 'about 219 MB';

export function MeaningSettings() {
  const found = useMeaningStatus();
  const id = useId();
  /** The switch as just clicked, until main answers. */
  const [wanted, setWanted] = useState<boolean | null>(null);
  /** Off was clicked: the question waits for Turn Off or Cancel. */
  const [asking, setAsking] = useState(false);
  if (!found) return null;
  const { meaning, status } = found;
  const on = wanted ?? status?.enabled !== false;
  const set = (next: boolean) => {
    setAsking(false);
    setWanted(next);
    void meaning
      .setEnabled(next)
      .catch(() => null)
      .finally(() => setWanted(null));
  };
  const progress = status ? meaningProgress(status) : null;
  return (
    <section
      className="settings-section"
      aria-labelledby={`${id}-h`}
      data-testid="meaning-settings"
    >
      <SettingsHeader
        id={`${id}-h`}
        title="Search by Meaning"
        intro={
          <>
            Search finds notes by what they mean as well as by their words, here and for agents’{' '}
            <code>penmoss</code>.
          </>
        }
      />
      <div className="lf-group">
        <SettingRow
          setting="find-notes-by-meaning"
          label="Find Notes by Meaning"
          labelFor={`${id}-on`}
          help="Runs on this Mac. Your notes never leave it."
          helpId={`${id}-help`}
        >
          <Switch
            id={`${id}-on`}
            checked={on}
            disabled={wanted !== null || status === null}
            aria-describedby={`${id}-help`}
            data-testid="meaning-enabled"
            onChange={(event) => {
              // Off removes a download of hundreds of megabytes: it asks first.
              if (event.target.checked) set(true);
              else setAsking(true);
            }}
          />
        </SettingRow>
        {status ? (
          <SettingRow
            setting="indexing"
            label={status.state === 'downloading' ? 'Downloading' : 'Indexing'}
            labelId={`${id}-progress`}
            help={
              <span
                role="status"
                className="updates-status"
                data-testid="meaning-status"
                data-state={status.state}
              >
                {meaningStatusText(status)}
                {waitingText(status)}
              </span>
            }
          >
            {progress ? (
              <span
                className="settings-progress"
                role="progressbar"
                aria-labelledby={`${id}-progress`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={progress.percent}
                aria-valuetext={progress.text}
                data-testid="meaning-progress"
              >
                <span className="settings-progress-track" aria-hidden="true">
                  <span
                    className="settings-progress-fill"
                    style={{ width: `${progress.percent}%` }}
                  />
                </span>
                <span className="settings-progress-value" aria-hidden="true">
                  {progress.percent}%
                </span>
              </span>
            ) : null}
          </SettingRow>
        ) : null}
        {status?.model || status?.license ? (
          <SettingRow
            setting="model"
            label="Model"
            testId="meaning-model"
            help={
              <>
                {modelName(status.model)} · {sizeOf(status)}
                {status.license ? (
                  <>
                    {' · '}
                    <a href={status.license.url} target="_blank" rel="noreferrer">
                      {status.license.name}
                    </a>
                  </>
                ) : null}
              </>
            }
          />
        ) : null}
      </div>
      {asking ? (
        <div className="settings-confirm" role="alert" data-testid="meaning-off-ask">
          <p>
            <strong>Turn off and remove the model ({sizeOf(status)}) and the index?</strong> Search
            will match words only. Turning it on again downloads the model again.
          </p>
          <div className="settings-actions">
            <button
              type="button"
              className="btn danger"
              data-ui="submit"
              onClick={() => set(false)}
              data-testid="meaning-off-confirm"
            >
              Turn Off
            </button>
            <button
              type="button"
              className="btn quiet"
              data-ui="dismiss"
              onClick={() => setAsking(false)}
              data-testid="meaning-off-cancel"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
