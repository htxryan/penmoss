import { describe, expect, it } from 'vitest';
import { parseDeletedBy, plainLabel } from '../../src/trash/deleted-by';

describe('who moved a note to Trash (T42, A574)', () => {
  it('reads an agent or a device', () => {
    expect(parseDeletedBy({ label: 'Claude Code', kind: 'agent' })).toEqual({
      label: 'Claude Code',
      kind: 'agent',
    });
    expect(parseDeletedBy({ label: ' Ryan’s Mac ', kind: 'device' })).toEqual({
      label: 'Ryan’s Mac',
      kind: 'device',
    });
  });

  it('names no one for an older server or anything malformed', () => {
    for (const value of [
      undefined,
      null,
      'Claude Code',
      { label: '', kind: 'agent' },
      { label: 'Claude Code' },
      { label: 'Claude Code', kind: 'robot' },
      { label: 7, kind: 'device' },
    ]) {
      expect(parseDeletedBy(value)).toBeUndefined();
    }
  });

  it('keeps ✦ for agents: a name cannot carry it (review N8)', () => {
    expect(plainLabel('Claude ✦')).toBe('Claude');
    expect(plainLabel('Ryan’s ✦ Mac')).toBe('Ryan’s Mac');
    expect(plainLabel('Work laptop')).toBe('Work laptop');
  });
});
