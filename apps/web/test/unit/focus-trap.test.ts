import { describe, expect, it } from 'vitest';
import { cycledFocus, trappedFocus } from '../../src/shell/focus-trap';

describe('trappedFocus (T39)', () => {
  const controls = ['input', 'mode', 'close'];

  it('wraps Tab from the last control to the first, and Shift+Tab back', () => {
    expect(trappedFocus(controls, 'close', false)).toBe('input');
    expect(trappedFocus(controls, 'input', true)).toBe('close');
  });

  it('leaves Tab between the dialog’s own controls to the browser', () => {
    expect(trappedFocus(controls, 'input', false)).toBeNull();
    expect(trappedFocus(controls, 'close', true)).toBeNull();
  });

  it('brings focus that left the dialog back to its first or last control', () => {
    expect(trappedFocus(controls, null, false)).toBe('input');
    expect(trappedFocus(controls, null, true)).toBe('close');
    expect(trappedFocus(controls, 'page behind', false)).toBe('input');
  });

  it('does nothing in a dialog with nothing to focus', () => {
    expect(trappedFocus([], null, false)).toBeNull();
  });
});

describe('cycledFocus (A1572: a dialog and the panel it owns)', () => {
  // View This Version's controls, then History's list beside it.
  const controls = ['restore', 'close', 'version 2', 'version 1'];

  it('moves to the next control every time, from the dialog into the owned panel and round', () => {
    expect(cycledFocus(controls, 'close', false)).toBe('version 2');
    expect(cycledFocus(controls, 'version 1', false)).toBe('restore');
    expect(cycledFocus(controls, 'restore', true)).toBe('version 1');
    expect(cycledFocus(controls, 'version 2', true)).toBe('close');
  });

  it('brings focus from elsewhere to the first or last control', () => {
    expect(cycledFocus(controls, null, false)).toBe('restore');
    expect(cycledFocus(controls, 'page behind', true)).toBe('version 1');
  });

  it('does nothing with nothing to focus', () => {
    expect(cycledFocus([], null, false)).toBeNull();
  });
});
