/**
 * Waiting to Send, in the Send Feedback form (T49, A796; PEN-146): the reports this device's
 * outbox holds, where they were written. It was Settings → Status's Feedback outbox. Queued
 * entries say when they will be tried; one GitHub refused shows why, with Edit, Retry and
 * Discard. Discard waits while a report is being sent. Nothing shows when nothing waits.
 */
import { useId, useState } from 'react';
import { shortWhen } from '../shell/when';
import { useOutbox, type EditResult, type FeedbackService } from './service';

export function FeedbackOutbox({
  feedback,
  onEdit,
}: {
  feedback: FeedbackService;
  /**
   * Edit: reads a refused report back into the form's draft (`feedback.editEntry`), and the form
   * starts again with it.
   */
  onEdit: (entryId: string) => Promise<EditResult>;
}) {
  const id = useId();
  const entries = useOutbox(feedback);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const act = (entryId: string, work: () => Promise<unknown>) => {
    setBusy(entryId);
    void work().finally(() => setBusy(null));
  };
  if (entries.length === 0) return null;
  return (
    <section className="feedback-outbox" aria-labelledby={`${id}-h`} data-testid="feedback-outbox">
      <h3 id={`${id}-h`}>Waiting to Send · {entries.length}</h3>
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
                data-event="feedback-outbox.discard"
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
                  data-event="feedback-outbox.edit"
                  type="button"
                  className="btn quiet"
                  data-ui="item"
                  data-testid="feedback-outbox-edit"
                  disabled={busy === entry.id}
                  onClick={() =>
                    act(entry.id, async () => {
                      const result = await onEdit(entry.id);
                      setNote(
                        result === 'draft-open'
                          ? 'Send or discard the report you’re writing first.'
                          : null,
                      );
                    })
                  }
                >
                  Edit
                </button>
              ) : null}
              <button
                data-event={
                  entry.state === 'failed' ? 'feedback-outbox.retry' : 'feedback-outbox.send-now'
                }
                type="button"
                className="btn"
                data-ui="submit"
                data-testid="feedback-outbox-retry"
                disabled={busy === entry.id || entry.state === 'sending'}
                onClick={() => act(entry.id, () => feedback.outbox.retry(entry.id))}
              >
                {entry.state === 'failed' ? 'Retry' : 'Send Now'}
              </button>
            </span>
          </li>
        ))}
      </ul>
      {note ? (
        <p role="alert" className="field-error">
          {note}
        </p>
      ) : null}
    </section>
  );
}
