import { describe, expect, it } from 'vitest';
import { trappedFocus } from '../../src/shell/focus-trap';

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
