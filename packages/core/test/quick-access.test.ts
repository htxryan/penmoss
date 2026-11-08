import { describe, expect, it } from 'vitest';
import {
  MAX_QUICK_ACCESS,
  QUICK_ACCESS_SETTING,
  quickAccessOf,
  quickAccessProblem,
  toggledQuickAccess,
} from '../src/quick-access';

describe('Quick Access (T51, A946)', () => {
  it('takes up to twenty distinct note ids', () => {
    expect(quickAccessProblem([])).toBeNull();
    expect(quickAccessProblem(['01M690Q2ZKMV1J1MA8KAK97GJZ'])).toBeNull();
    expect(quickAccessProblem(['a', 'a'])).not.toBeNull();
    expect(quickAccessProblem(['bad id'])).not.toBeNull();
    expect(quickAccessProblem('a')).not.toBeNull();
    const many = Array.from({ length: MAX_QUICK_ACCESS + 1 }, (_, i) => `n${i}`);
    expect(quickAccessProblem(many)).not.toBeNull();
    expect(quickAccessProblem(many.slice(1))).toBeNull();
  });

  it('pins at the end, unpins, and refuses a full list', () => {
    expect(toggledQuickAccess(['a'], 'b')).toEqual(['a', 'b']);
    expect(toggledQuickAccess(['a', 'b'], 'a')).toEqual(['b']);
    const full = Array.from({ length: MAX_QUICK_ACCESS }, (_, i) => `n${i}`);
    expect(toggledQuickAccess(full, 'x')).toBeNull();
    expect(toggledQuickAccess(full, 'n3')).toHaveLength(MAX_QUICK_ACCESS - 1);
  });

  it('reads an unreadable list as none', () => {
    expect(quickAccessOf({})).toEqual([]);
    expect(quickAccessOf({ [QUICK_ACCESS_SETTING]: 'a' })).toEqual([]);
    expect(quickAccessOf({ [QUICK_ACCESS_SETTING]: ['a'] })).toEqual(['a']);
  });
});
