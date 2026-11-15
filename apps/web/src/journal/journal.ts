/**
 * Daily and weekly notes in the app (T19): which day it is (in the synced
 * time zone setting, America/Chicago by default), the user's templates, and
 * opening a period's note, creating it from its template when needed.
 */
import { isoWeek, todayIn, type PeriodKind, type PlainDate } from '@penmoss/core/periodic';
import { templateOf, timeZoneOf } from '@penmoss/core/settings';
import type { Notes } from '../notes/service';
import { REVEAL, navigate, notePath, openPath, showPath } from '../router';
import type { Workspace } from '../workspace/service';

export function today(settings: Record<string, unknown>, now: Date = new Date()): PlainDate {
  return todayIn(timeZoneOf(settings), now);
}

export function thisWeek(settings: Record<string, unknown>, now: Date = new Date()): string {
  return isoWeek(today(settings, now)).toString();
}

/**
 * Opens the daily (`2026-10-21`) or weekly (`2026-W43`) note, creating it from
 * the template if this device does not have it, and files it in the journal.
 * `inTab`: Open Today's Journal and This Week's Note (the menus, the menu bar icon) show it in
 * the tab already showing it, else a new tab in front, never in place of the page on screen
 * (A1498); the calendar and the period's arrows open it in the tab on screen. `newTab`: Today
 * or This Week ⌘-clicked in the sidebar, a new tab behind the one on screen (or ⇧⌘, in front),
 * which keeps its focus (A1570).
 */
export async function openPeriodic(
  notes: Notes,
  workspace: Workspace,
  kind: PeriodKind,
  period: string,
  options: {
    readonly inTab?: boolean;
    readonly newTab?: 'background' | 'foreground' | undefined;
  } = {},
): Promise<string> {
  const settings = workspace.settings();
  // Filed first: once the note is listed, notes the registry does not know go to the top level.
  workspace.fileJournalNote(notes.periodicId(kind, period), kind, period);
  const id = await notes.ensurePeriodic(kind, period, templateOf(settings, kind));
  if (options.newTab) {
    if (options.newTab === 'foreground') notes.requestBodyFocus(id);
    openPath(notePath(id), options.newTab, REVEAL);
    return id;
  }
  notes.requestBodyFocus(id);
  if (options.inTab) showPath(notePath(id));
  else navigate(notePath(id));
  return id;
}
