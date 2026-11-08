import { cutUnits, stripInvisible } from './invisible';

/**
 * A note's title inside our own words (A855, #170 F11): Touch ID's and BiometricPrompt's
 * prompts, and the toasts that name a note. A title is anyone's text (a repository's, an
 * agent's), so control and format characters (bidi overrides and isolates, zero-width ones) and
 * the line and paragraph separators become spaces (emoji sequences kept whole, `stripInvisible`), brackets and double-quote look-alikes go, and
 * what is left is isolated (U+2068…U+2069) so right-to-left letters in it cannot reorder the
 * words around it. Null when nothing is left.
 */
export function isolatedTitle(title: string | null | undefined, max = 60): string | null {
  const clean = cleanTitle(title, max);
  return clean === null ? null : `\u2068${clean}\u2069`;
}

/** The same, without the isolating marks: HTML isolates it with `<bdi>` instead. */
export function cleanTitle(title: string | null | undefined, max = 60): string | null {
  // Emoji sequences stay whole (their joiners and a flag's tags, #174 review).
  const clean = stripInvisible(title ?? '', ' ')
    .replace(/\p{Cc}+/gu, ' ')
    .replace(/["“”„‟«»＂❝❞〝〞〟″‴‶‷[\]［］【】〔〕]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  if (!clean) return null;
  // Never half of a surrogate pair (#174 review).
  return clean.length > max ? `${cutUnits(clean, max - 1)}…` : clean;
}
