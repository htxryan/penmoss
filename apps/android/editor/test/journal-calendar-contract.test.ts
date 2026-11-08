/// <reference types="node" />
/**
 * The Journal calendar's dates on the phone (T40 P5, JR3): Kotlin lays out the month grid and
 * names its days with `java.time`, and `apps/android/contract/journal-calendar-v1.json` is what
 * core says for the same months, so the two cannot drift. The months cover a plain month, both
 * US DST changes, and the ISO year edges (a 53-week year either side, a week 1 starting in
 * December). `today` is core's `todayIn` at instants either side of the DST changes in the
 * default zone. The Kotlin `JournalTest` reads the same file. Which period a tap makes is still
 * resolved by the page (A11); these are what the grid shows.
 *
 * After changing core's calendar functions or words, write the file again:
 * `PENMOSS_WRITE_CONTRACTS=1 pnpm --filter @penmoss/android-editor test journal-calendar-contract`.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { addDays, isoWeek, isoWeekday, longDate, plainDate, todayIn } from '@penmoss/core/periodic';
import { describe, expect, it } from 'vitest';
import contract from '../../contract/journal-calendar-v1.json';

const MONTHS: ReadonlyArray<readonly [number, number]> = [
  [2026, 10],
  [2026, 3],
  [2026, 11],
  [2021, 1],
  [2026, 12],
  [2027, 1],
  [2024, 12],
];

// Each side of the midnights before and after both US DST changes in 2026 (an hour moves), and
// a zone ahead of UTC.
const INSTANTS: ReadonlyArray<readonly [string, string]> = [
  ['America/Chicago', '2026-03-08T05:59:00Z'],
  ['America/Chicago', '2026-03-08T06:00:00Z'],
  ['America/Chicago', '2026-03-09T04:59:00Z'],
  ['America/Chicago', '2026-03-09T05:00:00Z'],
  ['America/Chicago', '2026-11-01T04:59:00Z'],
  ['America/Chicago', '2026-11-01T05:00:00Z'],
  ['America/Chicago', '2026-11-02T05:59:00Z'],
  ['America/Chicago', '2026-11-02T06:00:00Z'],
  ['Asia/Tokyo', '2026-10-21T14:59:00Z'],
  ['Asia/Tokyo', '2026-10-21T15:00:00Z'],
];

/** The web's six Monday-first weeks for a month (`Calendar.tsx`'s `monthGrid`), named by core. */
function journalCalendarContract() {
  return {
    version: 1,
    months: MONTHS.map(([year, month]) => {
      const first = plainDate(year, month, 1);
      const start = addDays(first, 1 - isoWeekday(first));
      return {
        year,
        month,
        weeks: [0, 1, 2, 3, 4, 5].map((week) => {
          const days = [0, 1, 2, 3, 4, 5, 6].map((day) => addDays(start, week * 7 + day));
          return {
            period: isoWeek(days[0]!).toString(),
            days: days.map((date) => ({ date: date.toString(), longDate: longDate(date) })),
          };
        }),
      };
    }),
    today: INSTANTS.map(([zone, at]) => ({
      zone,
      at,
      date: todayIn(zone, new Date(at)).toString(),
    })),
  };
}

describe('journal calendar contract v1', () => {
  it('is what core says for each month, week and instant, exactly', () => {
    const expected = journalCalendarContract();
    if (process.env['PENMOSS_WRITE_CONTRACTS']) {
      // Run from the package, as `pnpm --filter` does.
      const file = resolve(process.cwd(), '../contract/journal-calendar-v1.json');
      writeFileSync(file, `${JSON.stringify(expected, null, 2)}\n`);
    }
    expect(contract).toEqual(expected);
  });
});
