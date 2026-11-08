import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { NORD, PENMOSS } from '@penmoss/ui/theme';
import { loadPreferences, savePreferences } from '../../src/hotkey';
import { debouncedWriter, parseWindowTheme, windowBackground } from '../../src/theme';

// T28 + T29: the window behind the page is the page's own theme background, so
// opening, resizing and the capture window never flash another colour.

const dir = mkdtempSync(join(tmpdir(), 'penmoss-theme-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('the window background follows the theme', () => {
  const nord = { light: NORD.light.bg, dark: NORD.dark.bg, mode: 'system' } as const;

  it('is Penmoss until the page has said otherwise, light or dark as macOS is', () => {
    expect(windowBackground(null, false)).toBe(PENMOSS.light.bg);
    expect(windowBackground(null, true)).toBe(PENMOSS.dark.bg);
  });

  it('takes the theme’s variant: the mode chosen, or macOS’s for System', () => {
    expect(windowBackground(nord, false)).toBe(NORD.light.bg);
    expect(windowBackground(nord, true)).toBe(NORD.dark.bg);
    expect(windowBackground({ ...nord, mode: 'light' }, true)).toBe(NORD.light.bg);
    expect(windowBackground({ ...nord, mode: 'dark' }, false)).toBe(NORD.dark.bg);
  });

  it('accepts only #rrggbb colours and a known mode from the page', () => {
    expect(parseWindowTheme(nord)).toEqual(nord);
    expect(parseWindowTheme({ ...nord, extra: 1 })).toEqual(nord);
    for (const bad of [
      null,
      'nord',
      { ...nord, light: 'red' },
      { ...nord, dark: '#fff' },
      { ...nord, dark: 'url(x)' },
      { ...nord, light: '#2e3440; color: red' },
      { ...nord, mode: 'sepia' },
      { light: NORD.light.bg },
    ]) {
      expect(parseWindowTheme(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it('is remembered with the other preferences, and a bad file is ignored', () => {
    const file = join(dir, 'preferences.json');
    savePreferences(file, { captureHotkey: 'Control+Alt+Command+N', windowTheme: nord });
    expect(loadPreferences(file)).toEqual({
      captureHotkey: 'Control+Alt+Command+N',
      windowTheme: nord,
    });
    writeFileSync(file, JSON.stringify({ windowTheme: { ...nord, light: 'pink' } }));
    expect(loadPreferences(file)).toEqual({});
  });
});

describe('remembering the theme without a write per change (T28 review)', () => {
  it('writes the last value once changes pause, and at once when flushed (quitting)', () => {
    vi.useFakeTimers();
    try {
      const written: number[] = [];
      const writer = debouncedWriter((value: number) => written.push(value), 500);
      for (const value of [1, 2, 3]) {
        writer.schedule(value);
        vi.advanceTimersByTime(200);
      }
      expect(written).toEqual([]);
      vi.advanceTimersByTime(500);
      expect(written).toEqual([3]);
      writer.schedule(4);
      writer.flush();
      expect(written).toEqual([3, 4]);
      writer.flush();
      vi.advanceTimersByTime(1000);
      expect(written).toEqual([3, 4]);
    } finally {
      vi.useRealTimers();
    }
  });
});
