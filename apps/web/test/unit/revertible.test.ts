import { describe, expect, it } from 'vitest';
import { revertible } from '../../src/history/revertible';

const agent = { kind: 'agent' } as const;
const device = { kind: 'device' } as const;

describe('which versions offer Revert (T42, N7, A574)', () => {
  it('offers it on an agent’s edit', () => {
    expect(revertible({ summary: 'Appended · +2 lines', authors: [agent] })).toBe(true);
    expect(revertible({ summary: '', authors: [device, agent] })).toBe(true);
  });

  it('not on edits by devices only', () => {
    expect(revertible({ summary: '', authors: [device] })).toBe(false);
  });

  it('not on an agent moving the note to Trash or restoring it: Trash undoes those', () => {
    expect(revertible({ summary: 'Moved to Trash', authors: [agent] })).toBe(false);
    expect(revertible({ summary: 'Restored from Trash', authors: [agent] })).toBe(false);
  });
});
