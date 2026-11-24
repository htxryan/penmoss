/**
 * Counts in the apps' own words: "1 note", "3 notes", "0 notes", "1,204 notes". English only: one
 * is singular, every other count (0 included) plural. The number is grouped with commas, as
 * Android's `counted` does (A1683), so a count reads the same on both clients.
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
