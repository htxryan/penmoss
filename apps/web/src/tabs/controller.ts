/**
 * The main window's tabs for the window's lifetime (PEN-140, A1496, A1497): the state
 * (state.ts), the address that follows its active page, and saving it for the next launch.
 *
 * The router hands it the window's history (`setHistoryDriver`): `navigate` goes to the active
 * tab, and Back and Forward step its entries. The address is written with the History API: a
 * page opened in the tab pushes a browser entry, and anything else (a switch, a step) replaces
 * it, so a reload starts from the active tab's page. The browser's own Back and Forward (a
 * browser's buttons and keys, `popstate`) step the active tab too, by as many entries as the
 * browser moved.
 */
import {
  browserEntryIndex,
  setHistoryDriver,
  writeAddress,
  type HistoryDriver,
  type HistoryPlace,
} from '../router';
import type { KeyValueStore } from '../shell/key-value';
import { load, save } from './persist';
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
  forgetPanel,
  duplicateTab,
  historyPlaceOf,
  initialState,
  leaveSettings,
  moveTab,
  navigateActive,
  noteIdOfPath,
  openTab,
  randomId,
  reopenClosed,
  restoreTabs,
  retarget,
  selectLast,
  selectNth,
  setPinned,
  settle,
  showInTab,
  step,
  stepTarget,
  isHomePath,
  withoutHome,
  switchToTab,
  tabShowing,
  updateEntry,
  HOME_PATH,
  NEW_TAB_PATH,
  type ClosedTab,
  type Closing,
  type Entry,
  type IdMaker,
  type PanelState,
  type TabsState,
} from './state';

/** How long after a change the tabs are saved (and at once as the page goes, A228). */
export const SAVE_MS = 300;

export interface TabsOptions {
  readonly storage: KeyValueStore | null;
  readonly ids?: IdMaker;
  /** The address when the window loaded: the saved tabs are shown around it. */
  readonly location?: string;
}

type Listener = () => void;

export class TabsController implements HistoryDriver {
  private state: TabsState;
  private readonly listeners = new Set<Listener>();
  private readonly ids: IdMaker;
  private readonly storage: KeyValueStore | null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Closing (`closeWindow`): saves nothing more. */
  private closed = false;
  /** The browser entry the address is at (`history.state.penmossIndex`). */
  private browserIndex = 0;
  private placeCache: HistoryPlace = { back: false, forward: false };
  /** Notes Back and Forward pass over (in Trash): the shell tells (TabsRoot). */
  private gone: (noteId: string) => boolean = () => false;
  /** Whether saved tabs were found at launch (then they, not the last note, open). */
  readonly restored: boolean;
  /**
   * The note the window was opened at, if any (a deep link, a reload): never dropped as unknown,
   * since a notebook still cloning may not know it yet; it shows "Opening the note…" meanwhile.
   */
  readonly launchNote: string | null;

  constructor(options: TabsOptions) {
    this.ids = options.ids ?? randomId;
    this.storage = options.storage;
    // A session saved before A1594 can hold Home tabs: they go.
    const loaded = load(options.storage);
    const saved = loaded ? withoutHome(loaded, this.ids) : null;
    this.restored = saved !== null;
    this.launchNote = noteIdOfPath(options.location ?? HOME_PATH);
    const at = options.location ?? HOME_PATH;
    const location = at === NEW_TAB_PATH ? HOME_PATH : at;
    this.state = saved ? startFrom(saved, at, this.ids) : initialState(this.ids, location);
    if (at === NEW_TAB_PATH) this.newTabAsked = true;
  }

  getState = (): TabsState => this.state;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Starts following the window: its address, `popstate`, and saving as the page goes. */
  attach(): () => void {
    this.browserIndex = browserEntryIndex();
    writeAddress(activePath(this.state), 'replace', this.browserIndex);
    const onPop = (event: PopStateEvent) => this.popped(event.state);
    const onHide = () => this.flush();
    window.addEventListener('popstate', onPop);
    window.addEventListener('pagehide', onHide);
    setHistoryDriver(this);
    return () => {
      window.removeEventListener('popstate', onPop);
      window.removeEventListener('pagehide', onHide);
      setHistoryDriver(null);
      this.flush();
    };
  }

  /** Saves now (before quitting, as the page goes). */
  flush(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.persist();
  }

  /**
   * The window is closing (A1577): saves now, and never again. It goes from the screen at once
   * while its page still pushes, and a main window opened meanwhile has the tabs from here on;
   * this page's later saves (its `pagehide` as it goes) would write over them.
   */
  closeWindow(): void {
    this.flush();
    this.closed = true;
  }

  private persist(): void {
    if (!this.closed) save(this.storage, this.state);
  }

  /** Which notes Back and Forward pass over (a note in Trash deeper in a tab's history). */
  setGone(gone: (noteId: string) => boolean): void {
    this.gone = gone;
  }

  private skip = (entry: Entry): boolean => {
    // Home is no tab's page (A1594): only the empty window's, under Settings opened there. Beside
    // other tabs it is passed over; so is a note in Trash (A1501).
    if (isHomePath(entry.path)) return this.state.tabs.length > 1;
    const note = noteIdOfPath(entry.path);
    return note !== null && this.gone(note);
  };

  /**
   * Takes the next state. The address follows the active page: `push` writes a new browser
   * entry when that page is new, otherwise the current entry changes in place.
   */
  private commit(proposed: TabsState, mode: 'push' | 'replace' = 'replace'): void {
    if (proposed === this.state) return;
    const next = settle(proposed, this.ids);
    const before = this.state;
    this.state = next;
    const pathChanged = activePath(before) !== activePath(next);
    const moved =
      pathChanged || before.active !== next.active || activeTab(before) !== activeTab(next);
    if (moved && typeof window !== 'undefined') {
      if (mode === 'push' && pathChanged) this.browserIndex++;
      writeAddress(
        activePath(next),
        mode === 'push' && pathChanged ? 'push' : 'replace',
        this.browserIndex,
      );
    }
    for (const listener of [...this.listeners]) listener();
    this.timer ??= setTimeout(() => {
      this.timer = null;
      this.persist();
    }, SAVE_MS);
  }

  // The router's side (HistoryDriver).

  navigate(path: string, replace: boolean): void {
    const next = navigateActive(this.state, path, { replace, ids: this.ids });
    this.commit(next, replace ? 'replace' : 'push');
  }

  back(): void {
    this.commit(step(this.state, -1, this.skip));
  }

  forward(): void {
    this.commit(step(this.state, 1, this.skip));
  }

  /** The page Back (-1) or Forward (1) would show in the active tab, or null. */
  target(delta: 1 | -1): string | null {
    return stepTarget(this.state, delta, this.skip)?.path ?? null;
  }

  place(): HistoryPlace {
    const place = historyPlaceOf(this.state, this.skip);
    if (place.back !== this.placeCache.back || place.forward !== this.placeCache.forward) {
      this.placeCache = place;
    }
    return this.placeCache;
  }

  open(path: string, background: boolean): void {
    this.commit(openTab(this.state, path, { background, ids: this.ids }));
  }

  show(path: string): void {
    this.commit(showInTab(this.state, path, this.ids));
  }

  reveal(path: string, intent: 'current' | 'background' | 'foreground'): boolean {
    const id = tabShowing(this.state, path);
    if (id === null) return false;
    // Behind: no second tab of it; the tab that has it is pointed out.
    if (intent === 'background') {
      flashTab(id);
      return true;
    }
    // The tab on screen has it already: a plain click goes there as it always did.
    if (id === this.state.active) return intent !== 'current';
    this.commit(switchToTab(this.state, id, path));
    return true;
  }

  /** The browser went back or forward (its buttons, `history.go`): the active tab follows. */
  private popped(state: unknown): void {
    const marked =
      typeof state === 'object' &&
      state !== null &&
      typeof (state as Record<string, unknown>)['penmossIndex'] === 'number';
    if (!marked) {
      // An entry the app did not make (a script's `pushState`, then `popstate`): a page opened
      // in the active tab, as `navigate` would.
      const path = window.location.pathname + window.location.search;
      this.browserIndex++;
      const next = settle(navigateActive(this.state, path, { ids: this.ids }), this.ids);
      this.state = next;
      writeAddress(activePath(next), 'replace', this.browserIndex);
      for (const listener of [...this.listeners]) listener();
      this.scheduleSave();
      return;
    }
    const index = browserEntryIndex(state);
    const delta = index - this.browserIndex;
    this.browserIndex = index;
    let next = this.state;
    for (let count = 0; count < Math.abs(delta); count++) {
      next = step(next, delta < 0 ? -1 : 1, this.skip);
    }
    // The browser's address is that entry's: back to the active tab's page.
    next = settle(next, this.ids);
    this.state = next;
    writeAddress(activePath(next), 'replace', this.browserIndex);
    for (const listener of [...this.listeners]) listener();
    this.scheduleSave();
  }

  private scheduleSave(): void {
    this.timer ??= setTimeout(() => {
      this.timer = null;
      this.persist();
    }, SAVE_MS);
  }

  // The tabs' own commands.

  /** Settings' "← Notes": back to the tab's page before Settings; false when it has none. */
  leaveSettings(): boolean {
    const next = leaveSettings(this.state);
    if (next === null) return false;
    this.commit(next);
    return true;
  }

  /**
   * A new tab asked for from outside the window (a note window's ⌘T, `/?tab=new` at launch): the
   * window's New Tab picker opens for it (A1594). Taken once by whoever shows the picker.
   */
  private newTabAsked = false;

  askNewTab(): void {
    this.newTabAsked = true;
    for (const listener of [...this.listeners]) listener();
  }

  takeNewTabAsk(): boolean {
    const asked = this.newTabAsked;
    this.newTabAsked = false;
    return asked;
  }

  /** Opens `path` in a new tab dropped at `at` in the strip (a note dragged onto it), in front. */
  openAt(path: string, at: number): void {
    this.commit(openTab(this.state, path, { background: false, ids: this.ids, at }));
  }

  /**
   * Closes a tab. `fromKey` (⌘W, Close Tab from the menu) leaves a pinned tab open (A1499); its
   * own menu's Close Tab closes it.
   */
  close(id: string = this.state.active, options: { readonly fromKey?: boolean } = {}): void {
    const tab = this.state.tabs.find((item) => item.id === id);
    if (!tab || (options.fromKey && tab.pinned)) return;
    this.commit(closeTab(this.state, id, this.ids));
  }

  closeOthers(id: string = this.state.active): void {
    this.commit(closeOthers(this.state, id));
  }

  closeRight(id: string = this.state.active): void {
    this.commit(closeRight(this.state, id));
  }

  reopenClosed(usable?: (noteId: string) => boolean): void {
    this.commit(reopenClosed(this.state, usable ?? ((note) => !this.gone(note)), this.ids));
  }

  activate(id: string): void {
    this.commit(activate(this.state, id));
  }

  cycle(delta: 1 | -1): void {
    this.commit(cycle(this.state, delta));
  }

  selectNth(n: number): void {
    this.commit(selectNth(this.state, n));
  }

  selectLast(): void {
    this.commit(selectLast(this.state));
  }

  move(id: string, to: number): void {
    this.commit(moveTab(this.state, id, to));
  }

  setPinned(id: string, pinned: boolean): void {
    this.commit(setPinned(this.state, id, pinned));
  }

  duplicate(id: string = this.state.active): void {
    this.commit(duplicateTab(this.state, id, this.ids));
  }

  /** The scroll position and panel of tab `id`'s page, if it still shows `path`. */
  remember(id: string, path: string, change: { scrollTop?: number; panel?: PanelState }): void {
    const next = updateEntry(this.state, id, change, path);
    if (next === this.state) return;
    // Not a navigation: the address stays, and nothing re-renders but the tabs' own followers.
    this.state = next;
    this.timer ??= setTimeout(() => {
      this.timer = null;
      this.persist();
    }, SAVE_MS);
  }

  /** A note moved to another notebook from this window: its tabs follow it (A1501). */
  retarget(from: string, to: string): void {
    this.commit(retarget(this.state, from, to));
  }

  /** Closes the tabs showing a note `gone` names; returns what closed (for Restore). */
  closeShowing(gone: (noteId: string) => boolean): readonly ClosedTab[] {
    const closing: Closing = closeTabsShowing(this.state, gone, this.ids);
    this.commit(closing.state);
    return closing.closed;
  }

  /** Puts closed tabs back where they were (Restore on a toast). */
  restore(tabs: readonly ClosedTab[]): void {
    this.commit(restoreTabs(this.state, tabs));
  }

  /** Drops the pages of notes no open notebook knows, once they are all read (A1496). */
  dropUnknown(known: (noteId: string) => boolean): void {
    this.commit(dropUnknown(this.state, known, this.ids));
  }
}

/**
 * The saved tabs, around the address the window loaded at: Home (a launch) shows the saved
 * active tab; the same page is a reload; a note is opened from outside (a deep link), so its tab,
 * or a new one; any other page (Settings) shows in the active tab.
 */
function startFrom(saved: TabsState, location: string, ids: IdMaker): TabsState {
  // A launch shows the tab's page, not Settings it was left on (full-window, A1497).
  if (location === HOME_PATH || location === '') {
    return leaveSettings(saved) ?? navigateActive(saved, HOME_PATH, { ids });
  }
  // A note window's ⌘T as the window loads: the tabs as they were, and the picker (A1594).
  if (location === NEW_TAB_PATH) return leaveSettings(saved) ?? saved;
  if (currentEntry(activeTab(saved)).path === location) return saved;
  // A note opened from outside as the window loads (a deep link): its tab, or a new one, its
  // panel as the note itself remembers it (A985).
  if (noteIdOfPath(location) !== null) return forgetPanel(showInTab(saved, location, ids));
  return navigateActive(saved, location, { ids });
}

let main: TabsController | null = null;
let detach: (() => void) | null = null;

/** The main window's tabs; null in a note window, the capture window and tests without them. */
export const mainTabs = (): TabsController | null => main;

/** Gives the main window its tabs (main.tsx, before the first render). */
export function installMainTabs(options: TabsOptions): TabsController {
  detach?.();
  main = new TabsController(options);
  detach = main.attach();
  return main;
}

/** For tests: no tabs again. */
export function uninstallMainTabs(): void {
  detach?.();
  detach = null;
  main = null;
}

/**
 * Points out a tab that already has the note a ⌘-click asked for (A1574): a short pulse of the
 * hover colour, none with Reduce Motion. Only where the strip is drawn.
 */
function flashTab(id: string): void {
  if (typeof document === 'undefined') return;
  const tab = document.querySelector<HTMLElement>(`.tab-strip [data-tab-id="${CSS.escape(id)}"]`);
  if (!tab || typeof tab.animate !== 'function') return;
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
  tab.animate(
    [{ backgroundColor: 'var(--pm-active)' }, { backgroundColor: 'var(--pm-active)' }, {}],
    { duration: 700, easing: 'ease-out' },
  );
}
