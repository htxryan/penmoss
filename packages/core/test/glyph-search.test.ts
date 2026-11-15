import { describe, expect, it } from 'vitest';
import { loadCharacters } from '../src/characters';
import { findGlyphs, normaliseQuery, type Findable } from '../src/glyph-search';
import { SYMBOL_GLYPH_PRESETS, glyphKey, glyphProblem } from '../src/line-symbols';

// A few of Lucide's icons as the picker holds them: kebab-case names, tags and aliases.
const ICONS: readonly Findable[] = [
  { name: 'notebook', keywords: ['notepad', 'notes', 'journal'] },
  { name: 'notebook-pen', keywords: ['notepad', 'journal', 'write', 'edit'] },
  { name: 'book-open', keywords: ['reading', 'library', 'journal'] },
  { name: 'star', keywords: ['favourite', 'important', 'bookmark'] },
  { name: 'star-off', keywords: ['unfavourite', 'remove'] },
  { name: 'sparkles', keywords: ['stars', 'magic', 'ai'] },
  { name: 'calendar', keywords: ['date', 'month', 'event'] },
  { name: 'alarm-clock-check', keywords: ['alarm-check', 'done', 'time'] },
];

const names = (found: readonly Findable[]) => found.map((each) => each.name);

describe('findGlyphs', () => {
  it('keeps every item, in order, for an empty query', () => {
    expect(names(findGlyphs(ICONS, ''))).toEqual(names(ICONS));
    expect(names(findGlyphs(ICONS, '   '))).toEqual(names(ICONS));
  });

  it('finds by name, the whole name first, then a name that starts with it', () => {
    expect(names(findGlyphs(ICONS, 'star'))).toEqual(['star', 'star-off', 'sparkles']);
    expect(names(findGlyphs(ICONS, 'notebook'))).toEqual(['notebook', 'notebook-pen']);
  });

  it('finds by a tag or an alias when the name does not have the word', () => {
    expect(names(findGlyphs(ICONS, 'journal'))).toEqual(['notebook', 'notebook-pen', 'book-open']);
    expect(names(findGlyphs(ICONS, 'favourite'))).toEqual(['star', 'star-off']);
    expect(names(findGlyphs(ICONS, 'alarm-check'))).toEqual(['alarm-clock-check']);
  });

  it('ranks a name match over a tag match, and a whole word over the start of one', () => {
    // "book": a word of book-open's name, inside notebook's, a tag of star's.
    expect(names(findGlyphs(ICONS, 'book'))).toEqual([
      'book-open',
      'notebook',
      'notebook-pen',
      'star',
    ]);
  });

  it('needs every word of the query, in any order, hyphens or spaces alike', () => {
    expect(names(findGlyphs(ICONS, 'pen notebook'))).toEqual(['notebook-pen']);
    expect(names(findGlyphs(ICONS, 'Notebook Pen'))).toEqual(['notebook-pen']);
    expect(names(findGlyphs(ICONS, 'notebook_pen'))).toEqual(['notebook-pen']);
    expect(names(findGlyphs(ICONS, 'notebook write'))).toEqual(['notebook-pen']);
  });

  it('finds nothing for a word nothing has', () => {
    expect(findGlyphs(ICONS, 'zebra')).toEqual([]);
    expect(findGlyphs(ICONS, 'star zebra')).toEqual([]);
  });

  it('matches inside a keyword only from three letters', () => {
    expect(names(findGlyphs(ICONS, 'ookm'))).toEqual(['star']);
    expect(findGlyphs(ICONS, 'km')).toEqual([]);
  });

  it('normalises a query', () => {
    expect(normaliseQuery('  Light-Bulb__idea ')).toBe('light bulb idea');
  });
});

describe('the Characters', () => {
  it('are valid glyphs, each once, with a name, the old presets first in their order', async () => {
    const characters = await loadCharacters();
    expect(characters.length).toBeGreaterThan(1500);
    const keys = characters.map((each) => glyphKey(each.glyph));
    expect(new Set(keys).size).toBe(keys.length);
    for (const each of characters) {
      expect(glyphProblem(each.glyph), each.glyph).toBeNull();
      expect(each.name.trim(), each.glyph).not.toBe('');
      expect(each.group, each.glyph).toMatch(/^[A-Z]/);
    }
    expect(characters.slice(0, SYMBOL_GLYPH_PRESETS.length).map((each) => each.glyph)).toEqual(
      SYMBOL_GLYPH_PRESETS,
    );
  });

  it('are found by name, by keyword and by the pasted glyph', async () => {
    const characters = await loadCharacters();
    const glyphs = (query: string) => findGlyphs(characters, query).map((each) => each.glyph);
    expect(glyphs('star')[0]).toBe('★');
    expect(glyphs('idea')).toContain('💡');
    expect(glyphs('light bulb')[0]).toBe('💡');
    expect(glyphs('★')[0]).toBe('★');
    // With or without the emoji presentation selector.
    expect(glyphs('❤️')[0]).toBe('❤');
    expect(glyphs('zzzzqq')).toEqual([]);
  });
});
