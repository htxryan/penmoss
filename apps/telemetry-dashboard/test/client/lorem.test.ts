// Lorem ipsum for the replay (PEN-178): exactly the length asked, the same text for the same seed,
// and a longer length only adds to the end.
import { describe, expect, it } from 'vitest';
import { MAX_DRAWN, loremOf } from '../../src/client/replay/lorem';

describe('loremOf', () => {
  it('is exactly the length asked', () => {
    for (const length of [0, 1, 2, 7, 31, 182, 1000]) {
      expect(loremOf('note:1', length)).toHaveLength(length);
    }
    expect(loremOf('note:1', -4)).toBe('');
  });

  it('is the same for the same seed, and differs between seeds', () => {
    expect(loremOf('a1b2:3', 120)).toBe(loremOf('a1b2:3', 120));
    expect(loremOf('a1b2:3', 120)).not.toBe(loremOf('a1b2:4', 120));
  });

  it('keeps its first words as it grows and loses its last as it shrinks', () => {
    const long = loremOf('grow', 300);
    for (const length of [10, 44, 45, 299])
      expect(long.startsWith(loremOf('grow', length))).toBe(true);
  });

  it('is lower-case words from the lorem ipsum list, never anything typed', () => {
    expect(loremOf('words', 400)).toMatch(/^[a-z ,.]+$/);
  });

  it('draws at most MAX_DRAWN characters of a huge block', () => {
    expect(loremOf('huge', 1_000_000)).toHaveLength(MAX_DRAWN);
  });
});
