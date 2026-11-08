import { describe, expect, it } from 'vitest';
import {
  deletedForGoodText,
  trashAll,
  trashedText,
  trashedTitle,
  undoFailedText,
  undoTrash,
  type Trashed,
} from '../../src/trash/trashed';
import { trashDaysLeft } from '../../src/notes/service';

// T42 review S2: several notes go to Trash, and come back with Undo, each on its own.
const notes = [
  { id: 'a', title: 'Garden plan' },
  { id: 'b', title: 'Shed' },
  { id: 'c', title: 'Pond' },
];

describe('trashAll and undoTrash', () => {
  it('resolves to the notes that reached Trash, and never rejects', async () => {
    const reached = await trashAll(['a', 'b', 'c'], (id) =>
      id === 'b' ? Promise.reject(new Error('Read-only')) : Promise.resolve(),
    );
    expect(reached).toEqual(['a', 'c']);
  });

  it('restores every note that reached Trash, past one that fails, and says how many', async () => {
    const asked: string[] = [];
    const trashed: Pick<Trashed, 'notes' | 'done'> = {
      notes,
      done: Promise.resolve(['a', 'b', 'c']),
    };
    const outcome = await undoTrash(trashed, (id) => {
      asked.push(id);
      return id === 'a' ? Promise.reject(new Error('Gone for good')) : Promise.resolve();
    });
    expect(asked).toEqual(['a', 'b', 'c']);
    expect(outcome.restored).toBe(2);
    expect(outcome.failed).toEqual([{ id: 'a', title: 'Garden plan', message: 'Gone for good' }]);
    expect(undoFailedText(outcome)).toBe('Restored 2 of 3 notes; 1 could not be: Gone for good');
  });

  it('never restores a note that did not reach Trash', async () => {
    const asked: string[] = [];
    const trashed: Pick<Trashed, 'notes' | 'done'> = { notes, done: Promise.resolve(['c']) };
    const outcome = await undoTrash(trashed, (id) => {
      asked.push(id);
      return Promise.resolve();
    });
    expect(asked).toEqual(['c']);
    expect(outcome).toEqual({ restored: 1, failed: [] });
  });

  it('tries a single note whose move failed, and gives its own reason', async () => {
    const trashed: Pick<Trashed, 'notes' | 'done'> = {
      notes: notes.slice(0, 1),
      done: Promise.reject(new Error('x')),
    };
    const outcome = await undoTrash(trashed, () => Promise.reject(new Error('Offline')));
    expect(undoFailedText(outcome)).toBe('Offline');
  });
});

describe('days left in Trash (B9)', () => {
  const DAY = 24 * 60 * 60 * 1000;
  it('counts whole days from deletion, never more than 30 or less than 0', () => {
    const now = Date.UTC(2026, 9, 26, 12);
    expect(trashDaysLeft(now, now)).toBe(30);
    // Deleted after the page read the clock, or by a server a little ahead.
    expect(trashDaysLeft(now + 60_000, now)).toBe(30);
    expect(trashDaysLeft(now - DAY / 2, now)).toBe(30);
    expect(trashDaysLeft(now - DAY - 1, now)).toBe(29);
    expect(trashDaysLeft(now - 31 * DAY, now)).toBe(0);
  });
});

describe('the toast names a note as the prompts do (#170 F11)', () => {
  it('drops bidi and other format characters, brackets and quote look-alikes', () => {
    // The title from Ryan's Mac test, made to read as the words around it.
    const hostile = 'x] (git history keeps it) in the git notebook at github.com/evil [ \u202eאבג';
    const shown = trashedTitle(hostile);
    expect(shown).not.toMatch(/[\u202a-\u202e\u2066-\u2069\u200e\u200f[\]“”"]/u);
    expect(shown).toBe('x (git history keeps it) in the git notebook at github.com/evil אבג');
    expect(trashedTitle('\u202e\u200b ')).toBe('Untitled');
    expect(trashedText(['Plan'])).toBe('Moved “Plan” to Trash');
    expect(trashedText(['a', 'b'])).toBe('Moved 2 notes to Trash');
  });
});

describe('Delete for good says what git keeps (#170 F13)', () => {
  it('in a git notebook, that its git history still keeps the note, the title cleaned and isolated', () => {
    // The same words as Android's (TrashModelTest), and as the Touch ID prompt says it.
    expect(deletedForGoodText('Old\u202e plan [x]', true)).toBe(
      'Deleted “\u2068Old plan x\u2069” for good. The repository’s git history still keeps it.',
    );
    expect(deletedForGoodText('\u202e\u200b ', true)).toBe(
      'Deleted an untitled note for good. The repository’s git history still keeps it.',
    );
    // The server deletes it everywhere: nothing keeps it.
    expect(deletedForGoodText('Old', false)).toBe('Deleted “Old” for good.');
  });
});
