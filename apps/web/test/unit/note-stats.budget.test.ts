// A wall-clock budget (A1244): `task budgets` runs it, never
// `task check`. What the counts are is a unit test (note-stats.test.ts).
import { describe, expect, it } from 'vitest';
import { textStats } from '../../src/notes/stats';

describe('word and character counts', () => {
  it('counts a 10,000-word note quickly', () => {
    const text = 'garden river morning window '.repeat(2500);
    const start = performance.now();
    expect(textStats(text).words).toBe(10_000);
    expect(performance.now() - start).toBeLessThan(50);
  });
});
