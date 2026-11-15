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
  treeNoteClick,
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

  describe('a click on a note row (A570, A1570)', () => {
    const click = (extra: Partial<Parameters<typeof treeNoteClick>[0]> = {}) => ({
      button: 0,
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      defaultPrevented: false,
      ...extra,
    });
    const mac = (picked: number, tabs = true) => ({ apple: true, tabs, picked });
    const pc = (picked: number, tabs = true) => ({ apple: false, tabs, picked });

    it('opens ⌘-click on one row in a tab behind, ⇧⌘-click in front', () => {
      for (const picked of [0, 1]) {
        expect(treeNoteClick(click({ metaKey: true }), mac(picked))).toBe('background');
        expect(treeNoteClick(click({ metaKey: true, shiftKey: true }), mac(picked))).toBe(
          'foreground',
        );
        expect(treeNoteClick(click({ ctrlKey: true }), pc(picked))).toBe('background');
        expect(treeNoteClick(click({ ctrlKey: true, shiftKey: true }), pc(picked))).toBe(
          'foreground',
        );
      }
    });

    it('toggles with ⌘-click while several rows are picked, and ⇧⌘-click is then a range', () => {
      expect(treeNoteClick(click({ metaKey: true }), mac(2))).toBe('toggle');
      expect(treeNoteClick(click({ metaKey: true }), mac(5))).toBe('toggle');
      expect(treeNoteClick(click({ ctrlKey: true }), pc(2))).toBe('toggle');
      expect(treeNoteClick(click({ metaKey: true, shiftKey: true }), mac(2))).toBe('range');
    });

    it('always toggles where there are no tabs (a note window), as before', () => {
      expect(treeNoteClick(click({ metaKey: true }), mac(0, false))).toBe('toggle');
      expect(treeNoteClick(click({ ctrlKey: true }), pc(1, false))).toBe('toggle');
    });

    it('opens a plain click here, Shift-click a range, ⌥-click a window', () => {
      expect(treeNoteClick(click(), mac(3))).toBe('current');
      expect(treeNoteClick(click({ shiftKey: true }), mac(0))).toBe('range');
      expect(treeNoteClick(click({ shiftKey: true }), mac(3))).toBe('range');
      expect(treeNoteClick(click({ altKey: true }), mac(0))).toBe('window');
    });

    it('leaves alone a right or middle click, a Mac’s Ctrl-click and the other modifiers', () => {
      expect(treeNoteClick(click({ button: 2 }), mac(0))).toBeNull();
      // The middle click is the tree's onAuxClick, a tab behind (A1498).
      expect(treeNoteClick(click({ button: 1 }), mac(0))).toBeNull();
      expect(treeNoteClick(click({ ctrlKey: true }), mac(0))).toBeNull();
      expect(treeNoteClick(click({ metaKey: true }), pc(0))).toBeNull();
      expect(treeNoteClick(click({ altKey: true, metaKey: true }), mac(0))).toBeNull();
      expect(treeNoteClick(click({ metaKey: true, defaultPrevented: true }), mac(0))).toBeNull();
    });
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
