/** The logs a bug report attaches in Send Feedback (PEN-137; FeedbackDialog.tsx). */
import type { Limits } from '@penmoss/core/analytics';
import { useEffect, useState } from 'react';
import { desktop } from '../desktop/bridge';

/** A bug report's logs as the form shows and attaches them (PEN-137). */
export interface ShownLogs {
  readonly lines: readonly string[];
  readonly limits: Limits;
}

/**
 * The anonymised logs a bug report attaches, read as the form opens (after scrub #2 with the
 * open notebooks' names), or the ones a report taken back by Edit previewed. Null outside the
 * Mac app, or until they are read.
 */
export function useReportLogs(
  loaded: boolean,
  keptLogs: readonly string[] | null,
  names: readonly string[],
): ShownLogs | null {
  const [logs, setLogs] = useState<ShownLogs | null>(null);
  useEffect(() => {
    const analytics = desktop()?.analytics;
    if (!loaded || !analytics) return;
    let live = true;
    void Promise.all([
      analytics.status(),
      keptLogs ? { lines: keptLogs } : analytics.reportLogs(names),
    ])
      .then(([status, report]) => {
        if (live) setLogs({ lines: report.lines, limits: status.limits });
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [loaded, keptLogs, names]);
  return logs;
}
