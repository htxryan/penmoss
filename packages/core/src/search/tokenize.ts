/**
 * Full-text tokens exactly as D1's FTS5 makes them (T22): `notes_fts` uses
 * `porter unicode61 remove_diacritics 2`, and the client's offline index
 * must cut, fold and stem text the same way, or a word would find other
 * notes offline than online.
 *
 * unicode61 splits on the separators of its Unicode 6.1 tables and folds
 * each character on its own (case, then diacritics); `unicode-table.ts` holds
 * every place where that differs from `defaultFold`, read from SQLite itself
 * (test/search-tokens.node.test.ts checks every code point). The porter step
 * is Martin Porter's algorithm (the `stemmer` package, which matches SQLite's
 * on English prose), run with SQLite's byte semantics: a token is stemmed
 * only when its UTF-8 form is 3 to 64 bytes long, and each byte of a
 * non-ASCII character counts as one consonant.
 */
import { stemmer } from 'stemmer';
import { FOLD_EXCEPTIONS, SEPARATOR_RANGES } from './unicode-table';

export interface Token {
  /** The term as indexed: folded and (unless `stem: false`) stemmed. */
  readonly term: string;
  /** UTF-16 offsets of the token in the text. */
  readonly start: number;
  readonly end: number;
}

/** Separator ranges, flattened: [from0, to0, from1, to1, …], ascending. */
const separators: Uint32Array = (() => {
  if (!SEPARATOR_RANGES) return new Uint32Array();
  const parts = SEPARATOR_RANGES.split(',');
  const out = new Uint32Array(parts.length * 2);
  parts.forEach((part, index) => {
    const [from, to = from] = part.split('-');
    out[index * 2] = parseInt(from!, 36);
    out[index * 2 + 1] = parseInt(to!, 36);
  });
  return out;
})();

const exceptions: ReadonlyMap<number, string> = new Map(
  FOLD_EXCEPTIONS
    ? FOLD_EXCEPTIONS.split(',').map((entry) => {
        const colon = entry.indexOf(':');
        return [parseInt(entry.slice(0, colon), 36), entry.slice(colon + 1)] as const;
      })
    : [],
);

function isSeparator(cp: number): boolean {
  let low = 0;
  let high = separators.length / 2 - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (cp < separators[mid * 2]!) high = mid - 1;
    else if (cp > separators[mid * 2 + 1]!) low = mid + 1;
    else return true;
  }
  return false;
}

const MARK = /\p{M}/u;
const MARKS = /\p{M}+/gu;

/**
 * One character's fold where SQLite's table has no exception: marks vanish,
 * anything else is lower-cased and loses its diacritics.
 */
export function defaultFold(char: string): string {
  if (MARK.test(char)) return '';
  return char.toLowerCase().normalize('NFD').replace(MARKS, '').normalize('NFC');
}

/** Non-ASCII folds, worked out once per character. */
const foldCache = new Map<number, string>();

function foldCodePoint(cp: number): string {
  let folded = foldCache.get(cp);
  if (folded === undefined) {
    folded = exceptions.get(cp) ?? defaultFold(String.fromCodePoint(cp));
    foldCache.set(cp, folded);
  }
  return folded;
}

/** ASCII letters and digits are token characters; every other ASCII character separates. */
function asciiTokenChar(code: number): boolean {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

const PORTER_MIN_BYTES = 3;
const PORTER_MAX_BYTES = 64;
/** Stands in for each UTF-8 byte of a non-ASCII character while stemming: a consonant. */
const BYTE_STANDIN = 'q';

function utf8Length(cp: number): number {
  return cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
}

/**
 * SQLite's porter step on one folded term. Non-ASCII characters are masked
 * as consonant bytes while the suffix rules run (they only ever touch ASCII
 * suffixes), then put back.
 */
export function stemTerm(term: string): string {
  const chars = Array.from(term);
  let masked = '';
  for (const char of chars) {
    const cp = char.codePointAt(0)!;
    masked += cp < 0x80 ? char : BYTE_STANDIN.repeat(utf8Length(cp));
  }
  if (masked.length < PORTER_MIN_BYTES || masked.length > PORTER_MAX_BYTES) return term;
  if (masked === term) return stemmer(term);
  const stemmed = stemmer(masked);
  let common = 0;
  while (common < stemmed.length && stemmed[common] === masked[common]) common++;
  // Map the unchanged prefix back to the original characters.
  let out = '';
  let used = 0;
  for (const char of chars) {
    const cp = char.codePointAt(0)!;
    const width = cp < 0x80 ? 1 : utf8Length(cp);
    if (used + width > common) break;
    out += char;
    used += width;
  }
  return out + stemmed.slice(used);
}

/**
 * The tokens of `text`, with their offsets. `stem: false` gives unicode61's
 * folded tokens without the porter step.
 */
export function tokenize(text: string, options: { readonly stem?: boolean } = {}): Token[] {
  const stem = options.stem ?? true;
  const tokens: Token[] = [];
  let term = '';
  let start = -1;
  const flush = (end: number) => {
    if (start !== -1 && term) tokens.push({ term: stem ? stemTerm(term) : term, start, end });
    term = '';
    start = -1;
  };
  for (let i = 0; i < text.length;) {
    const code = text.charCodeAt(i);
    if (code < 0x80) {
      if (asciiTokenChar(code)) {
        if (start === -1) start = i;
        term += code <= 90 && code >= 65 ? String.fromCharCode(code + 32) : text[i];
      } else flush(i);
      i++;
      continue;
    }
    const cp = text.codePointAt(i)!;
    const width = cp > 0xffff ? 2 : 1;
    if (isSeparator(cp)) flush(i);
    else {
      if (start === -1) start = i;
      term += foldCodePoint(cp);
    }
    i += width;
  }
  flush(text.length);
  return tokens;
}

/** Just the terms of `text`. */
export function terms(text: string): string[] {
  return tokenize(text).map((token) => token.term);
}
