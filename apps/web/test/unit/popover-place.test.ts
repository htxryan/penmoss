import { describe, expect, it } from 'vitest';
import { placePopover, POPOVER_GAP } from '../../src/notes/popover-place';

const VIEWPORT = { width: 1000, height: 800 };
const SIZE = { width: 300, height: 200 };
const box = (top: number, left = 100) => ({ top, bottom: top + 20, left, right: left + 80 });

describe('where a floating comment goes (T52 item 5)', () => {
  it('sits below its passage when it fits there', () => {
    expect(placePopover(box(100), SIZE, VIEWPORT)).toEqual({
      top: 120 + POPOVER_GAP,
      left: 100,
      side: 'below',
    });
  });

  it('flips above a passage near the bottom of the window', () => {
    expect(placePopover(box(700), SIZE, VIEWPORT)).toEqual({
      top: 700 - POPOVER_GAP - 200,
      left: 100,
      side: 'above',
    });
  });

  it('stays inside the window at its right edge, and when it fits on neither side', () => {
    expect(placePopover(box(100, 900), SIZE, VIEWPORT).left).toBe(1000 - 300 - POPOVER_GAP);
    const tall = placePopover(box(300), { width: 300, height: 700 }, VIEWPORT);
    expect(tall.side).toBe('below');
    expect(tall.top).toBe(800 - 700 - POPOVER_GAP);
  });

  it('follows its passage as the note scrolls, pinned to the window’s edge once it leaves', () => {
    expect(placePopover(box(50), SIZE, VIEWPORT).top).toBe(70 + POPOVER_GAP);
    expect(placePopover(box(-400), SIZE, VIEWPORT).top).toBe(POPOVER_GAP);
  });
});
