/**
 * "Sent as #123" (T49, A796): a toast with the issue's link, whenever this window's outbox
 * sends feedback, at once or later from the queue. It stays while hovered or focused.
 */
import { Icon } from '@penmoss/ui/icons';
import { useEffect, useState } from 'react';
import type { FiledIssue } from './outbox';
import { issueLink } from './send';
import { useFeedback } from './service';

/** How long the toast shows. */
const SHOWN_MS = 10_000;

export function FeedbackToasts() {
  const feedback = useFeedback();
  const [issue, setIssue] = useState<FiledIssue | null>(null);
  const [held, setHeld] = useState(false);
  useEffect(() => feedback?.outbox.onSent((_entry, sent) => setIssue(sent)), [feedback]);
  useEffect(() => {
    if (!issue || held) return;
    const timer = setTimeout(() => setIssue(null), SHOWN_MS);
    return () => clearTimeout(timer);
  }, [issue, held]);
  return (
    <div role="status" className="toast-live">
      {issue ? (
        <div
          className="toast toast-with-action"
          data-testid="feedback-sent-toast"
          onPointerEnter={() => setHeld(true)}
          onPointerLeave={() => setHeld(false)}
          onFocus={() => setHeld(true)}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) setHeld(false);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation();
              setIssue(null);
            }
          }}
        >
          <Icon name="check" />
          <span>Sent as #{issue.number}</span>
          {issueLink(issue.url) ? (
            <a
              className="toast-action"
              href={issueLink(issue.url)!}
              target="_blank"
              rel="noopener noreferrer"
              data-testid="feedback-sent-link"
            >
              Open
            </a>
          ) : null}
          <button
            type="button"
            className="toast-close"
            data-ui="dismiss"
            aria-label="Dismiss"
            onClick={() => setIssue(null)}
          >
            <Icon name="close" size={14} />
          </button>
        </div>
      ) : null}
    </div>
  );
}
