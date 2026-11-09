import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { diffLines, hunks, merge3, splitLines } from '../src/diff';

/** Applies an edit script's additions to rebuild the second text. */
const after = (ops: ReturnType<typeof diffLines>) =>
  ops.filter((op) => op.op !== 'del').map((op) => op.line);
const before = (ops: ReturnType<typeof diffLines>) =>
  ops.filter((op) => op.op !== 'add').map((op) => op.line);

const lines = fc.array(fc.constantFrom('a', 'b', 'c', 'd', '', '# h'), { maxLength: 14 });

describe('diffLines (T21)', () => {
  it('finds the shortest edit', () => {
    expect(diffLines(['a', 'b', 'c'], ['a', 'x', 'c'])).toEqual([
      { op: 'same', line: 'a' },
      { op: 'del', line: 'b' },
      { op: 'add', line: 'x' },
      { op: 'same', line: 'c' },
    ]);
    expect(diffLines([], ['a'])).toEqual([{ op: 'add', line: 'a' }]);
    expect(diffLines(['a'], [])).toEqual([{ op: 'del', line: 'a' }]);
    expect(diffLines(['a', 'b'], ['a', 'b'])).toEqual([
      { op: 'same', line: 'a' },
      { op: 'same', line: 'b' },
    ]);
  });

  it('always rebuilds both sides, with as many kept lines as the longest common subsequence', () => {
    const lcs = (a: string[], b: string[]) => {
      const t = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
      for (let i = a.length - 1; i >= 0; i--) {
        for (let j = b.length - 1; j >= 0; j--) {
          t[i]![j] = a[i] === b[j] ? t[i + 1]![j + 1]! + 1 : Math.max(t[i + 1]![j]!, t[i]![j + 1]!);
        }
      }
      return t[0]![0]!;
    };
    fc.assert(
      fc.property(lines, lines, (a, b) => {
        const ops = diffLines(a, b);
        expect(before(ops)).toEqual(a);
        expect(after(ops)).toEqual(b);
        expect(ops.filter((op) => op.op === 'same')).toHaveLength(lcs(a, b));
      }),
    );
  });

  it('finds the one change in a long note (its time is a budget: diff.budget.test.ts)', () => {
    const long = Array.from({ length: 20_000 }, (_, i) => `line ${i}`);
    const changed = [...long];
    changed[10_000] = 'changed';
    expect(hunks(long, changed)).toEqual([{ start: 10_000, end: 10_001, lines: ['changed'] }]);
  });
});

describe('merge3 (T21, A3)', () => {
  it('applies non-overlapping changes from both sides', () => {
    const base = ['intro', 'one', 'two', 'three', 'end'];
    const ours = ['intro', 'one (human)', 'two', 'three', 'end'];
    const theirs = ['intro', 'one', 'two', 'three (undone)', 'end'];
    expect(merge3(base, ours, theirs)).toEqual({
      lines: ['intro', 'one (human)', 'two', 'three (undone)', 'end'],
      conflicts: [],
    });
  });

  it('keeps ours and reports a conflict where both changed the same lines', () => {
    const base = ['a', 'agent wrote this', 'c'];
    const ours = ['a', 'human edited the agent text', 'c'];
    const theirs = ['a', 'c'];
    expect(merge3(base, ours, theirs)).toEqual({
      lines: ['a', 'human edited the agent text', 'c'],
      conflicts: [
        {
          at: 1,
          base: ['agent wrote this'],
          ours: ['human edited the agent text'],
          theirs: [],
        },
      ],
    });
  });

  it('treats two insertions at the same place as a conflict unless they are equal', () => {
    expect(merge3(['a', 'b'], ['a', 'x', 'b'], ['a', 'y', 'b']).conflicts).toHaveLength(1);
    expect(merge3(['a', 'b'], ['a', 'x', 'b'], ['a', 'x', 'b'])).toEqual({
      lines: ['a', 'x', 'b'],
      conflicts: [],
    });
  });

  it('returns one side when the other did not change, and never conflicts with itself', () => {
    fc.assert(
      fc.property(lines, lines, (base, other) => {
        expect(merge3(base, other, base)).toEqual({ lines: other, conflicts: [] });
        expect(merge3(base, base, other)).toEqual({ lines: other, conflicts: [] });
        expect(merge3(base, other, other)).toEqual({ lines: other, conflicts: [] });
      }),
    );
  });

  it('splits text into lines without a phantom last line', () => {
    expect(splitLines('')).toEqual([]);
    expect(splitLines('a\nb\n')).toEqual(['a', 'b']);
    expect(splitLines('a\n\nb')).toEqual(['a', '', 'b']);
  });
});
