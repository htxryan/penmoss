import { describe, expect, it } from 'vitest';
import { restoredMessage } from '../../src/trash/deleted-folders';

const restored = { restored: true, parentGone: false, notes: 2, skipped: [] };

describe('what restoring a folder from Trash says (T42, A560)', () => {
  it('says where it came back', () => {
    expect(restoredMessage('Work', restored)).toBe('Restored “Work”.');
    expect(restoredMessage('Work', { ...restored, parentGone: true, parentId: 'up' })).toBe(
      'Restored “Work” in the folder above. The folder it was in is gone.',
    );
    expect(restoredMessage('Work', { ...restored, parentGone: true, parentId: null })).toBe(
      'Restored “Work” at the top level. The folder it was in is gone.',
    );
  });

  it('says why it could not come back when Trash no longer knows where it was (A1449)', () => {
    expect(restoredMessage('Work', { ...restored, restored: false, refused: true })).toBe(
      '“Work” can’t be restored: the folder it was in is gone, and Trash no longer knows where that was.',
    );
    expect(restoredMessage('Work', { ...restored, restored: false })).toBe(
      '“Work” is not in Trash any more.',
    );
  });
});
