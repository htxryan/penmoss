/** UTC days as D1 stores them: YYYY-MM-DD. */

/** The UTC day of `ms` milliseconds since the epoch. */
export function dayOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** The day `n` days after `day` (before, when negative). */
export function addDays(day: string, n: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + n);
  return dayOf(date.getTime());
}

/** The day `n` months before `day`, as SQLite's date(day, '-n months') counts them. */
export function monthsBefore(day: string, n: number): string {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  // JavaScript's Date rolls an overflowing date into the next month, as SQLite does.
  return dayOf(Date.UTC(year, month - 1 - n, date));
}
