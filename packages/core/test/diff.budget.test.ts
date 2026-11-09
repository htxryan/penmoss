// A wall-clock budget (A1244): `task budgets` runs it, never
// `task check`. What the diff finds is a unit test (diff.test.ts).
import { describe, expect, it } from 'vitest';
import { hunks } from '../src/diff';

describe('hunks', () => {
  it('is fast on a long note with one change', () => {
    const long = Array.from({ length: 20_000 }, (_, i) => `line ${i}`);
    const changed = [...long];
    changed[10_000] = 'changed';
    const started = performance.now();
    expect(hunks(long, changed)).toEqual([{ start: 10_000, end: 10_001, lines: ['changed'] }]);
    expect(performance.now() - started).toBeLessThan(200);
  });
});
