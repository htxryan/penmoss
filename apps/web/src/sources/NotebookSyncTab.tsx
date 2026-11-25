/** A notebook page's Sync tab (GitNotebooksSettings.tsx). */
import { Select } from '@penmoss/ui/controls/Select';
import { useId } from 'react';
import { type DesktopGit } from '../desktop/bridge';
import { useGitInfo, useGitStatus } from './hooks';
import type { GitSource } from './git-source';
import { SettingRow } from '../theme/look-rows';
import {
  PHASE_WORDS,
  agoWords,
  pullChoices,
  pullWords,
  pushChoices,
  pushWords,
} from './sync-words';
import { counted } from '@penmoss/core/words';
import { type Answer, when } from './notebook-settings-shared';

/** Sync: the cadence as menus in words, the sync's state, and the diagnostics under Details. */
export function SyncTab({
  source,
  git,
  answer,
  now,
}: {
  source: GitSource;
  git: DesktopGit;
  answer: Answer;
  now: number;
}) {
  const info = useGitInfo(source);
  const status = useGitStatus(source);
  const id = useId();
  const waiting = status.pending.filter((each) => each !== 'workspace').length;
  const notices =
    (status.cleared || status.storageKept === false ? 1 : 0) +
    (status.unreadable && status.unreadable.length > 0 ? 1 : 0) +
    (info.filterIgnored ? 1 : 0) +
    (status.handEdits.length > 0 ? 1 : 0);
  return (
    <>
      <div className="lf-group nset-first-group">
        <SettingRow
          setting="push-changes"
          label="Push Changes"
          labelFor={`${id}-push`}
          help="After your edits settle"
        >
          <Select
            id={`${id}-push`}
            value={info.pushDelayS}
            data-event="settings.git-notebooks.push-after"
            data-testid="git-push-delay"
            onChange={(event) => {
              const value = Number(event.currentTarget.value);
              if (value !== info.pushDelayS) {
                void answer(
                  () => git.update(info.localId, { pushDelayS: value }),
                  () => `Pushes ${pushWords(value).toLowerCase()} your edits settle.`,
                );
              }
            }}
          >
            {pushChoices(info.pushDelayS).map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </Select>
        </SettingRow>
        <SettingRow
          setting="pull-changes"
          label="Pull Changes"
          labelFor={`${id}-pull`}
          help="While Penmoss is open, and whenever it comes to the front"
        >
          <Select
            id={`${id}-pull`}
            value={info.pullEveryMin}
            data-event="settings.git-notebooks.pull-every"
            data-testid="git-pull-interval"
            onChange={(event) => {
              const value = Number(event.currentTarget.value);
              if (value !== info.pullEveryMin) {
                void answer(
                  () => git.update(info.localId, { pullEveryMin: value }),
                  () =>
                    `Pulls ${pullWords(value).toLowerCase()}, and when Penmoss comes to the front.`,
                );
              }
            }}
          >
            {pullChoices(info.pullEveryMin).map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </Select>
        </SettingRow>
        <SettingRow
          setting="sync-status"
          label="Status"
          testId="git-sync-state"
          help={[
            status.closing ? 'Pushing…' : PHASE_WORDS[status.phase],
            waiting === 0
              ? 'Nothing Waits to Be Pushed'
              : `${counted(waiting, 'Note Waits', 'Notes Wait')} to Be Pushed`,
            status.lastSyncAt === null
              ? 'Never Synced'
              : `Last Synced ${agoWords(status.lastSyncAt, now)}`,
            ...(status.nextRetryAt ? [`Tries Again ${when(status.nextRetryAt)}`] : []),
          ].join(' · ')}
        />
      </div>
      <details className="nset-details" data-testid="git-details">
        <summary data-event="settings.git-notebooks.details">
          Details
          {notices > 0 ? (
            <span className="chip" data-testid="git-details-count">
              {counted(notices, 'Notice')}
            </span>
          ) : null}
        </summary>
        <dl className="settings-facts">
          <dt>Remote</dt>
          <dd>{info.remote}</dd>
          <dt>Branch</dt>
          <dd>{info.branch}</dd>
          <dt>Folder</dt>
          <dd>{info.dir || 'The repository’s root'}</dd>
          <dt>Last Sync</dt>
          <dd>{when(status.lastSyncAt)}</dd>
          {status.cleared || status.storageKept === false ? (
            <>
              <dt>Storage</dt>
              <dd data-testid="git-storage">
                <span role="status">
                  {status.cleared === 'lost'
                    ? 'This Mac’s storage for the notebook was cleared since it last synced here (macOS or the app’s data was cleared). The notes were fetched again from git; changes not pushed before then could not be kept.'
                    : status.cleared === 'kept'
                      ? 'This Mac’s engine storage for the notebook was cleared since it last synced here; the windows’ copies were still here and were taken in again, so nothing was lost.'
                      : 'The Mac may clear this notebook’s storage when space runs low; push often.'}
                </span>
              </dd>
            </>
          ) : null}
          {status.unreadable && status.unreadable.length > 0 ? (
            <>
              <dt>Unreadable</dt>
              <dd data-testid="git-unreadable">
                <span role="status">
                  {status.unreadable.length === 1
                    ? '1 copy of a note in this Mac’s windows couldn’t be read, so it was not taken in. It is left as it is; the rest of the notebook syncs.'
                    : `${status.unreadable.length} copies of notes in this Mac’s windows couldn’t be read, so they were not taken in. They are left as they are; the rest of the notebook syncs.`}
                </span>
              </dd>
            </>
          ) : null}
          {info.filterIgnored ? (
            <>
              <dt>Clone</dt>
              <dd>
                The host ignored the partial-clone filter, so this Mac holds every file of the
                repository.
              </dd>
            </>
          ) : null}
          {status.handEdits.length > 0 ? (
            <>
              <dt>Edited by Hand</dt>
              <dd data-testid="git-hand-edits">
                Penmoss wrote these again from the notes (edit them in Penmoss):{' '}
                {status.handEdits.join(', ')}
              </dd>
            </>
          ) : null}
        </dl>
      </details>
    </>
  );
}
