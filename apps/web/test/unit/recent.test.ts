import { describe, expect, it } from 'vitest';
import type { NoteListEntry } from '../../src/notes/list';
import { lastOpenedNote, readOpened, recentNotes, rememberOpened } from '../../src/notes/recent';
import { memoryStorage } from './support/memory-storage';

const note = (id: string, updatedAt: number): NoteListEntry => ({
  id,
  title: id,
  excerpt: '',
  updatedAt,
  unsynced: false,
  tags: [],
});

describe('recent notes (T20)', () => {
  it('orders by the later of opened here and edited anywhere, the open note first', () => {
    const list = [note('A', 100), note('B', 300), note('C', 200), note('D', 50)];
    const opened = new Map([
      ['D', 400],
      ['A', 250],
    ]);
    expect(recentNotes(list, opened, 'C').map((entry) => entry.id)).toEqual(['C', 'D', 'B', 'A']);
    expect(recentNotes(list, opened, null, 2).map((entry) => entry.id)).toEqual(['D', 'B']);
  });

  it('remembers opened notes per device, newest kept', () => {
    const storage = memoryStorage();
    rememberOpened(storage, 'A', 1);
    rememberOpened(storage, 'B', 2);
    rememberOpened(storage, 'A', 3);
    expect([...readOpened(storage)]).toEqual([
      ['A', 3],
      ['B', 2],
    ]);
    storage.setItem('penmoss.recent', 'not json');
    expect(readOpened(storage).size).toBe(0);
  });
});

describe('the last note opened (B13)', () => {
  it('is the newest opened note still in the list, or null', () => {
    const list = [note('A', 100), note('B', 300)];
    // C was opened last but is gone (trashed or deleted elsewhere).
    const opened = new Map([
      ['A', 500],
      ['B', 200],
      ['C', 900],
    ]);
    expect(lastOpenedNote(list, opened)).toBe('A');
    expect(lastOpenedNote(list, new Map())).toBeNull();
    expect(lastOpenedNote([], opened)).toBeNull();
  });
});
