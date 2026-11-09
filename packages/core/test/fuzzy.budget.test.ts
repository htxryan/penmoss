// A wall-clock budget (A1244): `task budgets` runs it, never
// `task check`. That the matcher folds each title only once is a unit test (fuzzy.test.ts).
import { describe, expect, it } from 'vitest';
import { FuzzyMatcher } from '../src/fuzzy';

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

  it('keeps a keystroke over 5,000 notes well under a frame', () => {
    const matcher = new FuzzyMatcher();
    const text = (title: string) => title;
    matcher.filter(titles, 'm', text, 8); // Every title folded here, once.
    const queries = ['me', 'mee', 'meet', 'meeti', 'meetin', 'meeting', 'meeting r'];
    const started = performance.now();
    for (const query of queries) matcher.filter(titles, query, text, 8);
    const perKeystroke = (performance.now() - started) / queries.length;
    expect(perKeystroke).toBeLessThan(16);
  });
});
