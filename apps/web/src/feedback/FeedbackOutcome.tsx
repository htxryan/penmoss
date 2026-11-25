/** What Send Feedback shows after Send when the report did not go at once (FeedbackDialog.tsx). */
import { useLayoutEffect, useRef } from 'react';
import type { OutboxError } from './store';

/** Where the form's report stands. */
export type Status =
  | { readonly kind: 'idle' }
  | { readonly kind: 'sending' }
  | { readonly kind: 'queued'; readonly error: OutboxError | null }
  | { readonly kind: 'elsewhere' }
  | { readonly kind: 'failed'; readonly error: OutboxError };

/** After Send, when it did not go at once: queued (offline) or kept with its error. */
export function FeedbackOutcome({
  status,
  onClose,
  onRetry,
  onDiscard,
  onEdit,
}: {
  status: Status;
  onClose: () => void;
  onRetry: () => void;
  onDiscard: () => void;
  onEdit: () => void;
}) {
  const close = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => close.current?.focus(), []);
  return (
    <div className="feedback-outcome" data-testid="feedback-outcome">
      {status.kind === 'queued' && status.error?.code === 'no_github_token' ? (
        // The Mac files it with the person's own token (T57, A1012): it waits for one.
        <p role="status" data-testid="feedback-queued">
          Queued. {status.error.message}
        </p>
      ) : status.kind === 'queued' ? (
        <p role="status" data-testid="feedback-queued">
          Queued, will send when you’re online.
          {status.error && status.error.status !== 0 ? ` (${status.error.message})` : ''}
        </p>
      ) : status.kind === 'elsewhere' ? (
        <p role="status" data-testid="feedback-elsewhere">
          Queued: another Penmoss window is sending feedback now, and this goes next.
        </p>
      ) : status.kind === 'failed' ? (
        <p role="alert" data-testid="feedback-failed">
          Not sent: {status.error.message.replace(/\.$/, '')}. It waits under Waiting to Send in
          this form, where you can edit, retry or discard it.
        </p>
      ) : null}
      <div className="row">
        {status.kind === 'failed' ? (
          <>
            <button
              type="button"
              className="btn quiet"
              data-ui="dismiss"
              data-event="feedback.outcome.discard"
              onClick={onDiscard}
            >
              Discard
            </button>
            <button
              type="button"
              className="btn"
              data-ui="item"
              data-event="feedback.outcome.edit"
              data-testid="feedback-edit"
              onClick={onEdit}
            >
              Edit
            </button>
            <button
              type="button"
              className="btn"
              data-ui="submit"
              data-event="feedback.outcome.retry"
              onClick={onRetry}
            >
              Retry
            </button>
          </>
        ) : null}
        <button
          ref={close}
          type="button"
          className="btn primary"
          data-ui="dismiss"
          data-event="feedback.outcome.close"
          data-testid="feedback-close"
          onClick={onClose}
        >
          Close
        </button>
      </div>
    </div>
  );
}
