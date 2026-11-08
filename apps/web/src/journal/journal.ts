/**
 * Daily and weekly notes in the app (T19): which day it is (in the synced
 * time zone setting, America/Chicago by default), the user's templates, and
 * opening a period's note, creating it from its template when needed.
 */
import {
  DEFAULT_DAILY_TEMPLATE,
  DEFAULT_TIME_ZONE,
  DEFAULT_WEEKLY_TEMPLATE,
  isoWeek,
  isTimeZone,
  todayIn,
  type PeriodKind,
  type PlainDate,
} from '@penmoss/core/periodic';
import type { Notes } from '../notes/service';
import { navigate, notePath } from '../router';
import type { Workspace } from '../workspace/service';

export const TIME_ZONE_SETTING = 'timeZone';
export const templateSetting = (kind: PeriodKind) => `template.${kind}`;

/** The user's time zone setting, or the default when unset or unknown here. */
export function timeZoneOf(settings: Record<string, unknown>): string {
  const zone = settings[TIME_ZONE_SETTING];
  return typeof zone === 'string' && isTimeZone(zone) ? zone : DEFAULT_TIME_ZONE;
}

export function templateOf(settings: Record<string, unknown>, kind: PeriodKind): string {
  const template = settings[templateSetting(kind)];
  if (typeof template === 'string') return template;
  return kind === 'daily' ? DEFAULT_DAILY_TEMPLATE : DEFAULT_WEEKLY_TEMPLATE;
}

export function today(settings: Record<string, unknown>, now: Date = new Date()): PlainDate {
  return todayIn(timeZoneOf(settings), now);
}

export function thisWeek(settings: Record<string, unknown>, now: Date = new Date()): string {
  return isoWeek(today(settings, now)).toString();
}

/**
 * Opens the daily (`2026-10-21`) or weekly (`2026-W43`) note, creating it from
 * the template if this device does not have it, and files it in the journal.
 */
export async function openPeriodic(
  notes: Notes,
  workspace: Workspace,
  kind: PeriodKind,
  period: string,
): Promise<string> {
  const settings = workspace.settings();
  // Filed first: once the note is listed, notes the registry does not know go to the top level.
  workspace.fileJournalNote(notes.periodicId(kind, period), kind, period);
  const id = await notes.ensurePeriodic(kind, period, templateOf(settings, kind));
  notes.requestBodyFocus(id);
  navigate(notePath(id));
  return id;
}
