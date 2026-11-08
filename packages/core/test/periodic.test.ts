import { describe, expect, it } from 'vitest';
import { isUlid, ulidTime } from '../src/ids';
import {
  addDays,
  addWeeks,
  dailyNotePath,
  DEFAULT_DAILY_TEMPLATE,
  DEFAULT_TIME_ZONE,
  DEFAULT_WEEKLY_TEMPLATE,
  fillTemplate,
  isoWeek,
  isoWeekday,
  isTimeZone,
  journalFolderId,
  parseIsoWeek,
  parsePlainDate,
  periodicNoteId,
  plainDate,
  periodicClientId,
  todayIn,
  weekDays,
  weeklyNotePath,
  weekMonday,
  weeksInYear,
} from '../src/periodic';

describe('plainDate', () => {
  it('formats as an ISO calendar date', () => {
    expect(plainDate(2026, 10, 22).toString()).toBe('2026-10-22');
  });

  it('zero-pads single-digit months and days', () => {
    expect(plainDate(2027, 1, 5).toString()).toBe('2027-01-05');
  });

  it('accepts 29 February in a leap year', () => {
    expect(plainDate(2028, 2, 29).toString()).toBe('2028-02-29');
  });

  it('applies Gregorian leap rules to two-digit years', () => {
    expect(plainDate(0, 2, 29).toString()).toBe('0000-02-29');
  });

  it.each([
    [2026, 2, 29],
    [2026, 4, 31],
    [2026, 13, 1],
    [2026, 0, 10],
    [2026, 6, 0],
    [2026, 6, 1.5],
    [-1, 6, 1],
    [10000, 1, 1],
  ])('rejects the invalid date %i-%i-%i', (year, month, day) => {
    expect(() => plainDate(year, month, day)).toThrow(RangeError);
  });
});

describe('dailyNotePath', () => {
  it('files a daily note under Journal/<year>/<month>/', () => {
    expect(dailyNotePath(plainDate(2026, 10, 22))).toBe('Journal/2026/10/2026-10-22.md');
  });

  it('zero-pads the month folder', () => {
    expect(dailyNotePath(plainDate(2027, 3, 9))).toBe('Journal/2027/03/2027-03-09.md');
  });
});

describe('dates and ISO weeks (T19)', () => {
  it('parses and steps through dates, across months and leap days', () => {
    expect(parsePlainDate('2028-02-28')?.toString()).toBe('2028-02-28');
    expect(parsePlainDate('2026-02-29')).toBeNull();
    expect(parsePlainDate('2026-1-5')).toBeNull();
    expect(addDays(plainDate(2028, 2, 28), 1).toString()).toBe('2028-02-29');
    expect(addDays(plainDate(2026, 1, 1), -1).toString()).toBe('2025-12-31');
    expect(isoWeekday(plainDate(2026, 10, 21))).toBe(3);
    expect(isoWeekday(plainDate(2026, 10, 25))).toBe(7);
  });

  it.each([
    ['2026-10-21', '2026-W43'],
    ['2026-01-01', '2026-W01'],
    ['2021-01-03', '2020-W53'],
    ['2024-12-30', '2025-W01'],
    ['2027-01-01', '2026-W53'],
  ])('puts %s in %s', (date, week) => {
    expect(isoWeek(parsePlainDate(date)!).toString()).toBe(week);
  });

  it("knows each week's days and neighbours", () => {
    const week = parseIsoWeek('2026-W43')!;
    expect(weekMonday(week).toString()).toBe('2026-10-19');
    expect(weekDays(week).map(String)).toEqual([
      '2026-10-19',
      '2026-10-20',
      '2026-10-21',
      '2026-10-22',
      '2026-10-23',
      '2026-10-24',
      '2026-10-25',
    ]);
    expect(addWeeks(parseIsoWeek('2026-W53')!, 1).toString()).toBe('2027-W01');
    expect(addWeeks(parseIsoWeek('2027-W01')!, -1).toString()).toBe('2026-W53');
    expect(weeksInYear(2026)).toBe(53);
    expect(weeksInYear(2027)).toBe(52);
    expect(parseIsoWeek('2027-W53')).toBeNull();
  });

  it('files weekly notes under Journal/<year>/Weekly', () => {
    expect(weeklyNotePath(parseIsoWeek('2026-W43')!)).toBe('Journal/2026/Weekly/2026-W43.md');
  });

  it("reads today in the settings time zone, not the device's", () => {
    // 03:30 UTC on 22 October is still the 21st in Chicago, already the 22nd in Tokyo.
    const now = new Date('2026-10-22T03:30:00Z');
    expect(todayIn('America/Chicago', now).toString()).toBe('2026-10-21');
    expect(todayIn('Asia/Tokyo', now).toString()).toBe('2026-10-22');
    expect(isTimeZone('America/Chicago')).toBe(true);
    expect(isTimeZone('Mars/Olympus')).toBe(false);
    expect(DEFAULT_TIME_ZONE).toBe('America/Chicago');
  });
});

describe('periodic note ids and templates (T19, A4)', () => {
  it('gives a period the same ULID-shaped id everywhere, sorted by its start', () => {
    const day = periodicNoteId('daily', '2026-10-21');
    expect(isUlid(day)).toBe(true);
    expect(periodicNoteId('daily', '2026-10-21')).toBe(day);
    expect(ulidTime(day)).toBe(Date.UTC(2026, 9, 21));
    expect(periodicNoteId('daily', '2026-10-22')).not.toBe(day);
    const week = periodicNoteId('weekly', '2026-W43');
    expect(ulidTime(week)).toBe(Date.UTC(2026, 9, 19));
    expect(week).not.toBe(periodicNoteId('daily', '2026-10-19'));
    expect(() => periodicNoteId('daily', '2026-W43')).toThrow(RangeError);
    expect(isUlid(journalFolderId('Journal/2026/10'))).toBe(true);
    expect(journalFolderId('Journal/2026/10')).not.toBe(journalFolderId('Journal/2026/11'));
  });

  it('fills templates from the period only', () => {
    expect(
      fillTemplate('# {{longDate}}\n{{weekday}} of {{week}}, {{ unknown }}', 'daily', '2026-10-21'),
    ).toBe('# Wednesday 21 October 2026\nWednesday of 2026-W43, {{ unknown }}');
    expect(fillTemplate('{{week}} starts {{date}}', 'weekly', '2026-W43')).toBe(
      '2026-W43 starts 2026-10-19',
    );
  });

  it('derives a client id from the period and the content it creates', () => {
    const content = new TextEncoder().encode(DEFAULT_DAILY_TEMPLATE);
    const id = periodicClientId('daily', '2026-10-21', content);
    expect(id).toBe(periodicClientId('daily', '2026-10-21', content.slice()));
    expect(id).toBeGreaterThan(0);
    expect(id).toBeLessThan(2 ** 31);
    expect(periodicClientId('daily', '2026-10-22', content)).not.toBe(id);
    expect(periodicClientId('weekly', '2026-10-21', content)).not.toBe(id);
    const other = new TextEncoder().encode(DEFAULT_WEEKLY_TEMPLATE);
    expect(periodicClientId('daily', '2026-10-21', other)).not.toBe(id);
    // One byte of difference is enough.
    const changed = content.slice();
    changed[3] = changed[3]! ^ 1;
    expect(periodicClientId('daily', '2026-10-21', changed)).not.toBe(id);
  });

  it("salts a git notebook's ids so they are its own, and leaves unsalted ids alone (T50, A820)", () => {
    const salt = '01JBNOTEBOOK00000000000001';
    const day = periodicNoteId('daily', '2026-10-21', salt);
    expect(isUlid(day)).toBe(true);
    expect(ulidTime(day)).toBe(Date.UTC(2026, 9, 21));
    expect(day).toBe(periodicNoteId('daily', '2026-10-21', salt));
    expect(day).not.toBe(periodicNoteId('daily', '2026-10-21'));
    expect(day).not.toBe(periodicNoteId('daily', '2026-10-21', '01JBNOTEBOOK00000000000002'));
    expect(journalFolderId('Journal/2026/10', salt)).not.toBe(journalFolderId('Journal/2026/10'));
    const content = new TextEncoder().encode(DEFAULT_DAILY_TEMPLATE);
    expect(periodicClientId('daily', '2026-10-21', content, salt)).not.toBe(
      periodicClientId('daily', '2026-10-21', content),
    );
    // The unsalted ids are the server workspace's, pinned (every client derives them).
    expect(periodicNoteId('daily', '2026-10-21')).toBe('01M5DW3X00VN8989KS18X4ENCJ');
    expect(journalFolderId('Journal/2026/10')).toBe('0000000000W0FMBFGYJBDC9DN6');
    expect(periodicClientId('daily', '2026-10-21', content)).toBe(1951169462);
  });

  it('takes an empty salt as none: the imported notebook keeps the workspace ids (T56, A1021)', () => {
    const content = new TextEncoder().encode(DEFAULT_DAILY_TEMPLATE);
    expect(periodicNoteId('daily', '2026-10-21', '')).toBe('01M5DW3X00VN8989KS18X4ENCJ');
    expect(periodicNoteId('weekly', '2026-W43', '')).toBe(periodicNoteId('weekly', '2026-W43'));
    expect(journalFolderId('Journal/2026/10', '')).toBe('0000000000W0FMBFGYJBDC9DN6');
    expect(periodicClientId('daily', '2026-10-21', content, '')).toBe(1951169462);
    // A day deleted for good there takes the next salt, as in any git notebook: its own id.
    expect(periodicNoteId('daily', '2026-10-21', '#2')).not.toBe(
      periodicNoteId('daily', '2026-10-21'),
    );
  });
});
