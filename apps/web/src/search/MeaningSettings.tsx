/**
 * Settings → Search by Meaning (T78, A1158): what the Mac's embedding service is doing, and the
 * switch. On by default. Off stops it and removes the model and the vectors from this Mac; agents'
 * `penmoss` on this Mac follows the same setting (`~/.penmoss/meaning.json`). The Mac app only.
 */
import { useId, useState } from 'react';
import { meaningStatusText, modelName, useMeaningStatus, waitingText } from './meaning-status';

export function MeaningSettings() {
  const found = useMeaningStatus();
  const id = useId();
  /** The switch as just clicked, until main answers. */
  const [wanted, setWanted] = useState<boolean | null>(null);
  if (!found) return null;
  const { meaning, status } = found;
  return (
    <section
      className="settings-section"
      aria-labelledby={`${id}-h`}
      data-testid="meaning-settings"
    >
      <h2 id={`${id}-h`}>Search by Meaning</h2>
      <fieldset className="display-toggles">
        <legend className="sr-only">Search by Meaning</legend>
        <label className="display-toggle" htmlFor={`${id}-on`}>
          <input
            id={`${id}-on`}
            type="checkbox"
            checked={wanted ?? status?.enabled !== false}
            disabled={wanted !== null || status === null}
            aria-describedby={`${id}-help`}
            data-testid="meaning-enabled"
            onChange={(event) => {
              const next = event.target.checked;
              setWanted(next);
              void meaning
                .setEnabled(next)
                .catch(() => null)
                .finally(() => setWanted(null));
            }}
          />
          <span>Search by Meaning</span>
        </label>
        <p id={`${id}-help`} className="muted settings-help">
          Search finds notes by what they mean as well as by their words. The model runs on this
          Mac, so your notes never leave it. Off removes the model and its index. This Mac only, for
          the app and for agents’ <code>penmoss</code> here.
        </p>
      </fieldset>
      {status ? (
        <p
          role="status"
          className="updates-status"
          data-testid="meaning-status"
          data-state={status.state}
        >
          {meaningStatusText(status)}
          {waitingText(status)}
        </p>
      ) : null}
      {status?.license ? (
        <p className="muted settings-help">
          {modelName(status.model)} is Google’s, under the{' '}
          <a href={status.license.url} target="_blank" rel="noreferrer">
            {status.license.name}
          </a>
          .
        </p>
      ) : null}
    </section>
  );
}
