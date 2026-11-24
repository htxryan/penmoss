/**
 * Counts in the apps' own words: "1 note", "3 notes", "0 notes". English only: one is singular,
 * every other count (0 included) plural. The number is written as it is (no grouping); a caller
 * that groups it ("1,204 notes") writes it itself and takes the word from `pluralise`.
 */

/** `singular` for exactly one, else `plural` (`singular` and an "s" unless given). */
export function pluralise(n: number, singular: string, plural = `${singular}s`): string {
  return n === 1 ? singular : plural;
}

/** The count and its word: `counted(3, 'note')` is "3 notes", `counted(1, 'copy', 'copies')` "1 copy". */
export function counted(n: number, singular: string, plural?: string): string {
  return `${n} ${pluralise(n, singular, plural)}`;
}
