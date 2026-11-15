/// <reference types="node" />
/**
 * Finding a character by name (A1568, A1569): apps/android/contract/glyph-search-v1.json is
 * `@penmoss/core`'s `findGlyphs` over the Characters (`packages/core/data/characters.json`, which
 * the phone ships too), each query's first results in order, so the Kotlin `GlyphSearch` is held
 * to this build of core's ranking rather than to tests copied from it.
 *
 * After changing `packages/core/src/glyph-search.ts` or the Characters, write the file again:
 * `PENMOSS_WRITE_CONTRACTS=1 pnpm --filter @penmoss/android-editor test glyph-search-contract`.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadCharacters } from '@penmoss/core/characters';
import { findGlyphs } from '@penmoss/core/glyph-search';
import { describe, expect, it } from 'vitest';
import contract from '../../contract/glyph-search-v1.json';

/** By name, by keyword, several words, a pasted glyph with and without its selector, nothing. */
const QUERIES = [
  '',
  'star',
  'Star Outline',
  'arrow',
  'right arrow',
  'light-bulb',
  'idea',
  'heart',
  'flag',
  'check',
  'face smil',
  'favourite',
  'ookm',
  '★',
  '❤️',
  '⸙',
  'zzqqxx',
];

/** How many of each query's results the contract holds. */
const FIRST = 8;

describe('glyph search contract v1', () => {
  it('is core’s findGlyphs over the Characters, the first results of each query in order', async () => {
    const characters = await loadCharacters();
    const expected = {
      version: 1,
      characters: characters.length,
      cases: QUERIES.map((query) => {
        const found = findGlyphs(characters, query);
        return {
          query,
          count: found.length,
          first: found.slice(0, FIRST).map((each) => each.glyph),
        };
      }),
    };
    if (process.env['PENMOSS_WRITE_CONTRACTS']) {
      // Run from the package, as `pnpm --filter` does.
      const file = resolve(process.cwd(), '../contract/glyph-search-v1.json');
      writeFileSync(file, `${JSON.stringify(expected, null, 2)}\n`);
    }
    expect(contract).toEqual(expected);
  });
});
