/// <reference types="node" />
/**
 * Glyphs that come in their own colours (A1588): apps/android/contract/colour-lock-v1.json is
 * `@penmoss/core`'s `isColourLocked`: the `Emoji_Presentation` ranges its regular expression
 * matches, and what it says of every Character and of glyphs typed in (sequences, selectors,
 * letters), so the Kotlin `ColourLock` is held to the web's rule rather than to tests copied
 * from it.
 *
 * After changing `packages/core/src/colour-lock.ts`, the Characters or Node's Unicode, write the
 * file again: `PENMOSS_WRITE_CONTRACTS=1 pnpm --filter @penmoss/android-editor test colour-lock-contract`.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadCharacters } from '@penmoss/core/characters';
import { isColourLocked, isEmojiPresentation } from '@penmoss/core/colour-lock';
import { describe, expect, it } from 'vitest';
import contract from '../../contract/colour-lock-v1.json';

/** Typed glyphs beyond the Characters: selectors, sequences, letters, a Lucide name. */
const TYPED = [
  '',
  'A',
  'ß',
  '7',
  '#',
  '★',
  '❤',
  '\u2764\uFE0F',
  '\u231A',
  '\u231A\uFE0E',
  '\uFE0F',
  '#\uFE0F\u20E3',
  '🇬🇧',
  '👍🏽',
  '👨‍👩‍👧‍👦',
  '🏳️‍🌈',
  '\u2605\uFE0F',
  'lucide:star',
];

/** The code points `isEmojiPresentation` matches, as inclusive ranges. */
function presentationRanges(): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let start = -1;
  for (let point = 0; point <= 0x110000; point++) {
    const yes = point < 0x110000 && isEmojiPresentation(String.fromCodePoint(point));
    if (yes && start < 0) start = point;
    if (!yes && start >= 0) {
      ranges.push([start, point - 1]);
      start = -1;
    }
  }
  return ranges;
}

describe('colour lock contract v1', () => {
  it('is core’s isColourLocked: its emoji ranges, every Character and typed glyphs', async () => {
    const characters = await loadCharacters();
    const glyphs = [...characters.map((each) => each.glyph), ...TYPED];
    const expected = {
      version: 1,
      emojiPresentation: presentationRanges(),
      locked: glyphs.filter(isColourLocked),
      unlocked: glyphs.filter((glyph) => !isColourLocked(glyph)),
    };
    if (process.env['PENMOSS_WRITE_CONTRACTS']) {
      // Run from the package, as `pnpm --filter` does.
      const file = resolve(process.cwd(), '../contract/colour-lock-v1.json');
      writeFileSync(file, `${JSON.stringify(expected, null, 2)}\n`);
    }
    expect(contract).toEqual(expected);
  });
});
