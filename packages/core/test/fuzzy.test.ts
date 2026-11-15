import { describe, expect, it, vi } from 'vitest';
import { FuzzyMatcher, fuzzyFilter, fuzzyMatch, fuzzyScore, highlightRuns } from '../src/fuzzy';

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

// The palette, Quick Open and the pickers (T20): the same ranking, with where it matched.
describe('a fuzzy match with its positions', () => {
  it('scores as fuzzyScore does, and ranks word starts and runs higher', () => {
    expect(fuzzyMatch('tdy', 'Open today’s note')).not.toBeNull();
    expect(fuzzyMatch('xyz', 'Open today’s note')).toBeNull();
    expect(fuzzyMatch('sync', 'Sync benchmarks')!.score).toBe(
      fuzzyScore('sync', 'Sync benchmarks'),
    );
    const start = fuzzyMatch('new', 'New note')!.score;
    const middle = fuzzyMatch('new', 'Rename the newest')!.score;
    expect(start).toBeGreaterThan(middle);
    expect(fuzzyMatch('', 'New note')).toEqual({ score: 0, indices: [] });
  });

  it('with scattered false, rejects letters scattered across a long title', () => {
    const long = 'a long title that eventually ends';
    expect(fuzzyMatch('ae', long, { scattered: false })).toBeNull();
    expect(fuzzyMatch('ae', long)).not.toBeNull();
    // The query as it is, however far apart its ends.
    expect(fuzzyMatch('a long title', long, { scattered: false })).not.toBeNull();
  });

  it('matches accents and gives the positions in the text as written', () => {
    expect(fuzzyMatch('cafe', 'Café notes')!.indices).toEqual([0, 1, 2, 3]);
    // An accent typed as its own mark: the folded text is shorter, the positions are not.
    const decomposed = 'Café notes';
    expect(fuzzyMatch('n', decomposed)!.indices).toEqual([6]);
    expect(fuzzyMatch('Shopping list', 'Shopping list')!.indices).toHaveLength(12);
  });

  it('splits text into highlighted runs', () => {
    const match = fuzzyMatch('nn', 'New note')!;
    expect(highlightRuns('New note', match.indices)).toEqual([
      { text: 'N', match: true },
      { text: 'ew ', match: false },
      { text: 'n', match: true },
      { text: 'ote', match: false },
    ]);
    // A character outside the BMP stays whole.
    expect(highlightRuns('🌱 bed', fuzzyMatch('b', '🌱 bed')!.indices)).toEqual([
      { text: '🌱 ', match: false },
      { text: 'b', match: true },
      { text: 'ed', match: false },
    ]);
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

  it('folds each title once, then only the queries', () => {
    const matcher = new FuzzyMatcher();
    const text = (title: string) => title;
    matcher.filter(titles, 'm', text, 8); // Every title folded here, once.
    const normalize = vi.spyOn(String.prototype, 'normalize');
    const queries = ['me', 'mee', 'meet', 'meeti', 'meetin', 'meeting', 'meeting r'];
    for (const query of queries) matcher.filter(titles, query, text, 8);
    // Only the queries are folded now, not the titles. The keystroke's cost over 5,000 notes is
    // a budget: fuzzy.budget.test.ts (A1244).
    expect(normalize).toHaveBeenCalledTimes(queries.length);
    normalize.mockRestore();
  });
});
