/**
 * The main window's note tabs (PEN-140, A1496): a plain value changed by pure functions, so
 * every rule has a unit test (test/unit/tabs-state.test.ts). Each tab is a small browser of its
 * own: its entries (Back and Forward), and for each entry the place it was scrolled to and the
 * note panel it showed. The controller (controller.ts) holds the value for the window, writes
 * the address and saves it; the strip (TabStrip.tsx) shows it.
 *
 * - A tab's entries are any of the main window's paths: a note (`/notes/:id?heading=…`), Home
 *   (`/`), the graph, Trash, and Settings' pages, which show full-window as before (A1497).
 * - A pinned tab keeps its page: a plain click elsewhere opens a new tab instead (A1499).
 * - Closing the only tab leaves a Home tab; the last 20 closed tabs can be reopened.
 */

/** The note panel of an entry: open or closed, and on which of its tabs. */
export interface PanelState {
  readonly open: boolean;
  readonly tab: string;
}

/** One page in a tab's history. */
export interface Entry {
  readonly path: string;
  /** `.note-scroll`'s scrollTop when the entry was left (0 until then). */
  readonly scrollTop: number;
  /** The note panel when the entry was left; absent until a note showed in it. */
  readonly panel?: PanelState;
}

export interface Tab {
  /** Random, local to the window. */
  readonly id: string;
  readonly pinned: boolean;
  /** Oldest first; `index` is the one showing. Never empty. */
  readonly entries: readonly Entry[];
  readonly index: number;
  /** The tab it was opened from in the background, for where the next one goes (as browsers do). */
  readonly opener?: string;
}

export interface ClosedTab {
  readonly tab: Tab;
  /** Its place in the strip when it closed. */
  readonly position: number;
}

export interface TabsState {
  readonly tabs: readonly Tab[];
  readonly active: string;
  /** Most recently closed last. */
  readonly closed: readonly ClosedTab[];
}

/** How many entries a tab keeps: the oldest go first. */
export const MAX_ENTRIES = 50;
/** How many closed tabs Reopen Closed Tab can bring back. */
export const MAX_CLOSED = 20;
/** How many tabs are saved for the next launch, pinned ones first. */
export const MAX_SAVED = 50;

export const HOME_PATH = '/';

/** The path a note window sends the main window for ⌘T there: a new tab, in front (A1503). */
export const NEW_TAB_PATH = '/?tab=new';

/** Makes the ids of new tabs (random by default; tests pass a counter). */
export type IdMaker = () => string;

export const randomId: IdMaker = () => {
  try {
    return crypto.randomUUID();
  } catch {
    return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  }
};

const NOTE_PATH = /^\/notes\/([^/?#]+)\/?(?:\?.*)?$/;

/** The note a path shows, or null for other pages. */
export function noteIdOfPath(path: string): string | null {
  const match = NOTE_PATH.exec(path);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]!);
  } catch {
    return null;
  }
}

/** Whether a path is one of Settings' pages: Back reaches them, a pinned tab never rests on one. */
export const isSettingsPath = (path: string): boolean =>
  path === '/settings' || path.startsWith('/settings/') || path.startsWith('/settings?');

const entry = (path: string): Entry => ({ path, scrollTop: 0 });

function makeTab(id: string, path: string, extra: Partial<Tab> = {}): Tab {
  return { id, pinned: false, entries: [entry(path)], index: 0, ...extra };
}

/** One tab showing `path`. */
export function initialState(ids: IdMaker = randomId, path = HOME_PATH): TabsState {
  const tab = makeTab(ids(), path);
  return { tabs: [tab], active: tab.id, closed: [] };
}

export function currentEntry(tab: Tab): Entry {
  return tab.entries[tab.index] ?? tab.entries[tab.entries.length - 1]!;
}

export function activeTab(state: TabsState): Tab {
  return state.tabs.find((tab) => tab.id === state.active) ?? state.tabs[0]!;
}

/**
 * The window has no note open (A1576): its one tab, unpinned, is on Home (or a new tab's Home).
 * The strip then shows no tab, only +, and closing that tab does nothing.
 */
export function isBareHome(state: TabsState): boolean {
  if (state.tabs.length !== 1) return false;
  const tab = state.tabs[0]!;
  return !tab.pinned && currentEntry(tab).path.split('?')[0] === HOME_PATH;
}

/** How many tabs the strip shows: none while the window is on a bare Home (A1576). */
export const shownTabCount = (state: TabsState): number =>
  isBareHome(state) ? 0 : state.tabs.length;

/** The page the window shows now: the active tab's entry. */
export const activePath = (state: TabsState): string => currentEntry(activeTab(state)).path;

/** The tab of that id, or undefined. */
export const tabById = (state: TabsState, id: string): Tab | undefined =>
  state.tabs.find((tab) => tab.id === id);

const pinnedCount = (tabs: readonly Tab[]) => tabs.filter((tab) => tab.pinned).length;

function replaceTab(state: TabsState, next: Tab): TabsState {
  return { ...state, tabs: state.tabs.map((tab) => (tab.id === next.id ? next : tab)) };
}

/** A tab's entries with one more after its current one (dropping those ahead, and the oldest). */
function pushEntry(tab: Tab, path: string): Tab {
  const entries = [...tab.entries.slice(0, tab.index + 1), entry(path)];
  const dropped = Math.max(0, entries.length - MAX_ENTRIES);
  return { ...tab, entries: entries.slice(dropped), index: entries.length - 1 - dropped };
}

function replaceEntry(tab: Tab, path: string): Tab {
  const entries = tab.entries.map((item, index) =>
    index === tab.index ? { ...item, path } : item,
  );
  return { ...tab, entries };
}

/**
 * The active tab goes to `path`: a new entry after its current one, or in its place with
 * `replace`. A pinned tab keeps its page: going elsewhere opens a new active tab to its right
 * (Settings, full-window, is the exception: Back returns from it).
 */
export function navigateActive(
  state: TabsState,
  path: string,
  options: { readonly replace?: boolean; readonly ids?: IdMaker } = {},
): TabsState {
  const tab = activeTab(state);
  const current = currentEntry(tab).path;
  if (current === path) return state;
  if (options.replace) return replaceTab(state, replaceEntry(tab, path));
  if (tab.pinned && !isSettingsPath(path) && !isSettingsPath(current)) {
    return openTab(state, path, { background: false, ids: options.ids });
  }
  return replaceTab(state, pushEntry(tab, path));
}

/** Where a new tab goes: right of the active one, after the tabs opened from it in the background. */
function insertionIndex(state: TabsState, background: boolean): number {
  const at = state.tabs.findIndex((tab) => tab.id === state.active);
  let index = at + 1;
  if (background) {
    while (index < state.tabs.length && state.tabs[index]!.opener === state.active) index++;
  }
  return Math.max(index, pinnedCount(state.tabs));
}

/**
 * A new tab showing `path`, right of the active one. In the background (⌘-click) the active tab
 * stays, and later background tabs from it go after this one, as in a browser; otherwise it
 * becomes active (⇧⌘-click, ⌘T).
 */
export function openTab(
  state: TabsState,
  path: string,
  options: {
    readonly background?: boolean;
    readonly ids?: IdMaker | undefined;
    readonly at?: number | undefined;
  } = {},
): TabsState {
  // A bare Home is no tab to keep (A1576): the new one takes its place, and with nothing else
  // to show it is the tab on screen, behind or not.
  if (isBareHome(state)) {
    const only = makeTab((options.ids ?? randomId)(), path);
    return { ...state, tabs: [only], active: only.id };
  }
  const background = options.background ?? false;
  const tab = makeTab(
    (options.ids ?? randomId)(),
    path,
    background ? { opener: state.active } : {},
  );
  const pinned = pinnedCount(state.tabs);
  const index =
    options.at === undefined
      ? insertionIndex(state, background)
      : Math.min(Math.max(options.at, pinned), state.tabs.length);
  const tabs = [...state.tabs.slice(0, index), tab, ...state.tabs.slice(index)];
  // A tab chosen from the strip or opened in front ends the run of background tabs.
  const cleared = background ? tabs : tabs.map((item) => clearOpener(item));
  return { ...state, tabs: cleared, active: background ? state.active : tab.id };
}

function clearOpener(tab: Tab): Tab {
  if (tab.opener === undefined) return tab;
  return { id: tab.id, pinned: tab.pinned, entries: tab.entries, index: tab.index };
}

/**
 * For a note opened from outside the window's pages (the menu bar icon, a deep link, Open
 * Today's Journal, a note window): the tab already showing it becomes active, else a new active
 * tab shows it. It never replaces the page on screen (A1498).
 */
export function showInTab(state: TabsState, path: string, ids: IdMaker = randomId): TabsState {
  if (noteIdOfPath(path) === null) return navigateActive(state, path, { ids });
  const showing = tabShowing(state, path);
  if (showing !== null) return switchToTab(state, showing, path);
  return openTab(state, path, { background: false, ids });
}

/**
 * The tab whose page is the note `path` opens, the active one first; null for a page that is no
 * note, or a note no tab shows (A1498, A1574).
 */
export function tabShowing(state: TabsState, path: string): string | null {
  const note = noteIdOfPath(path);
  if (note === null) return null;
  const shows = (tab: Tab) => noteIdOfPath(currentEntry(tab).path) === note;
  if (shows(activeTab(state))) return state.active;
  return state.tabs.find(shows)?.id ?? null;
}

/** Tab `id` made active, showing `path` in place of its page (a heading, say) when it differs. */
export function switchToTab(state: TabsState, id: string, path: string): TabsState {
  const activated = activate(state, id);
  if (currentEntry(activeTab(activated)).path === path) return activated;
  return navigateActive(activated, path, { replace: true });
}

export function activate(state: TabsState, id: string): TabsState {
  if (state.active === id || !tabById(state, id)) return state;
  return { ...state, active: id, tabs: state.tabs.map(clearOpener) };
}

/** The next (1) or previous (-1) tab, wrapping round at the ends (⌃Tab, ⇧⌃Tab). */
export function cycle(state: TabsState, delta: 1 | -1): TabsState {
  const at = state.tabs.findIndex((tab) => tab.id === state.active);
  const count = state.tabs.length;
  return activate(state, state.tabs[(at + delta + count) % count]!.id);
}

/** The nth tab from the start, 0-based (⌘1–⌘8); past the end, nothing. */
export function selectNth(state: TabsState, n: number): TabsState {
  const tab = state.tabs[n];
  return tab ? activate(state, tab.id) : state;
}

/** The last tab (⌘9). */
export const selectLast = (state: TabsState): TabsState =>
  activate(state, state.tabs[state.tabs.length - 1]!.id);

function remember(closed: readonly ClosedTab[], tab: Tab, position: number): ClosedTab[] {
  return [...closed, { tab: clearOpener(tab), position }].slice(-MAX_CLOSED);
}

/**
 * Closes tab `id`: the tab to its right becomes active, else the one to its left. Closing the
 * only tab leaves a Home tab, which the strip does not show, and the window stays open; with
 * only that Home, nothing closes (A1576). Pinned or not: the commands decide whether a pinned
 * tab closes (⌘W leaves it).
 */
export function closeTab(state: TabsState, id: string, ids: IdMaker = randomId): TabsState {
  const position = state.tabs.findIndex((tab) => tab.id === id);
  if (position < 0 || isBareHome(state)) return state;
  const tab = state.tabs[position]!;
  const tabs = state.tabs.filter((item) => item.id !== id);
  const closed = remember(state.closed, tab, position);
  if (tabs.length === 0) {
    const home = makeTab(ids(), HOME_PATH);
    return { tabs: [home], active: home.id, closed };
  }
  const active =
    state.active === id ? (tabs[position] ?? tabs[position - 1] ?? tabs[0]!).id : state.active;
  return {
    tabs: tabs.map((item) => (item.opener === id ? clearOpener(item) : item)),
    active,
    closed,
  };
}

/** Closes every tab but `id` and the pinned ones (Close Other Tabs). */
export function closeOthers(state: TabsState, id: string): TabsState {
  let next = activate(state, id);
  for (const tab of state.tabs) {
    if (tab.id !== id && !tab.pinned) next = closeTab(next, tab.id);
  }
  return next;
}

/** Closes the unpinned tabs to the right of `id` (Close Tabs to the Right). */
export function closeRight(state: TabsState, id: string): TabsState {
  const at = state.tabs.findIndex((tab) => tab.id === id);
  if (at < 0) return state;
  let next = state;
  const right = state.tabs.slice(at + 1).filter((tab) => !tab.pinned);
  if (right.some((tab) => tab.id === state.active)) next = activate(next, id);
  for (const tab of right) next = closeTab(next, tab.id);
  return next;
}

/**
 * Reopens the last closed tab at its old place (or the end), with its history, scroll, panel and
 * pin, as the active tab. A tab whose page is a note `usable` refuses (in Trash, unknown) is
 * skipped, and so on back through the closed list.
 */
export function reopenClosed(
  state: TabsState,
  usable: (noteId: string) => boolean = () => true,
  ids: IdMaker = randomId,
): TabsState {
  const closed = [...state.closed];
  while (closed.length > 0) {
    const item = closed.pop()!;
    const note = noteIdOfPath(currentEntry(item.tab).path);
    if (note !== null && !usable(note)) continue;
    // A tab open again already (a toast's Restore put it back): it takes a new id, so the strip
    // never holds two tabs of one id.
    const tab = tabById(state, item.tab.id) ? { ...item.tab, id: ids() } : item.tab;
    const { position } = item;
    const pinned = pinnedCount(state.tabs);
    const at = tab.pinned
      ? Math.min(position, pinned)
      : Math.min(Math.max(position, pinned), state.tabs.length);
    const tabs = [...state.tabs.slice(0, at), tab, ...state.tabs.slice(at)];
    return { tabs: tabs.map(clearOpener), active: tab.id, closed };
  }
  return { ...state, closed };
}

/**
 * The state with its rules kept whatever changed it: at least one tab, no two of one id, and an
 * active tab that is one of them (else the first). The controller settles every change, so the
 * strip always marks the tab the pane shows (AC1).
 */
export function settle(state: TabsState, ids: IdMaker = randomId): TabsState {
  if (state.tabs.length === 0) {
    const home = makeTab(ids(), HOME_PATH);
    return { ...state, tabs: [home], active: home.id };
  }
  const seen = new Set<string>();
  let unique = true;
  for (const tab of state.tabs) {
    if (seen.has(tab.id)) unique = false;
    seen.add(tab.id);
  }
  const tabs = unique
    ? state.tabs
    : state.tabs.filter((tab, index) => state.tabs.findIndex((t) => t.id === tab.id) === index);
  const active = tabs.some((tab) => tab.id === state.active) ? state.active : tabs[0]!.id;
  return unique && active === state.active ? state : { ...state, tabs, active };
}

/** Moves tab `id` to `to` (an index of the strip), within its group: pinned or not. */
export function moveTab(state: TabsState, id: string, to: number): TabsState {
  const from = state.tabs.findIndex((tab) => tab.id === id);
  if (from < 0) return state;
  const tab = state.tabs[from]!;
  const pinned = pinnedCount(state.tabs);
  const [low, high] = tab.pinned ? [0, pinned - 1] : [pinned, state.tabs.length - 1];
  const target = Math.min(Math.max(to, low), high);
  if (target === from) return state;
  const tabs = state.tabs.filter((item) => item.id !== id);
  tabs.splice(target, 0, tab);
  return { ...state, tabs: tabs.map(clearOpener) };
}

/** Pin Tab: to the end of the pinned group at the strip's start. Unpin: to the start of the rest. */
export function setPinned(state: TabsState, id: string, pinned: boolean): TabsState {
  const tab = tabById(state, id);
  if (!tab || tab.pinned === pinned) return state;
  const rest = state.tabs.filter((item) => item.id !== id).map(clearOpener);
  const at = pinnedCount(rest);
  rest.splice(at, 0, { ...clearOpener(tab), pinned });
  return { ...state, tabs: rest };
}

/** Duplicate Tab: a copy with the same history right after it, active. */
export function duplicateTab(state: TabsState, id: string, ids: IdMaker = randomId): TabsState {
  const at = state.tabs.findIndex((tab) => tab.id === id);
  if (at < 0) return state;
  const source = state.tabs[at]!;
  const copy: Tab = {
    id: ids(),
    pinned: false,
    entries: source.entries,
    index: source.index,
  };
  const index = Math.max(at + 1, pinnedCount(state.tabs));
  const tabs = [...state.tabs.slice(0, index), copy, ...state.tabs.slice(index)].map(clearOpener);
  return { ...state, tabs, active: copy.id };
}

/** Whether the active tab can go back or forward, skipping the entries `skip` leaves out. */
export function historyPlaceOf(
  state: TabsState,
  skip: (entry: Entry) => boolean = () => false,
): { readonly back: boolean; readonly forward: boolean } {
  const tab = activeTab(state);
  return {
    back: stepIndex(tab, -1, skip) !== null,
    forward: stepIndex(tab, 1, skip) !== null,
  };
}

/** The entry Back (-1) or Forward (1) would show in the active tab, or null (its tooltip, AC6). */
export function stepTarget(
  state: TabsState,
  delta: 1 | -1,
  skip: (entry: Entry) => boolean = () => false,
): Entry | null {
  const tab = activeTab(state);
  const index = stepIndex(tab, delta, skip);
  return index === null ? null : tab.entries[index]!;
}

function stepIndex(tab: Tab, delta: 1 | -1, skip: (entry: Entry) => boolean): number | null {
  for (let index = tab.index + delta; index >= 0 && index < tab.entries.length; index += delta) {
    if (!skip(tab.entries[index]!)) return index;
  }
  return null;
}

/**
 * Back (-1) or Forward (1) in the active tab, past the entries `skip` leaves out (a note in
 * Trash deeper in its history). Nowhere to go: unchanged.
 */
export function step(
  state: TabsState,
  delta: 1 | -1,
  skip: (entry: Entry) => boolean = () => false,
): TabsState {
  const tab = activeTab(state);
  const index = stepIndex(tab, delta, skip);
  return index === null ? state : replaceTab(state, { ...tab, index });
}

/**
 * Settings' "← Notes": the active tab back to the page it showed before Settings (A1497), as
 * Back would take it; null when the tab has none (it opened on Settings).
 */
export function leaveSettings(state: TabsState): TabsState | null {
  const tab = activeTab(state);
  const index = pageIndex(tab);
  if (index === null) return null;
  return index === tab.index ? state : replaceTab(state, { ...tab, index });
}

/**
 * Where a tab's page is in its history: its current entry, or under Settings (full-window, A1497)
 * the page Settings goes back to; null when the tab opened on Settings.
 */
function pageIndex(tab: Tab): number | null {
  for (let index = Math.min(tab.index, tab.entries.length - 1); index >= 0; index--) {
    if (!isSettingsPath(tab.entries[index]!.path)) return index;
  }
  return null;
}

/** The active tab's page without its kept panel: it opens from the note's own memory again. */
export function forgetPanel(state: TabsState): TabsState {
  const tab = activeTab(state);
  const current = currentEntry(tab);
  if (!current.panel) return state;
  const entry: Entry = { path: current.path, scrollTop: current.scrollTop };
  const entries = tab.entries.map((item, index) => (index === tab.index ? entry : item));
  return replaceTab(state, { ...tab, entries });
}

/** Changes tab `id`'s current entry (its scroll position, its panel). */
export function updateEntry(
  state: TabsState,
  id: string,
  change: Partial<Omit<Entry, 'path'>>,
  path?: string,
): TabsState {
  const tab = tabById(state, id);
  if (!tab) return state;
  const current = currentEntry(tab);
  if (path !== undefined && current.path !== path) return state;
  const merged = { ...current, ...change };
  if (
    merged.scrollTop === current.scrollTop &&
    merged.panel?.open === current.panel?.open &&
    merged.panel?.tab === current.panel?.tab
  ) {
    return state;
  }
  const entries = tab.entries.map((item, index) => (index === tab.index ? merged : item));
  return replaceTab(state, { ...tab, entries });
}

function retargetPath(path: string, from: string, to: string): string {
  if (noteIdOfPath(path) !== from) return path;
  const at = path.indexOf('?');
  return `/notes/${encodeURIComponent(to)}${at < 0 ? '' : path.slice(at)}`;
}

function retargetTab(tab: Tab, from: string, to: string): Tab {
  let changed = false;
  const entries = tab.entries.map((item) => {
    const path = retargetPath(item.path, from, to);
    if (path === item.path) return item;
    changed = true;
    return { ...item, path };
  });
  return changed ? { ...tab, entries } : tab;
}

/**
 * A note moved to another notebook from this window is a new note there (transfer.ts): every
 * entry of every tab, and of the closed tabs, follows it to its new id.
 */
export function retarget(state: TabsState, from: string, to: string): TabsState {
  const tabs = state.tabs.map((tab) => retargetTab(tab, from, to));
  const closed = state.closed.map((item) => {
    const tab = retargetTab(item.tab, from, to);
    return tab === item.tab ? item : { ...item, tab };
  });
  const same = tabs.every((tab, index) => tab === state.tabs[index]);
  const sameClosed = closed.every((item, index) => item === state.closed[index]);
  return same && sameClosed ? state : { ...state, tabs, closed };
}

/** What a close because of a note or a notebook did: the state after, and the tabs it closed. */
export interface Closing {
  readonly state: TabsState;
  /** The closed tabs, each with its place, in strip order. */
  readonly closed: readonly ClosedTab[];
}

/**
 * Closes every tab whose page now is a note `gone` names (moved to Trash, its notebook closed).
 * They go on the closed list, so Reopen Closed Tab (or a toast's Restore) brings them back.
 *
 * A tab showing Settings counts by the page under it, the one Settings goes back to: a notebook
 * removed in Settings closes the tab of its note that Settings was opened from. That tab is kept
 * at its page, so it reopens there and not on Settings, and the window stays on Settings, which
 * then goes back to the tab that is active now.
 */
export function closeTabsShowing(
  state: TabsState,
  gone: (noteId: string) => boolean,
  ids: IdMaker = randomId,
): Closing {
  const closing = state.tabs
    .map((tab, position) => {
      const index = pageIndex(tab);
      return { tab: index === null ? tab : { ...tab, index }, position, index };
    })
    .filter(({ tab, index }) => {
      const note = index === null ? null : noteIdOfPath(currentEntry(tab).path);
      return note !== null && gone(note);
    })
    .map(({ tab, position }) => ({ tab, position }));
  if (closing.length === 0) return { state, closed: [] };
  const shown = currentEntry(activeTab(state)).path;
  const onSettings =
    isSettingsPath(shown) && closing.some(({ tab }) => tab.id === activeTab(state).id);
  let next = state;
  for (const { tab } of closing) next = replaceTab(next, tab);
  // Right to left: the places stay those of the strip as it was.
  for (const { tab } of [...closing].reverse()) next = closeTab(next, tab.id, ids);
  if (onSettings) next = navigateActive(next, shown, { ids });
  return {
    state: next,
    closed: closing.map(({ tab, position }) => ({ tab: clearOpener(tab), position })),
  };
}

/** Puts closed tabs back at their places (a toast's Restore), the first of them active. */
export function restoreTabs(state: TabsState, tabs: readonly ClosedTab[]): TabsState {
  if (tabs.length === 0) return state;
  const ids = new Set(tabs.map((item) => item.tab.id));
  let next: TabsState = { ...state, closed: state.closed.filter((item) => !ids.has(item.tab.id)) };
  // A lone Home tab made when the last one closed goes again.
  const only = next.tabs.length === 1 ? next.tabs[0]! : null;
  const dropHome =
    only !== null && only.entries.length === 1 && currentEntry(only).path === HOME_PATH;
  if (dropHome) next = { ...next, tabs: [] };
  for (const item of tabs) {
    if (tabById(next, item.tab.id)) continue;
    const pinned = pinnedCount(next.tabs);
    const at = item.tab.pinned
      ? Math.min(item.position, pinned)
      : Math.min(Math.max(item.position, pinned), next.tabs.length);
    next = { ...next, tabs: [...next.tabs.slice(0, at), item.tab, ...next.tabs.slice(at)] };
  }
  if (next.tabs.length === 0) return state;
  return { ...next, active: tabs[0]!.tab.id };
}

/**
 * Drops the entries whose note `known` does not know (once the notebooks have loaded): a tab
 * left with none goes, and with no tab left, Home opens.
 */
export function dropUnknown(
  state: TabsState,
  known: (noteId: string) => boolean,
  ids: IdMaker = randomId,
): TabsState {
  const keep = (item: Entry) => {
    const note = noteIdOfPath(item.path);
    return note === null || known(note);
  };
  let changed = false;
  const tabs: Tab[] = [];
  for (const tab of state.tabs) {
    if (tab.entries.every(keep)) {
      tabs.push(tab);
      continue;
    }
    changed = true;
    const before = tab.entries.slice(0, tab.index + 1).filter(keep).length;
    const entries = tab.entries.filter(keep);
    if (entries.length === 0) continue;
    tabs.push({ ...tab, entries, index: Math.max(0, Math.min(before - 1, entries.length - 1)) });
  }
  const closed = state.closed.filter((item) => item.tab.entries.some(keep));
  if (!changed && closed.length === state.closed.length) return state;
  if (tabs.length === 0) {
    const home = makeTab(ids(), HOME_PATH);
    return { tabs: [home], active: home.id, closed };
  }
  const activeKept = tabs.some((tab) => tab.id === state.active);
  if (activeKept) return { tabs, active: state.active, closed };
  // The active tab went: its right-hand neighbour in the old strip, else the last.
  const at = state.tabs.findIndex((tab) => tab.id === state.active);
  const after = state.tabs.slice(at + 1).find((tab) => tabs.some((kept) => kept.id === tab.id));
  return { tabs, active: (after ?? tabs[tabs.length - 1]!).id, closed };
}

/** The note ids every tab (and closed tab) holds, for the kept editors (A1500). */
export function notesInTabs(state: TabsState): Set<string> {
  const ids = new Set<string>();
  for (const tab of state.tabs) {
    for (const item of tab.entries) {
      const note = noteIdOfPath(item.path);
      if (note !== null) ids.add(note);
    }
  }
  return ids;
}

/** The notes tabs show now, most recently active first: the active tab's, then left to right. */
export function shownNotes(state: TabsState): string[] {
  const order = [activeTab(state), ...state.tabs.filter((tab) => tab.id !== state.active)];
  const out: string[] = [];
  for (const tab of order) {
    const note = noteIdOfPath(currentEntry(tab).path);
    if (note !== null && !out.includes(note)) out.push(note);
  }
  return out;
}
