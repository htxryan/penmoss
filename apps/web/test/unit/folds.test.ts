import { describe, expect, it } from 'vitest';
import { FOLDS_PREFIX, MAX_FOLDS_PER_NOTE, localFoldState } from '../../src/notes/folds';
import { memoryStorage } from './support/memory-storage';

describe('localFoldState', () => {
  it('remembers toggles per note and per device', () => {
    const storage = memoryStorage();
    const note = localFoldState('n1', storage);
    expect(note.isOpen('note|Title|0')).toBeUndefined();
    note.setOpen('note|Title|0', false);
    note.setOpen('faq||0', true);
    expect(localFoldState('n1', storage).isOpen('note|Title|0')).toBe(false);
    expect(localFoldState('n1', storage).isOpen('faq||0')).toBe(true);
    expect(localFoldState('n2', storage).isOpen('note|Title|0')).toBeUndefined();
    expect(JSON.parse(storage.data.get(`${FOLDS_PREFIX}n1`)!)).toEqual({
      'note|Title|0': false,
      'faq||0': true,
    });
  });

  it('keeps toggles another tab folded in the same note', () => {
    const storage = memoryStorage();
    const tabA = localFoldState('n1', storage);
    const tabB = localFoldState('n1', storage);
    tabA.setOpen('a', false);
    tabB.setOpen('b', true);
    const reloaded = localFoldState('n1', storage);
    expect([reloaded.isOpen('a'), reloaded.isOpen('b')]).toEqual([false, true]);
  });

  it('caps the toggles kept per note, dropping the oldest', () => {
    const storage = memoryStorage();
    const note = localFoldState('n1', storage);
    for (let i = 0; i <= MAX_FOLDS_PER_NOTE; i += 1) note.setOpen(`t${i}`, true);
    const kept = Object.keys(JSON.parse(storage.data.get(`${FOLDS_PREFIX}n1`)!) as object);
    expect(kept).toHaveLength(MAX_FOLDS_PER_NOTE);
    expect(kept).not.toContain('t0');
    expect(kept.at(-1)).toBe(`t${MAX_FOLDS_PER_NOTE}`);
  });

  it('works without storage, and with corrupt or failing storage', () => {
    const none = localFoldState('n1', null);
    none.setOpen('a', false);
    expect(none.isOpen('a')).toBe(false);

    const corrupt = localFoldState('n1', memoryStorage({ [`${FOLDS_PREFIX}n1`]: '[1,2' }));
    expect(corrupt.isOpen('a')).toBeUndefined();

    const failing = localFoldState('n1', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    });
    failing.setOpen('a', true);
    expect(failing.isOpen('a')).toBe(true);
  });
});
