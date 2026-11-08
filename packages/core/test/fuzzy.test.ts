import { describe, expect, it, vi } from 'vitest';
import { FuzzyMatcher, fuzzyFilter, fuzzyScore } from '../src/fuzzy';

const titles = [
  'Penmoss — sync design',
  'Penmoss — product brief',
  'Shopping list',
  'Sync benchmarks',
  'Café notes',
  'Weekly review 2026-W43',
];

describe('fuzzy matching', () => {
  it('matches characters in order, ignoring case and accents', () => {
    expect(fuzzyScore('cafe', 'Café notes')).not.toBeNull();
    expect(fuzzyScore('PSD', 'Penmoss — sync design')).not.toBeNull();
    expect(fuzzyScore('zz', 'Penmoss — sync design')).toBeNull();
  });

  it('ranks an exact title, then prefixes and word starts, above scattered matches', () => {
    expect(fuzzyFilter(titles, 'sync', (t) => t)).toEqual([
      'Sync benchmarks',
      'Penmoss — sync design',
    ]);
    expect(fuzzyFilter(titles, 'shopping list', (t) => t)[0]).toBe('Shopping list');
    expect(fuzzyFilter(titles, 'pb', (t) => t)[0]).toBe('Penmoss — product brief');
    expect(fuzzyFilter(titles, 'wr', (t) => t)[0]).toBe('Weekly review 2026-W43');
  });

  it('prefers a later word start only when the rest still matches after it', () => {
    expect(fuzzyScore('bc', 'abc b')).not.toBeNull();
  });

  it('keeps every item for an empty query, in order, up to the limit', () => {
    expect(fuzzyFilter(titles, '', (t) => t, 2)).toEqual(titles.slice(0, 2));
  });
});

describe('a fuzzy matcher (`[[` completion over a large workspace)', () => {
  const words = [
    'Meeting',
    'Garden',
    'Plan',
    'Weekly',
    'Review',
    'Café',
    'Notes',
    'Budget',
    'Trip',
  ];
  const titles = Array.from(
    { length: 5000 },
    (_, i) => `${words[i % 9]} ${words[(i * 7) % 9]} ${i} ${words[(i * 5) % 9]}`,
  );

  it('ranks as fuzzyFilter does', () => {
    const matcher = new FuzzyMatcher();
    for (const query of ['', 'mtg', 'cafe plan', 'zzz', 'Garden 42']) {
      expect(matcher.filter(titles, query, (title) => title, 8)).toEqual(
        fuzzyFilter(titles, query, (title) => title, 8),
      );
    }
  });

  it('folds each title once, so a keystroke over 5,000 notes stays well under a frame', () => {
    const matcher = new FuzzyMatcher();
    const text = (title: string) => title;
    matcher.filter(titles, 'm', text, 8); // Every title folded here, once.
    const normalize = vi.spyOn(String.prototype, 'normalize');
    const queries = ['me', 'mee', 'meet', 'meeti', 'meetin', 'meeting', 'meeting r'];
    const started = performance.now();
    for (const query of queries) matcher.filter(titles, query, text, 8);
    const perKeystroke = (performance.now() - started) / queries.length;
    // Only the queries are folded now, not the titles.
    expect(normalize).toHaveBeenCalledTimes(queries.length);
    normalize.mockRestore();
    expect(perKeystroke).toBeLessThan(16);
  });
});
