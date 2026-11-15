/**
 * Settings → Semantic Search (T78, A1158; PEN-146; A1566): the switch, what the Mac's embedding
 * service is doing with a progress bar, and the model with its size and licence, and Delete
 * Model…. On by default. Off stops it and search goes by words; the model stays, so On is quick.
 * Delete Model… asks first, naming the size, then deletes the model and the index from this Mac
 * and switches it off; On downloads it again. Agents' `penmoss` on this Mac follows the same
 * setting (`~/.penmoss/meaning.json`). The Mac app only.
 */
import { useId, useState } from 'react';
import type { DesktopMeaningStatus } from '../desktop/bridge';
import { ConfirmDialog } from '../shell/ConfirmDialog';
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

/** Some of the model is on this Mac: all of it, or a download that stopped. */
const modelHere = (status: DesktopMeaningStatus | null) => (status?.modelBytes ?? 0) > 0;

export function MeaningSettings() {
  const found = useMeaningStatus();
  const id = useId();
  /** The switch as just clicked, until main answers. */
  const [wanted, setWanted] = useState<boolean | null>(null);
  /** Delete Model… was clicked: the question waits for Delete Model or Cancel. */
  const [asking, setAsking] = useState(false);
  /** The model is being deleted. */
  const [deleting, setDeleting] = useState(false);
  if (!found) return null;
  const { meaning, status } = found;
  const on = wanted ?? status?.enabled !== false;
  const set = (next: boolean) => {
    setWanted(next);
    void meaning
      .setEnabled(next)
      .catch(() => null)
      .finally(() => setWanted(null));
  };
  const deleteModel = () => {
    setAsking(false);
    setDeleting(true);
    void meaning
      .removeModel()
      .catch(() => null)
      .finally(() => setDeleting(false));
  };
  const progress = status ? meaningProgress(status) : null;
  const here = modelHere(status);
  return (
    <section
      className="settings-section"
      aria-labelledby={`${id}-h`}
      data-testid="meaning-settings"
    >
      <SettingsHeader
        id={`${id}-h`}
        title="Semantic Search"
        intro={
          <>
            Search finds notes by what they mean as well as by their words, here and for agents’{' '}
            <code>penmoss</code>.
          </>
        }
      />
      <div className="lf-group">
        <SettingRow
          setting="semantic-search"
          label="Semantic Search"
          labelFor={`${id}-on`}
          help="Runs on this Mac. Your notes never leave it. Off, search matches your words."
          helpId={`${id}-help`}
        >
          <Switch
            id={`${id}-on`}
            checked={on}
            disabled={wanted !== null || deleting || status === null}
            aria-describedby={`${id}-help`}
            data-testid="meaning-enabled"
            onChange={(event) => set(event.target.checked)}
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
                <span data-testid="meaning-model-state">
                  {modelName(status.model)} · {here ? sizeOf(status) : 'Not downloaded'}
                </span>
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
          >
            {here || deleting ? (
              <button
                type="button"
                className="btn danger"
                data-ui="item"
                data-testid="meaning-delete-model"
                disabled={deleting || wanted !== null}
                onClick={() => setAsking(true)}
              >
                {deleting ? 'Deleting…' : 'Delete Model…'}
              </button>
            ) : null}
          </SettingRow>
        ) : null}
      </div>
      {asking ? (
        <ConfirmDialog
          title="Delete the Model?"
          testId="meaning-delete-ask"
          onCancel={() => setAsking(false)}
          onSubmit={deleteModel}
        >
          <p>
            {modelName(status?.model)} ({sizeOf(status)}) and the semantic index are deleted from
            this Mac, and Semantic Search turns off: search matches your words. Turning it on again
            downloads the model again.
          </p>
          <div className="confirm-actions">
            <button
              type="button"
              className="btn"
              data-ui="dismiss"
              onClick={() => setAsking(false)}
              data-testid="meaning-delete-cancel"
              autoFocus
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn danger-fill"
              data-ui="submit"
              data-testid="meaning-delete-confirm"
            >
              Delete Model
            </button>
          </div>
        </ConfirmDialog>
      ) : null}
    </section>
  );
}
