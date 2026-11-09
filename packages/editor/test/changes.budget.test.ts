// A wall-clock budget (A1244): `task budgets` runs it, never
// `task check`. What changedRanges covers is a unit test (changes.test.ts).
import { schema } from '@penmoss/core';
import { EditorState } from '@tiptap/pm/state';
import { describe, expect, it } from 'vitest';
import { changedRanges } from '../src/extensions/changes';

describe('changedRanges', () => {
  it('stays linear in the number of steps', () => {
    const doc = schema.node('doc', null, [
      schema.node('paragraph', null, [schema.text('start')]),
      schema.node('paragraph', null, [schema.text('end')]),
    ]);
    const tr = EditorState.create({ doc }).tr;
    for (let i = 0; i < 20_000; i += 1) tr.insertText('x', 3 + i);
    const started = performance.now();
    const ranges = changedRanges([tr]);
    expect(performance.now() - started).toBeLessThan(250);
    expect(ranges.some(([a, b]) => a <= 3 && 20_003 <= b)).toBe(true);
  });
});
