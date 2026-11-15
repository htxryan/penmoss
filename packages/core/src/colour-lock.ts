/**
 * Glyphs that come in their own colours (A1588): an emoji drawn as emoji (💡, ✅, 🇬🇧, ❤️) is a
 * picture with its own colours, so a colour chosen for it would not show. Settings offers no
 * colour for one (it says so instead), keeps the colour it had for when the glyph changes back
 * to one that takes a colour, and nothing draws it in that colour.
 *
 * A glyph is colour-locked when it holds a character Unicode draws as emoji by default
 * (`Emoji_Presentation`) that is not followed by the text selector (U+FE0E), or the emoji
 * selector (U+FE0F) after its first character (❤️, ☀️, #️⃣). A letter, a digit, a plain symbol
 * (★, →, ✓, ❤ without the selector) and a Lucide icon take a colour.
 *
 * Android's `ColourLock` is held to this by `contract/colour-lock-v1.json`, which holds the
 * `Emoji_Presentation` ranges this regular expression matches and what it says of every
 * Character, written from here by the editor page's vitest.
 */

const EMOJI_PRESENTATION = /\p{Emoji_Presentation}/u;
const TEXT_SELECTOR = '\uFE0E';
const EMOJI_SELECTOR = '\uFE0F';

/** Whether `point` (one code point) is drawn as emoji by default. */
export const isEmojiPresentation = (point: string): boolean => EMOJI_PRESENTATION.test(point);

/** Whether `glyph` comes in its own colours, so a colour chosen for it would not show. */
export function isColourLocked(glyph: string): boolean {
  const points = [...glyph];
  return points.some((point, at) =>
    point === EMOJI_SELECTOR
      ? at > 0
      : isEmojiPresentation(point) && points[at + 1] !== TEXT_SELECTOR,
  );
}

/** What Settings says in place of the colour, for a glyph that is colour-locked. */
export const COLOUR_LOCKED_NOTE = 'This emoji’s colour can’t be changed.';
