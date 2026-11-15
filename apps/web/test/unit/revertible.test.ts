import { describe, expect, it } from 'vitest';
import { revertible } from '../../src/history/revertible';

describe('which versions offer Revert (T42, N7, A574, A1575)', () => {
  it('offers it on every writer’s edit: an agent’s, this Mac’s, a phone’s (A1575)', () => {
    expect(revertible({ summary: 'Appended · +2 lines' })).toBe(true);
    expect(revertible({ summary: '+1 −1 line' })).toBe(true);
    expect(revertible({ summary: '' })).toBe(true);
  });

  it('not on a move to Trash or a restore from it: Trash undoes those', () => {
    expect(revertible({ summary: 'Moved to Trash' })).toBe(false);
    expect(revertible({ summary: 'Restored from Trash' })).toBe(false);
    expect(revertible({ summary: ' Moved to Trash ' })).toBe(false);
  });
});
