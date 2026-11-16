import { describe, expect, it } from 'vitest';
import {
  DISPLAY_SETTING_KEYS,
  displaySettingProblem,
  isDisplaySetting,
  PHONE_SHORTCUT_ITEMS,
  PHONE_SHORTCUT_SETTING_KEYS,
  SIDEBAR_ITEMS,
  sidebarShows,
} from '../src/display';
import { isPlatformSetting } from '../src/settings';

describe('Display settings (T42, A576)', () => {
  it('names a setting for each shortcut that may be hidden, never Search', () => {
    expect(SIDEBAR_ITEMS).toEqual(['tags', 'today', 'thisWeek', 'graph', 'commands']);
    expect(DISPLAY_SETTING_KEYS).toEqual([
      'sidebar.tags',
      'sidebar.today',
      'sidebar.thisWeek',
      'sidebar.graph',
      'sidebar.commands',
    ]);
    expect(isDisplaySetting('sidebar.graph')).toBe(true);
    expect(isDisplaySetting('sidebar.search')).toBe(false);
  });

  it("keeps the phone's own shortcuts per platform, apart from the Mac's sidebar (A1613)", () => {
    expect(PHONE_SHORTCUT_ITEMS).toEqual(['journal', 'allNotes', 'capture']);
    expect(PHONE_SHORTCUT_SETTING_KEYS).toEqual([
      'sidebar.journal',
      'sidebar.allNotes',
      'sidebar.capture',
    ]);
    for (const key of PHONE_SHORTCUT_SETTING_KEYS) {
      expect(isPlatformSetting(key)).toBe(true);
      expect(isDisplaySetting(key)).toBe(false);
    }
  });

  it('shows an item unless its setting is false', () => {
    expect(sidebarShows({}, 'graph')).toBe(true);
    expect(sidebarShows({ 'sidebar.graph': true }, 'graph')).toBe(true);
    expect(sidebarShows({ 'sidebar.graph': false }, 'graph')).toBe(false);
    expect(sidebarShows({ 'sidebar.graph': false }, 'today')).toBe(true);
    // Something unreadable written by a newer build shows the item.
    expect(sidebarShows({ 'sidebar.graph': 'no' }, 'graph')).toBe(true);
  });

  it('takes true, false or null, nothing else', () => {
    for (const value of [true, false, null]) {
      expect(displaySettingProblem('sidebar.today', value)).toBeNull();
    }
    for (const value of ['false', 0, 1, {}, []]) {
      expect(displaySettingProblem('sidebar.today', value)).toMatch(/true or false/);
    }
  });
});
