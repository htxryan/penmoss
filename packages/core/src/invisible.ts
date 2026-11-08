/**
 * Invisible characters in names and titles (#170 F11, #174 review). Taken out: the bidi
 * embeddings, overrides, isolates and marks (an override shows `gpj.exe` for `exe.jpg`), the
 * other format characters (zero-width space, word joiner, byte-order mark, soft hyphen, stray
 * tag characters), and the line and paragraph separators. Kept, because they draw something:
 *
 * - the zero-width non-joiner, which Persian and Indic words need;
 * - a zero-width joiner inside an emoji sequence (a family, a skin-toned coder), and nowhere else;
 * - the tag characters of a subdivision flag (the black flag, tags, the cancel tag: Scotland).
 *
 * The Android app's `OwnerWords` keeps the same rules for the names its owner check shows.
 */

/** Emoji ZWJ sequences and subdivision flags: left as they are. */
const KEPT =
  /\u{1F3F4}[\u{E0030}-\u{E0039}\u{E0061}-\u{E007A}]{1,30}\u{E007F}|\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?)+/gu;
/** Format characters but the non-joiner, and the line and paragraph separators. */
const INVISIBLE = /(?!\u200C)[\p{Cf}\u2028\u2029]/gu;

/** `text` with its invisible characters replaced by `by` (removed by default). */
export function stripInvisible(text: string, by = ''): string {
  let out = '';
  let from = 0;
  for (const match of text.matchAll(KEPT)) {
    out += text.slice(from, match.index).replace(INVISIBLE, by) + match[0];
    from = match.index + match[0].length;
  }
  return out + text.slice(from).replace(INVISIBLE, by);
}

/**
 * At most `max` UTF-16 units of `text`, never cutting a surrogate pair (half an emoji or a
 * rare letter would show as a box).
 */
export function cutUnits(text: string, max: number): string {
  if (text.length <= max) return text;
  const code = text.charCodeAt(max - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max);
}
