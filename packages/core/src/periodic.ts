/**
 * Daily and weekly notes (T19, D10): calendar dates and ISO weeks without time
 * zones, journal paths (`Journal/2026/10/2026-10-21.md`,
 * `Journal/2026/Weekly/2026-W43.md`), templates, and the ids that make two
 * devices creating the same day's note offline create one note (A4).
 */
import { FNV_BASIS, fnv1a } from './fnv';

/** A calendar date with no time or zone, shaped like `Temporal.PlainDate`. */
export interface PlainDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  toString(): string;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

function daysInMonth(year: number, month: number): number {
  return month === 2 && isLeapYear(year) ? 29 : (DAYS_IN_MONTH[month - 1] ?? 0);
}

/** Creates a validated calendar date; throws `RangeError` for impossible dates. */
export function plainDate(year: number, month: number, day: number): PlainDate {
  const valid =
    Number.isInteger(year) &&
    Number.isInteger(month) &&
    Number.isInteger(day) &&
    year >= 0 &&
    year <= 9999 &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth(year, month);
  if (!valid) {
    throw new RangeError(`Invalid calendar date: ${year}-${month}-${day}`);
  }
  const iso = `${String(year).padStart(4, '0')}-${pad2(month)}-${pad2(day)}`;
  return Object.freeze({ year, month, day, toString: () => iso });
}

/** `2026-10-21` → a PlainDate, or null when it is not a valid ISO calendar date. */
export function parsePlainDate(text: string): PlainDate | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return null;
  try {
    return plainDate(Number(match[1]), Number(match[2]), Number(match[3]));
  } catch {
    return null;
  }
}

/** Days since 1970-01-01 (proleptic Gregorian), for date arithmetic without time zones. */
function epochDay(date: PlainDate): number {
  return Math.floor(Date.UTC(date.year, date.month - 1, date.day) / 86_400_000);
}

function fromEpochDay(days: number): PlainDate {
  const at = new Date(days * 86_400_000);
  return plainDate(at.getUTCFullYear(), at.getUTCMonth() + 1, at.getUTCDate());
}

export function addDays(date: PlainDate, days: number): PlainDate {
  return fromEpochDay(epochDay(date) + days);
}

/** ISO weekday: 1 is Monday, 7 is Sunday. */
export function isoWeekday(date: PlainDate): number {
  // 1970-01-01 was a Thursday (4).
  return ((((epochDay(date) + 3) % 7) + 7) % 7) + 1;
}

/** An ISO 8601 week (`2026-W43`): weeks start on Monday, week 1 holds the year's first Thursday. */
export interface IsoWeek {
  readonly year: number;
  readonly week: number;
  toString(): string;
}

function isoWeekOf(year: number, week: number): IsoWeek {
  const text = `${String(year).padStart(4, '0')}-W${pad2(week)}`;
  return Object.freeze({ year, week, toString: () => text });
}

/** The ISO week a date falls in (its year may differ from the date's near New Year). */
export function isoWeek(date: PlainDate): IsoWeek {
  const thursday = addDays(date, 4 - isoWeekday(date));
  const firstDay = epochDay(plainDate(thursday.year, 1, 1));
  return isoWeekOf(thursday.year, Math.floor((epochDay(thursday) - firstDay) / 7) + 1);
}

/** 52 or 53. */
export function weeksInYear(year: number): number {
  return isoWeek(plainDate(year, 12, 28)).week;
}

/** `2026-W43` → an IsoWeek, or null. */
export function parseIsoWeek(text: string): IsoWeek | null {
  const match = /^(\d{4})-W(\d{2})$/.exec(text);
  if (!match) return null;
  const year = Number(match[1]);
  const week = Number(match[2]);
  if (week < 1 || week > weeksInYear(year)) return null;
  return isoWeekOf(year, week);
}

/** The Monday of an ISO week. */
export function weekMonday(week: IsoWeek): PlainDate {
  const jan4 = plainDate(week.year, 1, 4);
  return addDays(jan4, 1 - isoWeekday(jan4) + (week.week - 1) * 7);
}

/** Monday to Sunday of an ISO week. */
export function weekDays(week: IsoWeek): PlainDate[] {
  const monday = weekMonday(week);
  return [0, 1, 2, 3, 4, 5, 6].map((offset) => addDays(monday, offset));
}

export function addWeeks(week: IsoWeek, weeks: number): IsoWeek {
  return isoWeek(addDays(weekMonday(week), weeks * 7));
}

/** The calendar date at `now` in an IANA time zone (`America/Chicago`). */
export function todayIn(timeZone: string, now: Date = new Date()): PlainDate {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const part = (type: string) => Number(parts.find((entry) => entry.type === type)?.value);
  return plainDate(part('year'), part('month'), part('day'));
}

/**
 * The instant a calendar day starts in an IANA time zone, in epoch ms (the Time Machine's ranges,
 * PEN-21): its midnight there, or the first moment after it where a clock change skips midnight.
 */
export function startOfDayIn(date: PlainDate, timeZone: string): number {
  const local = Date.UTC(date.year, date.month - 1, date.day);
  let at = local;
  // The zone's offset near that midnight, found again from the guess so a change that day is met.
  for (let i = 0; i < 3; i++) at = local - offsetAt(at, timeZone);
  return at;
}

/** How far a zone's clock is ahead of UTC at `at`, in ms. */
function offsetAt(at: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(at));
  const part = (type: string) => Number(parts.find((entry) => entry.type === type)?.value);
  const shown = Date.UTC(
    part('year'),
    part('month') - 1,
    part('day'),
    part('hour'),
    part('minute'),
    part('second'),
  );
  return shown - Math.floor(at / 1000) * 1000;
}

/** Whether `timeZone` is an IANA zone this runtime knows. */
export function isTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

export const DEFAULT_TIME_ZONE = 'America/Chicago';

export type PeriodKind = 'daily' | 'weekly';

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** `Wednesday 21 October 2026`, the same everywhere (no locale: A4 needs identical text). */
export function longDate(date: PlainDate): string {
  return `${WEEKDAYS[isoWeekday(date) - 1]} ${date.day} ${MONTHS[date.month - 1]} ${date.year}`;
}

/** The templates until the user sets their own in Settings (markdown, with placeholders). */
export const DEFAULT_DAILY_TEMPLATE = '## Plan\n\n## Notes\n';
export const DEFAULT_WEEKLY_TEMPLATE = '## Goals\n\n## Review\n';

/**
 * A template with its placeholders filled in: `{{date}}` (2026-10-21),
 * `{{longDate}}`, `{{weekday}}`, `{{week}}` (2026-W43), `{{year}}`, `{{month}}`.
 * Only the period goes in, never the time, the device or the time zone, so
 * every device builds the same text (A4). Unknown placeholders stay as typed.
 */
export function fillTemplate(template: string, kind: PeriodKind, period: string): string {
  const date =
    kind === 'daily'
      ? parsePlainDate(period)
      : weekMonday(parseIsoWeek(period) ?? isoWeekOf(1970, 1));
  if (!date) return template;
  const week = kind === 'weekly' ? (parseIsoWeek(period) ?? isoWeek(date)) : isoWeek(date);
  const values: Record<string, string> = {
    date: date.toString(),
    longDate: longDate(date),
    weekday: WEEKDAYS[isoWeekday(date) - 1]!,
    week: week.toString(),
    year: String(kind === 'weekly' ? week.year : date.year),
    month: pad2(date.month),
  };
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (whole, name: string) => values[name] ?? whole);
}

/** 32-bit FNV-1a over UTF-16 code units (or bytes), seeded, for deterministic ids and client ids. */
function seededFnv(input: string | Uint8Array, seed: number): number {
  return fnv1a(input, (FNV_BASIS ^ seed) >>> 0);
}

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A ULID-shaped id from a time and a name: the same on every device (80 bits of hash). */
function deterministicUlid(time: number, name: string): string {
  let out = '';
  for (let rest = time, i = 0; i < 10; i++) {
    out = ALPHABET[rest % 32] + out;
    rest = Math.floor(rest / 32);
  }
  // Four salted 32-bit hashes give 128 bits; 16 characters take 5 bits each.
  const words = [1, 2, 3, 4].map((seed) => seededFnv(name, seed));
  for (let i = 0; i < 16; i++) {
    const word = words[i >> 2]!;
    out += ALPHABET[(word >>> ((i & 3) * 8)) & 31];
  }
  return out;
}

/**
 * The id of the daily note of a date or the weekly note of a week, the same on
 * every device, so two devices that create it offline create one note (A4).
 * It sorts by the period's start (UTC midnight).
 *
 * `salt` is a git notebook's id (T50, A820): its periodic notes and Journal folders are its own,
 * never another notebook's, though all derive them from the same period. Without a salt the ids
 * are the unsalted ones the first workspaces used.
 */
export function periodicNoteId(kind: PeriodKind, period: string, salt?: string): string {
  const start = kind === 'daily' ? parsePlainDate(period) : parseIsoWeek(period);
  if (!start) throw new RangeError(`Not a ${kind} period: ${period}`);
  const date = kind === 'daily' ? (start as PlainDate) : weekMonday(start as IsoWeek);
  return deterministicUlid(
    Date.UTC(date.year, date.month - 1, date.day),
    salted(salt, `${kind}:${period}`),
  );
}

/** The id of a journal folder (`Journal`, `Journal/2026`, `Journal/2026/10`, `Journal/2026/Weekly`). */
export function journalFolderId(path: string, salt?: string): string {
  return deterministicUlid(0, salted(salt, `folder:${path}`));
}

/**
 * The folders a period's note is filed in, outermost first (T19): `Journal`, the year, then the
 * month (`Journal/2026/10`) or `Weekly` (`Journal/2026/Weekly`, the ISO week's year).
 */
export function journalLevels(kind: PeriodKind, period: string): readonly string[] {
  return ['Journal', period.slice(0, 4), kind === 'daily' ? period.slice(5, 7) : 'Weekly'];
}

/**
 * The salt a period's note takes (A828): `salt`, or, when that note was deleted for good, the
 * first of `<salt>#2`, `<salt>#3`, … whose id was not, so every device skips the same purged ids
 * and still agrees on the note. Never capped: each round is a new id and only so many are
 * purged, while a cap would leave a device that reached it on a purged id the others skip.
 */
export function periodicSalt(
  kind: PeriodKind,
  period: string,
  salt: string,
  isPurged: (id: string) => boolean,
): string {
  let each = salt;
  for (let round = 2; isPurged(periodicNoteId(kind, period, each)); round++) {
    each = `${salt}#${round}`;
  }
  return each;
}

/**
 * `name` under a git notebook's salt (A820); unchanged without one. An empty salt is none: the
 * notebook imported from the personal workspace keeps the workspace's own ids (T56, A1021).
 */
function salted(salt: string | undefined, name: string): string {
  return salt === undefined || salt === '' ? name : `${salt}:${name}`;
}

/**
 * A 31-bit Yjs client id for a periodic note (A4), from the period and the
 * bytes of the update it creates (built once under a fixed client id). Two
 * devices whose builds produce the same note share the id, so their updates
 * are byte-identical; builds whose template, codec, schema or encoding
 * produce anything different get different ids, so Yjs keeps both copies
 * instead of dropping one as already known. A git notebook's `salt` (A820)
 * gives its notes client ids of their own.
 */
export function periodicClientId(
  kind: PeriodKind,
  period: string,
  content: Uint8Array,
  salt?: string,
): number {
  const hash = seededFnv(content, 13);
  // Yjs client ids are 31-bit (as random ones are), never 0.
  return seededFnv(salted(salt, `${kind}:${period}:${hash.toString(16)}`), 11) & 0x7fffffff || 1;
}
