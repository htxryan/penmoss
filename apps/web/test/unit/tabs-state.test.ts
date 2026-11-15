import { describe, expect, it } from 'vitest';
import {
  activate,
  activePath,
  activeTab,
  closeOthers,
  closeRight,
  closeTab,
  closeTabsShowing,
  currentEntry,
  cycle,
  dropUnknown,
  duplicateTab,
  historyPlaceOf,
  stepTarget,
  initialState,
  isBareHome,
  MAX_CLOSED,
  MAX_ENTRIES,
  moveTab,
  navigateActive,
  noteIdOfPath,
  notesInTabs,
  openTab,
  reopenClosed,
  restoreTabs,
  retarget,
  selectLast,
  selectNth,
  setPinned,
  settle,
  showInTab,
  shownNotes,
  shownTabCount,
  step,
  switchToTab,
  tabShowing,
  updateEntry,
  type TabsState,
} from '../../src/tabs/state';

// PEN-140 (A1496): the main window's tabs as a plain value, every rule a pure function.

const A = '01J0000000000000000000000A';
const B = '01J0000000000000000000000B';
const C = '01J0000000000000000000000C';
const D = '01J0000000000000000000000D';
const note = (id: string) => `/notes/${id}`;

/** Ids t1, t2, … in order. */
function counter() {
  let n = 0;
  return () => `t${++n}`;
}

/** The strip as paths, the active one starred. */
function strip(state: TabsState): string[] {
  return state.tabs.map(
    (tab) =>
      `${tab.id === state.active ? '*' : ''}${tab.pinned ? '^' : ''}${currentEntry(tab).path}`,
  );
}

/** Tabs on `paths`, the first active. */
function tabsOn(paths: string[], ids = counter()): TabsState {
  let state = initialState(ids, paths[0]);
  for (const path of paths.slice(1)) state = openTab(state, path, { ids });
  return activate(state, state.tabs[0]!.id);
}

describe('opening notes', () => {
  it('starts with one tab on Home', () => {
    const state = initialState(counter());
    expect(strip(state)).toEqual(['*/']);
  });

  it('shows a plainly clicked note in the active tab, in its history', () => {
    const ids = counter();
    let state = initialState(ids);
    state = navigateActive(state, note(A), { ids });
    state = navigateActive(state, note(B), { ids });
    expect(strip(state)).toEqual([`*${note(B)}`]);
    expect(activeTab(state).entries.map((entry) => entry.path)).toEqual(['/', note(A), note(B)]);
  });

  it('replaces the current entry when told to, and ignores the same page', () => {
    const ids = counter();
    let state = initialState(ids, note(A));
    expect(navigateActive(state, note(A))).toBe(state);
    state = navigateActive(state, `${note(A)}?heading=Plan`, { replace: true });
    expect(activeTab(state).entries.map((entry) => entry.path)).toEqual([
      `${note(A)}?heading=Plan`,
    ]);
  });

  it('opens a ⌘-clicked note behind, right of the active tab and after the others opened from it', () => {
    const ids = counter();
    let state = tabsOn([note(C), note(D)], ids);
    state = openTab(state, note(A), { background: true, ids });
    state = openTab(state, note(B), { background: true, ids });
    expect(strip(state)).toEqual([`*${note(C)}`, note(A), note(B), note(D)]);
  });

  it('opens a ⇧⌘-clicked note in front, right of the active tab', () => {
    const ids = counter();
    let state = tabsOn([note(C), note(D)], ids);
    state = openTab(state, note(A), { ids });
    expect(strip(state)).toEqual([note(C), `*${note(A)}`, note(D)]);
  });

  it('opens a plain click from a pinned tab in a new tab, leaving the pinned one', () => {
    const ids = counter();
    let state = initialState(ids, note(A));
    state = setPinned(state, state.active, true);
    state = navigateActive(state, note(B), { ids });
    expect(strip(state)).toEqual([`^${note(A)}`, `*${note(B)}`]);
    // Settings, full-window, is the exception: Back comes back from it.
    state = activate(state, state.tabs[0]!.id);
    state = navigateActive(state, '/settings/display', { ids });
    expect(state.tabs).toHaveLength(2);
    expect(activePath(state)).toBe('/settings/display');
  });

  it('switches to the tab showing a note opened from outside, else opens one in front', () => {
    const ids = counter();
    let state = tabsOn([note(A), note(B)], ids);
    state = showInTab(state, note(B), ids);
    expect(strip(state)).toEqual([note(A), `*${note(B)}`]);
    state = showInTab(state, note(C), ids);
    expect(strip(state)).toEqual([note(A), note(B), `*${note(C)}`]);
    // Never in place of the page on screen.
    expect(activeTab(state).entries).toHaveLength(1);
  });

  it('finds the tab showing a note, the active one first, and switches to it (A1574)', () => {
    const ids = counter();
    let state = tabsOn([note(A), note(B), note(A)], ids);
    state = activate(state, state.tabs[2]!.id);
    expect(tabShowing(state, note(A))).toBe(state.tabs[2]!.id);
    expect(tabShowing(state, `${note(B)}?heading=Plan`)).toBe(state.tabs[1]!.id);
    expect(tabShowing(state, note(C))).toBeNull();
    expect(tabShowing(state, '/tags')).toBeNull();
    // Switching keeps the tab on screen as it was; a heading replaces the page it switches to.
    const before = state.tabs[2]!;
    let next = switchToTab(state, state.tabs[1]!.id, note(B));
    expect(strip(next)).toEqual([note(A), `*${note(B)}`, note(A)]);
    expect(next.tabs[2]).toBe(before);
    expect(activeTab(next).entries).toHaveLength(1);
    next = switchToTab(state, state.tabs[1]!.id, `${note(B)}?heading=Plan`);
    expect(strip(next)).toEqual([note(A), `*${note(B)}?heading=Plan`, note(A)]);
    expect(activeTab(next).entries).toHaveLength(1);
  });
});

describe('closing, reopening and switching', () => {
  it('makes the tab to the right active, else the one to the left', () => {
    const ids = counter();
    let state = tabsOn([note(A), note(B), note(C)], ids);
    state = activate(state, state.tabs[1]!.id);
    state = closeTab(state, state.active, ids);
    expect(strip(state)).toEqual([note(A), `*${note(C)}`]);
    state = closeTab(state, state.active, ids);
    expect(strip(state)).toEqual([`*${note(A)}`]);
  });

  it('leaves a Home tab when the only tab closes (AC4), which the strip does not show (A1576)', () => {
    const ids = counter();
    let state = initialState(ids, note(A));
    expect(isBareHome(state)).toBe(false);
    state = closeTab(state, state.active, ids);
    expect(strip(state)).toEqual(['*/']);
    expect(state.closed).toHaveLength(1);
    expect(isBareHome(state)).toBe(true);
    expect(shownTabCount(state)).toBe(0);
    // Closing that Home does nothing, and puts nothing on the closed list.
    expect(closeTab(state, state.active, ids)).toBe(state);
    // A new tab's Home is bare too; Home beside a note, or pinned, is a tab like any other.
    expect(isBareHome(initialState(ids, '/?tab=new'))).toBe(true);
    // A tab opened from it, behind or in front, takes its place: the bare Home never shows.
    for (const background of [true, false]) {
      const opened = openTab(state, note(B), { background, ids });
      expect(strip(opened)).toEqual([`*${note(B)}`]);
      expect(opened.closed).toBe(state.closed);
      expect(activeTab(opened).opener).toBeUndefined();
    }
    expect(strip(showInTab(state, note(C), ids))).toEqual([`*${note(C)}`]);
    // A Home beside a note (⌘T) is a tab like any other.
    const beside = openTab(initialState(ids, note(A)), '/', { background: false, ids });
    expect(isBareHome(beside)).toBe(false);
    expect(shownTabCount(beside)).toBe(2);
    expect(isBareHome(setPinned(state, state.active, true))).toBe(false);
    // A note opened in it makes it the first tab.
    const opened = navigateActive(state, note(B), { ids });
    expect(strip(opened)).toEqual([`*${note(B)}`]);
    expect(shownTabCount(opened)).toBe(1);
  });

  it('reopens the last closed tab where it was, with its history, scroll, panel and pin', () => {
    const ids = counter();
    let state = tabsOn([note(A), note(B), note(C)], ids);
    const middle = state.tabs[1]!.id;
    state = activate(state, middle);
    state = navigateActive(state, note(D), { ids });
    state = updateEntry(state, middle, { scrollTop: 480, panel: { open: true, tab: 'history' } });
    state = closeTab(state, middle, ids);
    state = activate(state, state.tabs[0]!.id);
    state = reopenClosed(state);
    expect(strip(state)).toEqual([note(A), `*${note(D)}`, note(C)]);
    const back = activeTab(state);
    expect(back.entries.map((entry) => entry.path)).toEqual([note(B), note(D)]);
    expect(currentEntry(back)).toMatchObject({
      scrollTop: 480,
      panel: { open: true, tab: 'history' },
    });
    expect(state.closed).toHaveLength(0);
  });

  it('skips a closed tab whose note is in Trash or unknown', () => {
    const ids = counter();
    let state = tabsOn([note(A), note(B), note(C)], ids);
    state = closeTab(state, state.tabs[1]!.id, ids);
    state = closeTab(state, state.tabs[1]!.id, ids);
    state = reopenClosed(state, (id) => id !== C);
    expect(strip(state)).toEqual([note(A), `*${note(B)}`]);
  });

  it('reopens two closed tabs in a row, a pinned tab active, each where it was (AC3)', () => {
    const ids = counter();
    let state = tabsOn([note(A), note(B), note(C)], ids);
    state = setPinned(state, state.tabs[0]!.id, true);
    state = selectLast(state);
    state = closeTab(state, state.active, ids);
    state = closeTab(state, state.active, ids);
    expect(strip(state)).toEqual([`*^${note(A)}`]);
    state = reopenClosed(state, () => true, ids);
    expect(strip(state)).toEqual([`^${note(A)}`, `*${note(B)}`]);
    state = reopenClosed(state, () => true, ids);
    expect(strip(state)).toEqual([`^${note(A)}`, note(B), `*${note(C)}`]);
    expect(state.closed).toHaveLength(0);
  });

  it('gives a reopened tab a new id when its own is open again', () => {
    const ids = counter();
    let state = tabsOn([note(A), note(B)], ids);
    const closing = closeTabsShowing(state, (id) => id === B, ids);
    // A Restore put the tab back while it is still on the closed list.
    state = { ...restoreTabs(closing.state, closing.closed), closed: closing.state.closed };
    state = reopenClosed(state, () => true, ids);
    const tabIds = state.tabs.map((tab) => tab.id);
    expect(new Set(tabIds).size).toBe(tabIds.length);
    expect(tabIds).toContain(state.active);
    expect(strip(state)).toEqual([note(A), `*${note(B)}`, note(B)]);
  });

  it('settles a state whose active tab is gone, or that holds one id twice', () => {
    const ids = counter();
    const state = tabsOn([note(A), note(B)], ids);
    const lost = settle({ ...state, active: 'nowhere' }, ids);
    expect(strip(lost)).toEqual([`*${note(A)}`, note(B)]);
    const twice = settle({ ...state, tabs: [...state.tabs, state.tabs[1]!] }, ids);
    expect(strip(twice)).toEqual([`*${note(A)}`, note(B)]);
    const none = settle({ ...state, tabs: [] }, ids);
    expect(strip(none)).toEqual(['*/']);
    expect(settle(state, ids)).toBe(state);
  });

  it('keeps the last 20 closed tabs', () => {
    const ids = counter();
    let state = initialState(ids);
    for (let n = 0; n < MAX_CLOSED + 5; n++) {
      state = openTab(state, note(A), { ids });
      state = closeTab(state, state.active, ids);
    }
    expect(state.closed).toHaveLength(MAX_CLOSED);
  });

  it('closes the others and those to the right, leaving pinned tabs', () => {
    const ids = counter();
    let state = tabsOn([note(A), note(B), note(C), note(D)], ids);
    state = setPinned(state, state.tabs[3]!.id, true);
    expect(strip(state)).toEqual([`^${note(D)}`, `*${note(A)}`, note(B), note(C)]);
    expect(strip(closeRight(state, state.tabs[2]!.id))).toEqual([
      `^${note(D)}`,
      `*${note(A)}`,
      note(B),
    ]);
    expect(strip(closeOthers(state, state.tabs[2]!.id))).toEqual([`^${note(D)}`, `*${note(B)}`]);
  });

  it('cycles with ⌃Tab and ⇧⌃Tab, wrapping round, and picks with ⌘1–⌘9', () => {
    const ids = counter();
    let state = tabsOn([note(A), note(B), note(C)], ids);
    state = cycle(state, -1);
    expect(activePath(state)).toBe(note(C));
    state = cycle(state, 1);
    expect(activePath(state)).toBe(note(A));
    expect(activePath(selectNth(state, 1))).toBe(note(B));
    expect(selectNth(state, 7)).toBe(state);
    expect(activePath(selectLast(state))).toBe(note(C));
  });
});

describe('pinning and order', () => {
  it('pins to the end of the pinned group, and unpins to the start of the rest', () => {
    const ids = counter();
    let state = tabsOn([note(A), note(B), note(C)], ids);
    state = setPinned(state, state.tabs[2]!.id, true);
    state = setPinned(state, state.tabs[2]!.id, true);
    expect(strip(state).map((path) => path.replace('*', ''))).toEqual([
      `^${note(C)}`,
      `^${note(B)}`,
      note(A),
    ]);
    state = setPinned(state, state.tabs[0]!.id, false);
    expect(strip(state).map((path) => path.replace('*', ''))).toEqual([
      `^${note(B)}`,
      note(C),
      note(A),
    ]);
  });

  it('reorders within a group only', () => {
    const ids = counter();
    let state = tabsOn([note(A), note(B), note(C), note(D)], ids);
    state = setPinned(state, state.tabs[3]!.id, true);
    const a = state.tabs[1]!.id;
    expect(strip(moveTab(state, a, 3)).map((path) => path.replace('*', ''))).toEqual([
      `^${note(D)}`,
      note(B),
      note(C),
      note(A),
    ]);
    // An unpinned tab never goes among the pinned ones.
    expect(moveTab(state, a, 0)).toBe(state);
  });

  it('duplicates a tab with its history, right after it, in front', () => {
    const ids = counter();
    let state = tabsOn([note(A), note(B)], ids);
    state = navigateActive(state, note(C), { ids });
    state = duplicateTab(state, state.active, ids);
    expect(strip(state)).toEqual([note(C), `*${note(C)}`, note(B)]);
    expect(activeTab(state).entries.map((entry) => entry.path)).toEqual([note(A), note(C)]);
  });
});

describe('each tab’s history', () => {
  it('goes back and forward in the active tab only', () => {
    const ids = counter();
    let state = initialState(ids, note(A));
    state = navigateActive(state, note(B), { ids });
    state = openTab(state, note(C), { ids });
    expect(historyPlaceOf(state)).toEqual({ back: false, forward: false });
    state = activate(state, state.tabs[0]!.id);
    expect(historyPlaceOf(state)).toEqual({ back: true, forward: false });
    state = step(state, -1);
    expect(activePath(state)).toBe(note(A));
    expect(historyPlaceOf(state)).toEqual({ back: false, forward: true });
    state = step(state, 1);
    expect(activePath(state)).toBe(note(B));
  });

  it('names the page Back or Forward would show, for their tooltips (AC6)', () => {
    const ids = counter();
    let state = initialState(ids, note(A));
    state = navigateActive(state, note(B), { ids });
    state = navigateActive(state, note(C), { ids });
    expect(stepTarget(state, -1)?.path).toBe(note(B));
    expect(stepTarget(state, 1)).toBeNull();
    const trashed = (entry: { path: string }) => noteIdOfPath(entry.path) === B;
    expect(stepTarget(state, -1, trashed)?.path).toBe(note(A));
    state = openTab(state, '/graph', { ids, background: false });
    expect(stepTarget(state, -1)).toBeNull();
  });

  it('passes over entries of notes in Trash', () => {
    const ids = counter();
    let state = initialState(ids, note(A));
    state = navigateActive(state, note(B), { ids });
    state = navigateActive(state, note(C), { ids });
    const trashed = (entry: { path: string }) => noteIdOfPath(entry.path) === B;
    state = step(state, -1, trashed);
    expect(activePath(state)).toBe(note(A));
  });

  it('keeps at most 50 entries, dropping the oldest', () => {
    const ids = counter();
    let state = initialState(ids);
    for (let n = 0; n < MAX_ENTRIES + 10; n++) {
      state = navigateActive(state, `/notes/${A}?heading=${n}`, { ids });
    }
    const tab = activeTab(state);
    expect(tab.entries).toHaveLength(MAX_ENTRIES);
    expect(tab.index).toBe(MAX_ENTRIES - 1);
  });

  it('keeps each entry’s scroll and panel, only while it shows the same page', () => {
    const ids = counter();
    let state = initialState(ids, note(A));
    const tab = state.active;
    state = updateEntry(state, tab, { scrollTop: 120 }, note(A));
    expect(currentEntry(activeTab(state)).scrollTop).toBe(120);
    expect(updateEntry(state, tab, { scrollTop: 300 }, note(B))).toBe(state);
  });
});

describe('notes renamed, moved or trashed while open, and notebooks closed', () => {
  it('follows a note moved to another notebook, in the tabs and the closed list', () => {
    const ids = counter();
    let state = tabsOn([note(A), `${note(B)}?heading=Plan`], ids);
    state = closeTab(state, state.tabs[0]!.id, ids);
    state = openTab(state, note(A), { ids });
    state = retarget(state, A, D);
    state = retarget(state, B, C);
    expect(strip(state)).toEqual([`${note(C)}?heading=Plan`, `*${note(D)}`]);
    expect(currentEntry(state.closed[0]!.tab).path).toBe(note(D));
    expect(retarget(state, A, B)).toBe(state);
  });

  it('closes every tab showing a trashed note, and Restore puts them back', () => {
    const ids = counter();
    let state = tabsOn([note(A), note(B), note(A), note(C)], ids);
    state = activate(state, state.tabs[2]!.id);
    const closing = closeTabsShowing(state, (id) => id === A, ids);
    expect(strip(closing.state)).toEqual([note(B), `*${note(C)}`]);
    expect(closing.closed.map((item) => item.position)).toEqual([0, 2]);
    const restored = restoreTabs(closing.state, closing.closed);
    expect(strip(restored)).toEqual([`*${note(A)}`, note(B), note(A), note(C)]);
  });

  it('closes the tab Settings was opened from when its notebook is removed there, and stays on Settings', () => {
    const ids = counter();
    let state = tabsOn([note(A), note(B)], ids);
    state = activate(state, state.tabs[1]!.id);
    state = navigateActive(state, '/settings/notebooks', { ids });
    const closing = closeTabsShowing(state, (id) => id === B, ids);
    // The window still shows Settings, now over the tab that is left; ← Notes goes there.
    expect(activePath(closing.state)).toBe('/settings/notebooks');
    expect(closing.state.tabs).toHaveLength(1);
    expect(stepTarget(closing.state, -1)?.path).toBe(note(A));
    // The closed tab is kept at its note, so Reopen Closed Tab opens it there, not on Settings.
    expect(closing.closed.map((item) => currentEntry(item.tab).path)).toEqual([note(B)]);
    expect(currentEntry(closing.state.closed.at(-1)!.tab).path).toBe(note(B));
    // The only tab: a Home tab, under Settings.
    const only = navigateActive(initialState(ids, note(B)), '/settings', { ids });
    const left = closeTabsShowing(only, (id) => id === B, ids);
    expect(activePath(left.state)).toBe('/settings');
    expect(stepTarget(left.state, -1)?.path).toBe('/');
  });

  it('drops the pages of unknown notes, and tabs left with none', () => {
    const ids = counter();
    let state = initialState(ids, note(A));
    state = navigateActive(state, note(B), { ids });
    state = openTab(state, note(C), { ids });
    state = dropUnknown(state, (id) => id !== B && id !== C, ids);
    expect(strip(state)).toEqual([`*${note(A)}`]);
    expect(activeTab(state).entries).toHaveLength(1);
    // Nothing known: Home.
    expect(strip(dropUnknown(state, () => false, ids))).toEqual(['*/']);
  });

  it('tells the kept editors which notes the tabs hold, the active one first', () => {
    const ids = counter();
    let state = tabsOn([note(A), note(B)], ids);
    state = activate(state, state.tabs[1]!.id);
    state = navigateActive(state, note(C), { ids });
    expect(shownNotes(state)).toEqual([C, A]);
    expect([...notesInTabs(state)].sort()).toEqual([A, B, C].sort());
  });
});
