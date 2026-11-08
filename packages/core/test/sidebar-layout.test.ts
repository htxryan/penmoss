import { describe, expect, it } from 'vitest';
import { movedQuickAccess } from '../src/quick-access';
import {
  HIDDEN_SECTIONS_SETTING,
  movedSection,
  QUICK_ACCESS_NOTEBOOK_SETTING,
  quickAccessShowsNotebook,
  RECENT_COUNT_SETTING,
  recentCountOf,
  SECTION_ORDER_SETTING,
  sectionOrderOf,
  shownSectionsOf,
  sidebarLayoutProblem,
  withSectionHidden,
} from '../src/sidebar-layout';

describe('the sidebar’s sections (T53 item 8)', () => {
  it('are Quick Access, Recent Notes, Notebooks, Calendar and Tags, all shown, unset', () => {
    expect(sectionOrderOf({})).toEqual(['quickAccess', 'recent', 'notebooks', 'calendar', 'tags']);
    expect(shownSectionsOf({})).toEqual(sectionOrderOf({}));
  });

  it('follow the stored order, unknown ids skipped and missing ones after it', () => {
    const settings = { [SECTION_ORDER_SETTING]: ['tags', 'later', 'calendar'] };
    expect(sectionOrderOf(settings)).toEqual([
      'tags',
      'calendar',
      'quickAccess',
      'recent',
      'notebooks',
    ]);
    // An unreadable order is the default one.
    expect(sectionOrderOf({ [SECTION_ORDER_SETTING]: ['tags', 'tags'] })[0]).toBe('quickAccess');
  });

  it('leave hidden ones out, in their place for when they show again', () => {
    const settings = {
      [SECTION_ORDER_SETTING]: ['tags', 'notebooks'],
      [HIDDEN_SECTIONS_SETTING]: ['notebooks', 'recent'],
    };
    expect(shownSectionsOf(settings)).toEqual(['tags', 'quickAccess', 'calendar']);
    expect(sectionOrderOf(settings)[1]).toBe('notebooks');
  });

  it('move to a new place among all of them', () => {
    const order = sectionOrderOf({});
    expect(movedSection(order, 'tags', 0)).toEqual([
      'tags',
      'quickAccess',
      'recent',
      'notebooks',
      'calendar',
    ]);
    expect(movedSection(order, 'quickAccess', 9).at(-1)).toBe('quickAccess');
  });

  it('hide and show, stored in the default order', () => {
    const hidden = withSectionHidden(new Set(['tags']), 'recent', true);
    expect(hidden).toEqual(['recent', 'tags']);
    expect(withSectionHidden(new Set(hidden), 'tags', false)).toEqual(['recent']);
  });

  it('check what may be stored', () => {
    expect(sidebarLayoutProblem(SECTION_ORDER_SETTING, ['tags', 'calendar'])).toBeNull();
    expect(sidebarLayoutProblem(SECTION_ORDER_SETTING, ['tags', 'tags'])).toMatch(/repeats/);
    expect(sidebarLayoutProblem(HIDDEN_SECTIONS_SETTING, 'tags')).toMatch(/list/);
    expect(sidebarLayoutProblem(RECENT_COUNT_SETTING, 25)).toBeNull();
    for (const bad of [0, 51, 2.5, '10']) {
      expect(sidebarLayoutProblem(RECENT_COUNT_SETTING, bad)).toMatch(/whole number/);
    }
    expect(sidebarLayoutProblem(QUICK_ACCESS_NOTEBOOK_SETTING, 'yes')).toMatch(/true or false/);
    expect(sidebarLayoutProblem(QUICK_ACCESS_NOTEBOOK_SETTING, null)).toBeNull();
  });

  it('read Recent Notes’ length and Quick Access’s notebook names, with defaults', () => {
    expect(recentCountOf({})).toBe(10);
    expect(recentCountOf({ [RECENT_COUNT_SETTING]: 3 })).toBe(3);
    expect(recentCountOf({ [RECENT_COUNT_SETTING]: 500 })).toBe(10);
    expect(quickAccessShowsNotebook({})).toBe(false);
    expect(quickAccessShowsNotebook({ [QUICK_ACCESS_NOTEBOOK_SETTING]: true })).toBe(true);
  });
});

describe('Quick Access dragged into order (T53 item 10)', () => {
  it('moves a pin to its new place, and leaves the list as it is for one not pinned', () => {
    expect(movedQuickAccess(['a', 'b', 'c'], 'c', 0)).toEqual(['c', 'a', 'b']);
    expect(movedQuickAccess(['a', 'b', 'c'], 'a', 2)).toEqual(['b', 'c', 'a']);
    expect(movedQuickAccess(['a', 'b'], 'z', 0)).toEqual(['a', 'b']);
  });
});
