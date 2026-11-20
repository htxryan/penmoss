/**
 * Usage analytics' and the log file's IPC (PEN-137). Main and note windows record events and
 * log lines (fire and forget; at most 50 lines a minute from the pages), read the status and the
 * record, and ask for a bug report's logs; the answer, the switch, the ID and the limits are the
 * main window's. Turning sharing on needs a key press or click: without one the status comes
 * back unchanged. Every argument is checked here, whatever the contract says the page sends.
 */
import { shell } from 'electron';
import { logFile } from '../app-state';
import { parseLimitChanges, parsePageQuery } from '../analytics';
import type { IpcHandlers } from '../ipc';
import { LineBudget } from '../log-file';
import { analytics } from '../services';

/** The page's lines in the log file: at most this many a minute, from every window together. */
export const PAGE_LINES_PER_MINUTE = 50;

/** The longest list of names a bug report's scrub #2 takes, and the longest name. */
const MAX_NAMES = 20_000;
const MAX_NAME = 300;

/** The names the page sends for scrub #2 (note titles, folders, tags, attachments), checked. */
export function parseNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return (value as unknown[])
    .slice(0, MAX_NAMES)
    .filter((name): name is string => typeof name === 'string' && name.length <= MAX_NAME);
}

export function registerAnalyticsIpc(ipc: IpcHandlers): void {
  const budget = new LineBudget(PAGE_LINES_PER_MINUTE);
  ipc.on('analyticsRecord', (_call, events) => {
    analytics.recordPage(events);
  });
  ipc.on('analyticsLog', (_call, level, message) => {
    if (typeof message !== 'string') return;
    if (!budget.take()) return;
    const dropped = budget.takeDropped();
    if (dropped > 0) logFile.write('warn', 'page', `${dropped} lines left out (over 50 a minute)`);
    logFile.write(level === 'error' ? 'error' : 'warn', 'page', message);
  });
  ipc.handle('analyticsStatus', () => analytics.status());
  ipc.handle('analyticsAnswer', ({ gesture }, consent) => {
    if (consent !== 'yes' && consent !== 'no') return analytics.status();
    // Sharing goes on only with a person behind it; No never needs one.
    if (consent === 'yes' && !gesture) return analytics.status();
    return analytics.answer(consent);
  });
  ipc.handle('analyticsSetSharing', ({ gesture }, on) => {
    if (typeof on !== 'boolean' || (on && !gesture)) return analytics.status();
    return analytics.setSharing(on);
  });
  ipc.handle('analyticsResetId', () => analytics.resetId());
  ipc.handle('analyticsForget', () => analytics.forget());
  ipc.handle('analyticsPage', (_call, query) => analytics.page(parsePageQuery(query)));
  ipc.handle('analyticsPreview', (_call, changes) =>
    analytics.preview(changes === null ? null : parseLimitChanges(changes)),
  );
  ipc.handle('analyticsSetLimits', (_call, changes) =>
    analytics.setLimits(changes === null ? null : parseLimitChanges(changes)),
  );
  ipc.handle('analyticsShowLogFile', async () => {
    // The file is there to show, even before the first line reaches it.
    await logFile.flushed();
    shell.showItemInFolder(logFile.path);
    return true;
  });
  ipc.handle('analyticsReportLogs', (_call, names) =>
    logFile.report(analytics.limits, parseNames(names)),
  );
}
