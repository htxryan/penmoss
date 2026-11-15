// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { goBack, historyPlace, navigate, startHistory } from '../../src/router';
import { installMainTabs, TabsController, uninstallMainTabs } from '../../src/tabs/controller';
import { load, parse, save, serialise, TABS_KEY } from '../../src/tabs/persist';
import {
  activePath,
  activeTab,
  currentEntry,
  initialState,
  isBareHome,
  MAX_SAVED,
  openTab,
  setPinned,
  updateEntry,
  type TabsState,
} from '../../src/tabs/state';
import type { KeyValueStore } from '../../src/shell/key-value';

// PEN-140 (A1496, A1497): the main window's tabs across restarts, and the address that
// follows the active tab.

const A = '01J0000000000000000000000A';
const B = '01J0000000000000000000000B';
const C = '01J0000000000000000000000C';
const note = (id: string) => `/notes/${id}`;

function counter() {
  let n = 0;
  return () => `t${++n}`;
}

function memory(): KeyValueStore & { readonly values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
  };
}

describe('saving the tabs (A1496)', () => {
  it('saves and restores the tabs, their order, pins, active tab, history, scroll and panel', () => {
    const ids = counter();
    let state = initialState(ids, note(A));
    state = openTab(state, note(B), { ids });
    state = setPinned(state, state.active, true);
    state = updateEntry(state, state.active, {
      scrollTop: 640,
      panel: { open: true, tab: 'comments' },
    });
    state = openTab(state, note(C), { ids });
    const store = memory();
    save(store, state);
    expect(store.values.has(TABS_KEY)).toBe(true);
    const back = load(store)!;
    expect(back.tabs.map((tab) => [tab.id, tab.pinned, currentEntry(tab).path])).toEqual(
      state.tabs.map((tab) => [tab.id, tab.pinned, currentEntry(tab).path]),
    );
    expect(back.active).toBe(state.active);
    const pinned = back.tabs.find((tab) => tab.pinned)!;
    expect(currentEntry(pinned)).toEqual({
      path: note(B),
      scrollTop: 640,
      panel: { open: true, tab: 'comments' },
    });
  });

  it('saves at most 50 tabs, pinned ones first', () => {
    const ids = counter();
    let state = initialState(ids, note(A));
    for (let n = 0; n < MAX_SAVED + 5; n++) state = openTab(state, note(B), { ids });
    state = setPinned(state, state.tabs.at(-1)!.id, true);
    const back = parse(serialise(state))!;
    expect(back.tabs).toHaveLength(MAX_SAVED);
    expect(back.tabs[0]!.pinned).toBe(true);
  });

  it('reads a bad or old saved value as none, and leaves out what is off', () => {
    expect(parse(null)).toBeNull();
    expect(parse('{')).toBeNull();
    expect(parse(JSON.stringify({ v: 0, tabs: [] }))).toBeNull();
    expect(parse(JSON.stringify({ v: 1, tabs: [] }))).toBeNull();
    const value = parse(
      JSON.stringify({
        v: 1,
        active: 'gone',
        tabs: [
          { id: 'a', entries: [{ path: '//evil.example/x' }] },
          {
            id: 'b',
            index: 9,
            entries: [{ path: note(A), scrollTop: -3, panel: { open: 'yes' } }],
          },
          { id: 'b', entries: [{ path: note(B) }] },
          'nonsense',
        ],
        closed: [{ position: -1, tab: { id: 'c', entries: [{ path: '/' }] } }],
      }),
    )!;
    expect(value.tabs.map((tab) => tab.id)).toEqual(['b']);
    expect(value.active).toBe('b');
    expect(currentEntry(value.tabs[0]!)).toEqual({ path: note(A), scrollTop: 0 });
    expect(value.closed).toEqual([]);
  });
});

describe('the address and the browser’s history (A1497)', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/');
    startHistory();
  });
  afterEach(() => uninstallMainTabs());

  it('follows the active tab, and a launch at Home shows the saved active tab', () => {
    const ids = counter();
    let saved: TabsState = initialState(ids, note(A));
    saved = openTab(saved, note(B), { ids });
    const store = memory();
    save(store, saved);
    const tabs = installMainTabs({ storage: store, ids, location: '/' });
    expect(tabs.restored).toBe(true);
    expect(window.location.pathname).toBe(note(B));
    tabs.activate(tabs.getState().tabs[0]!.id);
    expect(window.location.pathname).toBe(note(A));
  });

  it('opens a note the window was opened at in its tab, or a new one, never in place', () => {
    const ids = counter();
    const store = memory();
    save(store, initialState(ids, note(A)));
    const tabs = new TabsController({ storage: store, ids, location: note(C) });
    expect(tabs.getState().tabs).toHaveLength(2);
    expect(activePath(tabs.getState())).toBe(note(C));
    expect(tabs.launchNote).toBe(C);
  });

  it('drops Home tabs a session saved before A1594 holds, and a window left with none is bare', () => {
    const ids = counter();
    const store = memory();
    let saved = initialState(ids, note(A));
    saved = {
      ...saved,
      tabs: [
        ...saved.tabs,
        { id: 'home', pinned: false, entries: [{ path: '/', scrollTop: 0 }], index: 0 },
      ],
    };
    // A tab whose history starts at Home keeps its note.
    saved = {
      ...saved,
      tabs: [
        ...saved.tabs,
        {
          id: 'old',
          pinned: false,
          entries: [
            { path: '/', scrollTop: 0 },
            { path: note(B), scrollTop: 0 },
          ],
          index: 1,
        },
      ],
      active: 'home',
    };
    save(store, saved);
    const tabs = new TabsController({ storage: store, ids, location: '/' });
    const paths = tabs.getState().tabs.map((tab) => tab.entries.map((entry) => entry.path));
    expect(paths).toEqual([[note(A)], [note(B)]]);
    expect(activePath(tabs.getState())).toBe(note(A));
    const bare = memory();
    save(bare, initialState(ids, '/'));
    expect(isBareHome(new TabsController({ storage: bare, ids, location: '/' }).getState())).toBe(
      true,
    );
  });

  it('asks for New Tab’s picker once when the window loads at /?tab=new (A1594)', () => {
    const ids = counter();
    const store = memory();
    save(store, initialState(ids, note(A)));
    const tabs = new TabsController({ storage: store, ids, location: '/?tab=new' });
    expect(tabs.getState().tabs.map((tab) => currentEntry(tab).path)).toEqual([note(A)]);
    expect(tabs.takeNewTabAsk()).toBe(true);
    expect(tabs.takeNewTabAsk()).toBe(false);
    let told = 0;
    tabs.subscribe(() => told++);
    tabs.askNewTab();
    expect(told).toBe(1);
    expect(tabs.takeNewTabAsk()).toBe(true);
  });

  it('sends navigate to the active tab, and Back and Forward step it', () => {
    const ids = counter();
    const tabs = installMainTabs({ storage: memory(), ids, location: '/' });
    navigate(note(A));
    navigate(note(B));
    expect(window.location.pathname).toBe(note(B));
    expect(historyPlace()).toEqual({ back: true, forward: false });
    tabs.open(note(C), false);
    expect(window.location.pathname).toBe(note(C));
    expect(historyPlace()).toEqual({ back: false, forward: false });
    tabs.activate(tabs.getState().tabs[0]!.id);
    goBack();
    expect(window.location.pathname).toBe(note(A));
    // Home is in no tab's history (A1594): the note took the bare Home's place.
    expect(activeTab(tabs.getState()).index).toBe(0);
    expect(historyPlace()).toEqual({ back: false, forward: true });
  });

  it('steps the active tab when the browser goes back', () => {
    const ids = counter();
    const tabs = installMainTabs({ storage: memory(), ids, location: '/' });
    navigate(note(A));
    navigate(note(B));
    const index = (window.history.state as { penmossIndex: number }).penmossIndex;
    window.history.replaceState({ penmossIndex: index - 1 }, '', note(A));
    window.dispatchEvent(new PopStateEvent('popstate', { state: { penmossIndex: index - 1 } }));
    expect(activePath(tabs.getState())).toBe(note(A));
    expect(window.location.pathname).toBe(note(A));
  });

  it('leaves a pinned tab open on ⌘W, and Settings’ “← Notes” goes back to the tab’s page', () => {
    const ids = counter();
    const tabs = installMainTabs({ storage: memory(), ids, location: '/' });
    navigate(note(A));
    tabs.setPinned(tabs.getState().active, true);
    tabs.close(undefined, { fromKey: true });
    expect(tabs.getState().tabs).toHaveLength(1);
    // Its own menu's Close Tab closes it.
    tabs.close(tabs.getState().active);
    expect(activePath(tabs.getState())).toBe('/');
    navigate(note(B));
    navigate('/settings/display');
    navigate('/settings/symbols');
    expect(tabs.leaveSettings()).toBe(true);
    expect(window.location.pathname).toBe(note(B));
  });

  it('opens a page another script pushed in the active tab', () => {
    const tabs = installMainTabs({ storage: memory(), ids: counter(), location: '/' });
    window.history.pushState(null, '', note(C));
    window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
    expect(activePath(tabs.getState())).toBe(note(C));
    expect(activeTab(tabs.getState()).entries.map((entry) => entry.path)).toEqual([note(C)]);
  });

  it('saves a moment after a change, and at once as the page goes', () => {
    vi.useFakeTimers();
    try {
      const store = memory();
      const tabs = installMainTabs({ storage: store, ids: counter(), location: '/' });
      navigate(note(A));
      expect(store.values.has(TABS_KEY)).toBe(false);
      vi.advanceTimersByTime(400);
      expect(load(store)?.tabs[0]?.entries.at(-1)?.path).toBe(note(A));
      tabs.open(note(B), false);
      window.dispatchEvent(new Event('pagehide'));
      expect(load(store)?.tabs).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('saves once more as its window closes, then never again (A1577)', () => {
    vi.useFakeTimers();
    try {
      const store = memory();
      const tabs = installMainTabs({ storage: store, ids: counter(), location: '/' });
      navigate(note(A));
      tabs.closeWindow();
      expect(load(store)?.tabs[0]?.entries.at(-1)?.path).toBe(note(A));
      // A main window opened while this one still pushes, out of sight, saves its own tabs:
      // this page's later changes and its `pagehide` never write over them.
      store.values.set(TABS_KEY, 'the new window’s');
      tabs.open(note(B), false);
      vi.advanceTimersByTime(400);
      window.dispatchEvent(new Event('pagehide'));
      expect(store.values.get(TABS_KEY)).toBe('the new window’s');
    } finally {
      vi.useRealTimers();
    }
  });
});
