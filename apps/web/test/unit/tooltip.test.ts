import { describe, expect, it } from 'vitest';
import { placeTip } from '../../src/shell/tooltip-place';

const view = { width: 1000, height: 800 };
const tip = { width: 120, height: 24 };

describe('placeTip (T36)', () => {
  it('centres the tooltip below its control', () => {
    const anchor = { top: 10, left: 500, width: 32, height: 32 };
    expect(placeTip(anchor, tip, view)).toEqual({ left: 456, top: 48, side: 'below' });
  });

  it('stays inside the window at either edge', () => {
    expect(placeTip({ top: 10, left: 980, width: 32, height: 32 }, tip, view).left).toBe(872);
    expect(placeTip({ top: 10, left: 0, width: 32, height: 32 }, tip, view).left).toBe(8);
  });

  it('goes above a control at the bottom of the window', () => {
    const anchor = { top: 760, left: 500, width: 32, height: 32 };
    expect(placeTip(anchor, tip, view)).toEqual({ left: 456, top: 730, side: 'above' });
  });
});
