/**
 * "Sent as #123" (T49, A796): a toast with the issue's link, whenever this window's outbox
 * sends feedback, at once or later from the queue. It stays while hovered or focused.
 */
import { Icon } from '@penmoss/ui/icons';
import { useEffect, useState } from 'react';
import type { FiledIssue } from './outbox';
import { issueLink } from './send';
import { useFeedback } from './service';
import { ActionToast } from '../toasts/ActionToast';
import { ToastSlot } from '../toasts/ToastSlot';

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
    <ToastSlot>
      {issue ? (
        <ActionToast
          tone="done"
          testId="feedback-sent-toast"
          icon={<Icon name="check" className="toast-glyph" />}
          actions={
            issueLink(issue.url) ? (
              <a
                className="toast-action"
                href={issueLink(issue.url)!}
                target="_blank"
                rel="noopener noreferrer"
                data-testid="feedback-sent-link"
              >
                Open
              </a>
            ) : null
          }
          onDismiss={() => setIssue(null)}
          onHold={setHeld}
        >
          Sent as #{issue.number}
        </ActionToast>
      ) : null}
    </ToastSlot>
  );
}
