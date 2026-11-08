/**
 * Word and character counts for the status bar and the Info panel (T41,
 * A505), shared by the web app and the Android editor page (T40 P8, NT24).
 * Counted from the editor's document after typing pauses, never on the
 * keystroke itself (the T31 typing budget).
 *
 * - A word is a run of letters, digits and marks, joined by an apostrophe,
 *   hyphen or full stop (`don't`, `well-known`, `3.5`); each Han, Hiragana or
 *   Katakana character counts as a word, as those scripts use no spaces.
 * - Characters are Unicode code points, spaces included, line breaks between
 *   blocks not.
 * - Reading time is words at 230 a minute, rounded, and at least a minute.
 */

/** The part of a ProseMirror document the counts read. */
export interface TextDoc {
  readonly content: { readonly size: number };
  textBetween(from: number, to: number, blockSeparator?: string, leafText?: string): string;
}

export interface TextStats {
  readonly words: number;
  readonly characters: number;
  /** Whole minutes to read; 0 for no words. */
  readonly minutes: number;
}

export const WORDS_PER_MINUTE = 230;

const WORD =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]|[\p{L}\p{N}\p{M}]+(?:['’.-][\p{L}\p{N}\p{M}]+)*/gu;

export function textStats(text: string): TextStats {
  let words = 0;
  WORD.lastIndex = 0;
  while (WORD.exec(text) !== null) words++;
  let characters = 0;
  for (const char of text) if (char !== '\n') characters++;
  const minutes = words === 0 ? 0 : Math.max(1, Math.round(words / WORDS_PER_MINUTE));
  return { words, characters, minutes };
}

/** The text of `doc` between two positions (the whole body by default), blocks on their own lines. */
export function docText(doc: TextDoc, from = 0, to = doc.content.size): string {
  return doc.textBetween(from, to, '\n');
}

const number = new Intl.NumberFormat('en');
const plural = (count: number, one: string, many = `${one}s`) =>
  `${number.format(count)} ${count === 1 ? one : many}`;

/** `1,204 words`, `1 word`. */
export const wordsLabel = (count: number) => plural(count, 'word');
/** `6,780 characters`. */
export const charactersLabel = (count: number) => plural(count, 'character');
/** `5 min read`; empty for no words. */
export const readingLabel = (minutes: number) => (minutes === 0 ? '' : `${minutes} min read`);
