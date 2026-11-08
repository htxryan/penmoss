import { describe, expect, it } from 'vitest';
import { kindLabel } from '../../src/notes/kind';

// T42 item 3 (A572): "Kind: Note" told Ryan nothing. Only periodic notes carry a label.
describe('kindLabel', () => {
  it('labels daily and weekly notes', () => {
    expect(kindLabel('daily')).toBe('Daily note');
    expect(kindLabel('weekly')).toBe('Weekly note');
  });

  it('shows nothing for an ordinary note, a missing type or an unknown one', () => {
    expect(kindLabel('note')).toBeNull();
    expect(kindLabel(undefined)).toBeNull();
    expect(kindLabel('recipe')).toBeNull();
    expect(kindLabel(['daily'])).toBeNull();
  });
});
