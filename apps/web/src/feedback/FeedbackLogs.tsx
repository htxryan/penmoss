/** A bug report's Attach Anonymised Logs in Send Feedback (PEN-137; FeedbackDialog.tsx). */
import { analyticsCopy, formatReportSize, reportHours, textBytes } from '@penmoss/core/analytics';
import type { ShownLogs } from './report-logs';

/**
 * Attach Anonymised Logs (PEN-137, ac3): the box, the sentence that follows the limits, and the
 * exact text attached, collapsed under its line count and size.
 */
export function FeedbackLogs({
  id,
  logs,
  attach,
  onAttach,
}: {
  id: string;
  logs: ShownLogs;
  attach: boolean;
  onAttach: (attach: boolean) => void;
}) {
  const { lines, limits } = logs;
  const hours = reportHours(limits);
  if (lines.length === 0) {
    return (
      <p className="muted feedback-hint" data-testid="feedback-logs-empty">
        {analyticsCopy('feedback.logs.empty', 'mac', { hours })}
      </p>
    );
  }
  const summary = analyticsCopy('feedback.logs.summary', 'mac', {
    lines: lines.length,
    size: formatReportSize(textBytes(lines)),
  });
  return (
    <div className="feedback-logs" data-testid="feedback-logs">
      <label className="feedback-logs-attach">
        <input
          type="checkbox"
          checked={attach}
          aria-describedby={`${id}-logs-hint`}
          data-event="feedback.logs.toggle"
          data-testid="feedback-logs-attach"
          onChange={(event) => onAttach(event.target.checked)}
        />
        {analyticsCopy('feedback.logs.label')}
      </label>
      <p id={`${id}-logs-hint`} className="muted feedback-hint">
        {analyticsCopy('feedback.logs.hint', 'mac', {
          hours,
          maxLines: limits['report.lines'],
          kb: limits['report.kb'],
        })}
      </p>
      <details className="feedback-context" data-testid="feedback-logs-preview">
        <summary data-event="feedback.logs.preview">{summary}</summary>
        <pre
          className="feedback-preview"
          data-testid="feedback-logs-text"
          tabIndex={0}
          aria-label="The anonymised logs as the issue will hold them"
        >
          {lines.join('\n')}
        </pre>
      </details>
    </div>
  );
}
