/**
 * Settings → Semantic Search (T78, A1158; PEN-146; A1566): the switch, what the Mac's embedding
 * service is doing with a progress bar, the model with its size and licence, and Delete Model…
 * (solid red). On by default. Off stops it and search goes by words; the model stays, so On is
 * quick. Delete Model… asks first, naming the size, then deletes the model and the index from this
 * Mac and switches it off; On downloads it again. The Semantic Index row (A1595) says how much the index
 * takes, and offers one action, never both: on, Recreate Index… (deleted and built again from the
 * notes, the Indexing row showing its progress); off, Delete Index… while there is one (the model
 * stays). Agents' `penmoss` on this Mac follows the same
 * setting (`~/.penmoss/meaning.json`). The Mac app only.
 */
import { useId, useState } from 'react';
import type { DesktopMeaningStatus } from '../desktop/bridge';
import { ConfirmDialog } from '../shell/ConfirmDialog';
import { SettingRow, Switch } from '../theme/look-rows';
import {
  indexSize,
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
  /** Recreate Index… or Delete Index… was clicked: its question waits. */
  const [askingIndex, setAskingIndex] = useState(false);
  /** The index is being deleted (and, on, built again). */
  const [removingIndex, setRemovingIndex] = useState(false);
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
  const removeIndex = () => {
    setAskingIndex(false);
    setRemovingIndex(true);
    void meaning
      .removeIndex()
      .catch(() => null)
      .finally(() => setRemovingIndex(false));
  };
  const progress = status ? meaningProgress(status) : null;
  const here = modelHere(status);
  const busy = deleting || removingIndex || wanted !== null;
  // On: Recreate Index…, once the model is open. Off: Delete Index…, while there is one.
  const enabled = status?.enabled === true;
  const indexBytes = status?.indexBytes ?? 0;
  const indexAction: 'recreate' | 'delete' | null =
    status === null
      ? null
      : enabled
        ? status.state === 'indexing' || status.state === 'ready'
          ? 'recreate'
          : null
        : indexBytes > 0
          ? 'delete'
          : null;
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
            disabled={busy || status === null}
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
                  {modelName(status.model)} · {here ? sizeOf(status) : 'Not Downloaded'}
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
                data-event="settings.meaning.delete-model"
                type="button"
                className="btn danger-fill"
                data-ui="item"
                data-testid="meaning-delete-model"
                disabled={busy}
                onClick={() => setAsking(true)}
              >
                {deleting ? 'Deleting…' : 'Delete Model…'}
              </button>
            ) : null}
          </SettingRow>
        ) : null}
        {status ? (
          <SettingRow
            setting="semantic-index"
            label="Semantic Index"
            testId="meaning-index"
            help={
              <span data-testid="meaning-index-state">
                {indexBytes > 0
                  ? `${indexSize(indexBytes)} on this Mac, from your notes`
                  : 'No Index'}
              </span>
            }
          >
            {indexAction === 'recreate' ? (
              <button
                data-event="settings.meaning.recreate-index"
                type="button"
                className="btn"
                data-ui="item"
                data-testid="meaning-recreate-index"
                disabled={busy}
                onClick={() => setAskingIndex(true)}
              >
                {removingIndex ? 'Recreating…' : 'Recreate Index…'}
              </button>
            ) : indexAction === 'delete' ? (
              <button
                data-event="settings.meaning.delete-index"
                type="button"
                className="btn danger-fill"
                data-ui="item"
                data-testid="meaning-delete-index"
                disabled={busy}
                onClick={() => setAskingIndex(true)}
              >
                {removingIndex ? 'Deleting…' : 'Delete Index…'}
              </button>
            ) : null}
          </SettingRow>
        ) : null}
      </div>
      {askingIndex && indexAction ? (
        <ConfirmDialog
          title={indexAction === 'recreate' ? 'Recreate the Index?' : 'Delete the Index?'}
          testId="meaning-index-ask"
          onCancel={() => setAskingIndex(false)}
          onSubmit={removeIndex}
        >
          <p>
            {indexAction === 'recreate'
              ? `The semantic index${indexBytes > 0 ? ` (${indexSize(indexBytes)})` : ''} is deleted and built again from your notes. That takes a while and keeps this Mac busy; until it is done, search matches your words in the notes not indexed yet.`
              : `The semantic index (${indexSize(indexBytes)}) is deleted from this Mac. The model stays, so turning Semantic Search on builds the index again without a download.`}
          </p>
          <div className="confirm-actions">
            <button
              data-event="settings.meaning.index.cancel"
              type="button"
              className="btn"
              data-ui="dismiss"
              onClick={() => setAskingIndex(false)}
              data-testid="meaning-index-cancel"
              autoFocus
            >
              Cancel
            </button>
            <button
              data-event={
                indexAction === 'recreate'
                  ? 'settings.meaning.index.recreate'
                  : 'settings.meaning.index.delete'
              }
              type="submit"
              className={indexAction === 'recreate' ? 'btn primary' : 'btn danger-fill'}
              data-ui="submit"
              data-testid="meaning-index-confirm"
            >
              {indexAction === 'recreate' ? 'Recreate Index' : 'Delete Index'}
            </button>
          </div>
        </ConfirmDialog>
      ) : null}
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
              data-event="settings.meaning.delete-model.cancel"
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
              data-event="settings.meaning.delete-model.confirm"
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
