/**
 * Settings → Status: feedback waiting in this device's outbox (T49, A796). Queued entries say
 * when they will be tried; one the server refused shows why, with Edit, Retry and Discard.
 * Discard waits while a report is being sent.
 */
import { useId, useState } from 'react';
import { useCommands } from '../commands/hooks';
import { shortWhen } from '../shell/when';
import { useFeedback, useOutbox, type FeedbackService } from './service';

export function FeedbackStatus() {
  const feedback = useFeedback();
  return feedback ? <Outbox feedback={feedback} /> : null;
}

function Outbox({ feedback }: { feedback: FeedbackService }) {
  const id = useId();
  const entries = useOutbox(feedback);
  const commands = useCommands();
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const act = (entryId: string, work: () => Promise<unknown>) => {
    setBusy(entryId);
    void work().finally(() => setBusy(null));
  };
  return (
    <section className="settings-section" aria-labelledby={`${id}-h`} data-testid="feedback-outbox">
      <h2 id={`${id}-h`}>Feedback outbox</h2>
      {entries.length === 0 ? (
        <p className="muted">No feedback waiting to be sent.</p>
      ) : (
        <ul className="list">
          {entries.map((entry) => (
            <li key={entry.id} data-testid="feedback-outbox-entry" data-state={entry.state}>
              <span>
                <strong>{entry.title}</strong>
                <br />
                <span className="muted">
                  {entry.state === 'failed'
                    ? `Not sent: ${entry.error?.message ?? 'refused'}`
                    : entry.state === 'queued' && entry.error?.code === 'no_github_token'
                      ? `Queued ${shortWhen(entry.createdAt)}. ${entry.error.message}`
                      : entry.state === 'sending'
                        ? 'Sending…'
                        : `Queued ${shortWhen(entry.createdAt)}, will send when you’re online`}
                </span>
              </span>
              <span className="row">
                <button
                  type="button"
                  className="btn quiet"
                  data-ui="dismiss"
                  data-testid="feedback-outbox-discard"
                  disabled={busy === entry.id || entry.state === 'sending'}
                  onClick={() => act(entry.id, () => feedback.outbox.discard(entry.id))}
                >
                  Discard
                </button>
                {entry.state === 'failed' ? (
                  <button
                    type="button"
                    className="btn quiet"
                    data-ui="item"
                    data-testid="feedback-outbox-edit"
                    disabled={busy === entry.id}
                    onClick={() =>
                      act(entry.id, async () => {
                        const result = await feedback.editEntry(entry.id);
                        setNote(
                          result === 'draft-open'
                            ? 'Send or discard the report open in Send feedback first.'
                            : null,
                        );
                        if (result === 'ok') commands.run('app.sendFeedback', { source: 'button' });
                      })
                    }
                  >
                    Edit
                  </button>
                ) : null}
                <button
                  type="button"
                  className="btn"
                  data-ui="submit"
                  disabled={busy === entry.id || entry.state === 'sending'}
                  onClick={() => act(entry.id, () => feedback.outbox.retry(entry.id))}
                >
                  {entry.state === 'failed' ? 'Retry' : 'Send Now'}
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {note ? (
        <p role="alert" className="field-error">
          {note}
        </p>
      ) : null}
    </section>
  );
}
