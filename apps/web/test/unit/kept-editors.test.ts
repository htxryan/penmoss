import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NoteDirectory } from '../../src/notes/directory';
import {
  KEEP,
  dropEditor,
  keepEditor,
  keptNotes,
  takeEditor,
  viewMounted,
  type NoteEditor,
} from '../../src/notes/kept-editors';
import type { Notes } from '../../src/notes/service';

const deleted = new Set<object>();
vi.mock('@penmoss/sync-client/note', () => ({ isDeleted: (doc: object) => deleted.has(doc) }));

/** A source's notes: only their identity matters to the kept editors. */
function fakeNotes() {
  return { notes: {} as unknown as Notes };
}

const directory = {} as NoteDirectory;

function editor(id: string, dir: NoteDirectory = directory) {
  const disposed = vi.fn();
  const removed = vi.fn();
  const saveNow = vi.fn(() => Promise.resolve());
  const updates = new Set<() => void>();
  const doc = {};
  const replica = {
    doc,
    onUpdate: (listener: () => void) => {
      updates.add(listener);
      return () => updates.delete(listener);
    },
  };
  const made: NoteEditor = {
    id,
    directory: dir,
    note: { isClosed: false, replica, saveNow } as unknown as NoteEditor['note'],
    collab: {} as NoteEditor['collab'],
    files: {} as NoteEditor['files'],
    element: { remove: removed } as unknown as HTMLElement,
    host: null,
    stale: false,
    shown: 1,
    dispose: disposed,
  };
  /** Moved to Trash on another device: the change arrives in the kept replica. */
  const trashElsewhere = () => {
    deleted.add(doc);
    for (const listener of [...updates]) listener();
  };
  return { editor: made, disposed, removed, saveNow, trashElsewhere, watchers: () => updates.size };
}

describe('kept editors (T31)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('keeps the notes shown last, at most KEEP, closing the oldest', () => {
    const { notes } = fakeNotes();
    const unmount = viewMounted(notes);
    const made = ['a', 'b', 'c'].map((id) => editor(id));
    for (const { editor: each } of made) keepEditor(notes, each);

    expect(KEEP).toBe(2);
    expect(keptNotes(notes)).toEqual(['c', 'b']);
    expect(made[0]!.disposed).toHaveBeenCalledOnce();
    expect(made[1]!.disposed).not.toHaveBeenCalled();
    // Taken out of the page while kept, and stored with its text and links as they are now.
    for (const { removed, saveNow } of made) {
      expect(removed).toHaveBeenCalled();
      expect(saveNow).toHaveBeenCalledOnce();
    }
    unmount();
  });

  it('gives a kept editor back once, to a view of the same workspace', () => {
    const { notes } = fakeNotes();
    const unmount = viewMounted(notes);
    const a = editor('a');
    const b = editor('b');
    keepEditor(notes, a.editor);
    keepEditor(notes, b.editor);

    expect(takeEditor(notes, 'a', directory)).toBe(a.editor);
    expect(takeEditor(notes, 'a', directory)).toBeNull();
    // Another workspace's registry: the kept editor is closed, not shown.
    expect(takeEditor(notes, 'b', {} as NoteDirectory)).toBeNull();
    expect(b.disposed).toHaveBeenCalledOnce();
    unmount();
  });

  it('closes a stale editor instead of keeping it, and drops one at once', () => {
    const { notes } = fakeNotes();
    const unmount = viewMounted(notes);
    const a = editor('a');
    a.editor.stale = true;
    keepEditor(notes, a.editor);
    expect(a.disposed).toHaveBeenCalledOnce();
    expect(keptNotes(notes)).toEqual([]);

    const b = editor('b');
    keepEditor(notes, b.editor);
    dropEditor(notes, b.editor);
    expect(b.disposed).toHaveBeenCalledOnce();
    expect(keptNotes(notes)).toEqual([]);
    unmount();
  });

  it('drops a kept note moved to Trash elsewhere, and stops watching notes it lets go', () => {
    const fake = fakeNotes();
    const unmount = viewMounted(fake.notes);
    const a = editor('a');
    const b = editor('b');
    keepEditor(fake.notes, a.editor);
    keepEditor(fake.notes, b.editor);
    expect(a.watchers()).toBe(1);

    a.trashElsewhere();
    expect(a.disposed).toHaveBeenCalledOnce();
    expect(a.watchers()).toBe(0);
    expect(keptNotes(fake.notes)).toEqual(['b']);
    // Shown again: no longer watched by the shelf.
    expect(takeEditor(fake.notes, 'b', directory)).toBe(b.editor);
    expect(b.watchers()).toBe(0);
    // Already in Trash when its view lets go: closed, not kept.
    keepEditor(fake.notes, a.editor);
    expect(a.disposed).toHaveBeenCalledTimes(2);
    unmount();
  });

  it('closes them once no note view is left, not between one view and the next', () => {
    const { notes } = fakeNotes();
    const first = viewMounted(notes);
    const a = editor('a');
    keepEditor(notes, a.editor);
    // Switching notes: one view goes, the next one mounts in the same commit.
    first();
    const second = viewMounted(notes);
    vi.runAllTimers();
    expect(a.disposed).not.toHaveBeenCalled();
    expect(keptNotes(notes)).toEqual(['a']);

    // A page without a note view (Trash, Settings).
    second();
    vi.runAllTimers();
    expect(a.disposed).toHaveBeenCalledOnce();
    expect(keptNotes(notes)).toEqual([]);
  });
});
