/**
 * The tooltip of a note's row in the tagged-notes list (T42, #104 item 4, A573): what the row
 * does not already say, which is where the note is. The folder tree shows that, so its rows have
 * no tooltip at all: the time a note was last edited covered the rows below it (Ryan's feedback
 * of 6 Nov 2026, Quanta 2, A1119).
 */
export function noteRowTip(folders: readonly string[]): string {
  return folders.length > 0 ? folders.join(' / ') : 'Top level';
}
