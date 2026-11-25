/**
 * Counts, sizes and times in the apps' own words. Counts: "1 note", "3 notes", "0 notes", "1,204
 * notes". English only: one is singular, every other count (0 included) plural. The number is
 * grouped with commas, as Android's `counted` does (A1683), so a count reads the same on both
 * clients. Sizes (`formatBytes`) and how long ago (`timeAgo`) are written one way everywhere too.
 */

const GROUPED = new Intl.NumberFormat('en-US', { maximumFractionDigits: 20 });

/** `singular` for exactly one, else `plural` (`singular` and an "s" unless given). */
export function pluralise(n: number, singular: string, plural = `${singular}s`): string {
  return n === 1 ? singular : plural;
}

/** The count and its word: `counted(3, 'note')` is "3 notes", `counted(1, 'copy', 'copies')` "1 copy". */
export function counted(n: number, singular: string, plural?: string): string {
  return `${GROUPED.format(n)} ${pluralise(n, singular, plural)}`;
}

/** Sizes, largest last: a size is never written in a unit above terabytes. */
const SIZE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

/**
 * A size for people, in decimal units as Finder and Android's Files show it (1 KB is 1,000
 * bytes): "512 B", "1.5 KB", "20 MB", "1 GB". One decimal under 10, whole numbers from 10, the
 * number grouped as `counted` groups it. Android's `formatBytes` (`ui/common/Sizes.kt`) writes
 * the same, replayed from `apps/android/contract/words-v1.json`.
 */
export function formatBytes(bytes: number): string {
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1000 && unit < SIZE_UNITS.length - 1) {
    value /= 1000;
    unit++;
  }
  let shown = unit === 0 || value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
  // 999,999 bytes rounds to 1,000 KB: say "1 MB" instead.
  if (shown >= 1000 && unit < SIZE_UNITS.length - 1) {
    shown = 1;
    unit++;
  }
  return `${GROUPED.format(shown)} ${SIZE_UNITS[unit]}`;
}

const dayFormat = (timeZone: string | undefined, year: boolean) =>
  new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    ...(year ? { year: 'numeric' } : {}),
    ...(timeZone ? { timeZone } : {}),
  });

const yearOf = (at: number, timeZone: string | undefined) =>
  new Intl.DateTimeFormat('en-US', { year: 'numeric', ...(timeZone ? { timeZone } : {}) }).format(
    at,
  );

/**
 * How long ago `at` was (epoch ms), in the apps' one way of saying it: "just now" under a
 * minute, "2 min ago", "3 h ago" under a day, then the day, "Nov 7", with its year when that is
 * not this year, "Nov 7, 2024". Minutes and hours are whole ones gone by; a time ahead of `now`
 * (another device's clock) is "just now". The day is in `timeZone`, this device's unless given.
 * Android's `timeAgo` (`ui/common/TimeAgo.kt`) writes the same, from `words-v1.json`.
 */
export function timeAgo(at: number, now: number = Date.now(), timeZone?: string): string {
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return dayFormat(timeZone, yearOf(at, timeZone) !== yearOf(now, timeZone)).format(at);
}
