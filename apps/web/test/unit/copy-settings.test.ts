import { QUICK_ACCESS_SETTING } from '@penmoss/core/quick-access';
import { describe, expect, it } from 'vitest';
import {
  copySettings,
  IN_STEP_KEY,
  readInStep,
  writeInStep,
  type SettingsHolder,
} from '../../src/sources/copy-settings';

function holder(initial: Record<string, unknown>): SettingsHolder & { writes: string[] } {
  const values: Record<string, unknown> = { ...initial };
  const writes: string[] = [];
  return {
    writes,
    settings: () => ({ ...values }),
    setSetting(key, value) {
      writes.push(key);
      if (value === undefined) delete values[key];
      else values[key] = value;
    },
  };
}

describe('settings copied between notebooks (A1137)', () => {
  it('makes the target the same, writing only what differs, and never Quick Access', () => {
    const from = holder({
      theme: 'moss',
      'noteBar.delete': true,
      'keys.note.toggleSource': ['Mod+Shift+M'],
      [QUICK_ACCESS_SETTING]: ['a'],
    });
    const to = holder({
      theme: 'paper',
      'keys.note.toggleSource': ['Mod+Shift+M'],
      'sidebar.graph': false,
      [QUICK_ACCESS_SETTING]: ['b'],
    });
    expect(copySettings(from, to)).toBe(3);
    expect(to.writes.sort()).toEqual(['noteBar.delete', 'sidebar.graph', 'theme']);
    expect(to.settings()).toEqual({
      theme: 'moss',
      'noteBar.delete': true,
      'keys.note.toggleSource': ['Mod+Shift+M'],
      [QUICK_ACCESS_SETTING]: ['b'],
    });
    // Again: nothing differs, so nothing is written.
    expect(copySettings(from, to)).toBe(0);
    expect(to.writes).toHaveLength(3);
  });

  it('keeps this Mac’s in-step choice, off by default', () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    };
    expect(readInStep(storage)).toBe(false);
    writeInStep(storage, true);
    expect(store.get(IN_STEP_KEY)).toBe('true');
    expect(readInStep(storage)).toBe(true);
    writeInStep(storage, false);
    expect(readInStep(storage)).toBe(false);
    expect(readInStep(null)).toBe(false);
  });
});
