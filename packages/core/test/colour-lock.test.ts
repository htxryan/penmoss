import { describe, expect, it } from 'vitest';
import { loadCharacters } from '../src/characters';
import { isColourLocked } from '../src/colour-lock';
import { DEFAULT_SYMBOLS, SYMBOL_GLYPH_PRESETS } from '../src/line-symbols';

describe('isColourLocked', () => {
  it('locks an emoji drawn as emoji', () => {
    for (const glyph of ['💡', '⭐', '✅', '🔥', '⚡', '❌', '🟢', '⌛']) {
      expect(isColourLocked(glyph), glyph).toBe(true);
    }
  });

  it('locks a sequence: a flag, a skin tone, a family, a keycap', () => {
    for (const glyph of ['🇬🇧', '👍🏽', '👨‍👩‍👧‍👦', '#️⃣', '🏳️‍🌈']) {
      expect(isColourLocked(glyph), glyph).toBe(true);
    }
  });

  it('locks a text symbol given the emoji selector', () => {
    for (const glyph of ['❤️', '☀️', '✔️', '⚠️', '©️', '↔️']) {
      expect(isColourLocked(glyph), glyph).toBe(true);
    }
  });

  it('leaves letters, digits, plain symbols and text-presented emoji to take a colour', () => {
    for (const glyph of [
      'A',
      'p',
      '7',
      '#',
      '★',
      '?',
      '!',
      '→',
      '✓',
      '✔',
      '❤',
      '☀',
      '⚠',
      '•',
      '§',
    ]) {
      expect(isColourLocked(glyph), glyph).toBe(false);
    }
    // The text selector asks for the plain glyph.
    expect(isColourLocked('\u231A\uFE0E')).toBe(false);
    // A selector alone is no emoji.
    expect(isColourLocked('\uFE0F')).toBe(false);
    expect(isColourLocked('')).toBe(false);
  });

  it('leaves a Lucide icon, which is drawn in one colour, to take one', () => {
    expect(isColourLocked('lucide:star')).toBe(false);
  });

  it('says which of the default symbols and the presets are emoji: the presets’ last row', () => {
    expect(
      DEFAULT_SYMBOLS.filter((symbol) => isColourLocked(symbol.glyph)).map((s) => s.glyph),
    ).toEqual(['💡']);
    expect(SYMBOL_GLYPH_PRESETS.filter(isColourLocked)).toEqual(SYMBOL_GLYPH_PRESETS.slice(30));
  });

  it('locks every Character outside Symbols, which are all emoji', async () => {
    const characters = await loadCharacters();
    const unlocked = characters.filter(
      (each) => each.group !== 'Symbols' && !isColourLocked(each.glyph),
    );
    expect(unlocked.map((each) => each.glyph)).toEqual([]);
  });
});
