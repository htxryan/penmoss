import { describe, expect, it } from 'vitest';
import { noteRowTip } from '../../src/notes/row-tip';

// T42 item 4 (A573): a tagged note's row says where the note is, which the list does not show;
// not when it was edited (A1119).
describe('noteRowTip', () => {
  it('is the folder path', () => {
    expect(noteRowTip(['Garden', 'Beds'])).toBe('Garden / Beds');
  });

  it('says Top level for a note in no folder', () => {
    expect(noteRowTip([])).toBe('Top level');
  });
});
