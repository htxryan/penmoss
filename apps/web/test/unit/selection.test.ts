import { describe, expect, it } from 'vitest';
import type { Row } from '../../src/workspace/model';
import {
  isToggleClick,
  menuTargets,
  noteRange,
  notesLabel,
  notesNamed,
  selectionAfterOpen,
  moveSummary,
  toggled,
  visibleSelection,
} from '../../src/workspace/selection';

// T42 item 1 (A570): selecting notes in the tree for its context menu.
const note = (id: string) => ({ kind: 'note', id, key: `note:${id}` }) as unknown as Row;
const folder = (id: string) => ({ kind: 'folder', id, key: `folder:${id}` }) as unknown as Row;
const rows = [note('a'), folder('f'), note('b'), note('c'), note('d')];

describe('note selection', () => {
  it('toggles with ⌘ on a Mac, where Ctrl-click is a right-click, and Ctrl elsewhere', () => {
    expect(isToggleClick({ metaKey: true, ctrlKey: false }, true)).toBe(true);
    expect(isToggleClick({ metaKey: false, ctrlKey: true }, true)).toBe(false);
    expect(isToggleClick({ metaKey: false, ctrlKey: true }, false)).toBe(true);
    expect(isToggleClick({ metaKey: true, ctrlKey: false }, false)).toBe(false);
  });

  it('selects a range of notes either way round, skipping folders', () => {
    expect(noteRange(rows, 'a', 'c')).toEqual(['a', 'b', 'c']);
    expect(noteRange(rows, 'd', 'b')).toEqual(['b', 'c', 'd']);
    expect(noteRange(rows, null, 'c')).toEqual(['c']);
    expect(noteRange(rows, 'gone', 'c')).toEqual(['c']);
    expect(noteRange(rows, 'a', 'gone')).toEqual([]);
  });

  it('adds and removes one note', () => {
    expect(toggled(['a'], 'b')).toEqual(['a', 'b']);
    expect(toggled(['a', 'b'], 'a')).toEqual(['b']);
  });

  it('acts on the selection when the menu opens on a selected note, else on that note', () => {
    expect(menuTargets(['a', 'c'], 'c')).toEqual(['a', 'c']);
    expect(menuTargets(['a', 'c'], 'b')).toEqual(['b']);
  });

  it('keeps the selection to notes shown, in tree order', () => {
    expect(visibleSelection(rows, ['d', 'x', 'a'])).toEqual(['a', 'd']);
  });

  it('names one note by its title, and several by their count and titles (review S1)', () => {
    expect(notesLabel(['Garden plan'])).toBe('“Garden plan”');
    expect(notesLabel([' '])).toBe('“Untitled”');
    expect(notesLabel(['a', 'b', 'c'])).toBe('3 notes: “a”, “b” and “c”');
    expect(notesNamed(['a', 'b'])).toBe('“a” and “b”');
    expect(notesNamed(['a', 'b', 'c', 'd', 'e'])).toBe('“a”, “b”, “c” and 2 more');
  });

  it('starts the selection afresh when a note is opened other than by a click (review S1)', () => {
    // A click chose it: kept.
    expect(selectionAfterOpen(['a'], 'a')).toEqual(['a']);
    // Opened from search or a link, even one of the selected notes: an old selection goes.
    expect(selectionAfterOpen(['a', 'b', 'c'], 'b')).toEqual([]);
    expect(selectionAfterOpen(['a', 'b'], 'x')).toEqual([]);
    expect(selectionAfterOpen(['a'], null)).toEqual([]);
  });

  it('says how many of how many moved, and why the rest did not (review N4)', () => {
    const where = 'Shelf';
    expect(moveSummary({ asked: 1, moved: 1, refused: 0, problem: null, where })).toEqual({
      text: 'Moved to Shelf',
      ok: true,
    });
    expect(moveSummary({ asked: 3, moved: 3, refused: 0, problem: null, where }).text).toBe(
      'Moved 3 notes to Shelf',
    );
    expect(
      moveSummary({ asked: 3, moved: 2, refused: 1, problem: 'Folder is gone.', where }),
    ).toEqual({ text: 'Moved 2 of 3 notes to Shelf; 1 could not move: Folder is gone', ok: false });
    expect(moveSummary({ asked: 2, moved: 0, refused: 0, problem: null, where }).text).toBe(
      'Already in Shelf',
    );
  });
});
