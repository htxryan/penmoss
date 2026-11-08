import { describe, expect, it } from 'vitest';
import { widthPlan } from '../../src/notes/width';

// T41 (A501): full-width notes, a synced setting with this device's copy.

describe('full width (T41, A501)', () => {
  it('follows the synced setting, and brings this device’s copy in line after render', () => {
    expect(widthPlan({ canSync: true, synced: true, cached: false, pending: false })).toEqual({
      full: true,
      send: null,
      cache: true,
    });
    expect(widthPlan({ canSync: true, synced: true, cached: true, pending: false })).toEqual({
      full: true,
      send: null,
      cache: null,
    });
  });

  it('uses this device’s copy before the workspace loads or while signed out', () => {
    expect(widthPlan({ canSync: false, synced: null, cached: true, pending: false })).toEqual({
      full: true,
      send: null,
      cache: null,
    });
  });

  it('sends a choice made while signed out once settings can change, over the old synced one', () => {
    const signedOut = { synced: null, cached: true, pending: true };
    expect(widthPlan({ ...signedOut, canSync: false })).toEqual({
      full: true,
      send: null,
      cache: null,
    });
    expect(widthPlan({ canSync: true, synced: false, cached: true, pending: true })).toEqual({
      full: true,
      send: true,
      cache: null,
    });
  });
});
