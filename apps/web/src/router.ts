/**
 * Path routing on the History API (no router dependency). `navigate` pushes a
 * history entry and tells subscribers; the back and forward buttons arrive as
 * `popstate`.
 *
 * A note window (T45, A710) is the route `/window/notes/:id`: there `navigate`
 * keeps a note in the window (a note path becomes its window path) and sends
 * any other page to the main window (`openInMain`), so a note window only ever
 * shows notes.
 */
import { isUlid } from '@penmoss/core/ids';
import { isShortNoteRef } from '@penmoss/core/note-ref';
import { useLayoutEffect, useReducer, useSyncExternalStore, type MouseEvent } from 'react';
import { noteWindowPath, openInMain, openNoteWindow } from './window/open';

export type Route =
  | { readonly name: 'home' }
  | { readonly name: 'note'; readonly id: string }
  /** A note in a window of its own (T45, A710): no sidebar. */
  | { readonly name: 'window'; readonly id: string }
  | { readonly name: 'graph' }
  | { readonly name: 'trash' }
  /** Every tag, with what each means (PEN-68). */
  | { readonly name: 'tags' }
  /** The Time Machine (PEN-21): a git notebook at any moment, and what changed. */
  | { readonly name: 'time-machine' }
  | {
      readonly name: 'settings';
      readonly section: SettingsSection;
      /** One git notebook's own page under Notebooks (its source id; A1098). */
      readonly item?: string;
    }
  | { readonly name: 'not-found' };

/**
 * Sections of Settings (T20 onwards), in the nav's order (PEN-146): five groups, Look and Feel,
 * Writing, Notebooks, Agents and This Mac. Appearance first, so `/settings` opens there, as the
 * phone's Settings lists it first (T39 pass 3, A551).
 */
export const SETTINGS_SECTIONS = [
  // Look and Feel.
  'appearance',
  'sidebar',
  'note',
  'symbols',
  // Writing.
  'journal',
  'quick-capture',
  'shortcuts',
  // Notebooks: the Mac app's git notebooks (T50, A856), each with a page of its own (A1098).
  'git-notebooks',
  // Agents: the agents that reach them (A1098), and what they changed.
  'agents',
  'agent-activity',
  // This Mac: search by meaning (T78, A1158), the GitHub sign-in (T57, T82), Auto-Update
  // (T64 item 2, A1112) and Privacy, usage analytics and the logs (PEN-137).
  'meaning',
  'github',
  'updates',
  'privacy',
] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

/**
 * Sections that were renamed (PEN-146): an old link, bookmark or command still lands. Display
 * became Sidebar (its note rows moved to Note), and Status became GitHub.
 */
export const SETTINGS_REDIRECTS: ReadonlyMap<string, SettingsSection> = new Map([
  ['display', 'sidebar'],
  ['status', 'github'],
]);

/** The path `pathname` should be shown at, when it is a renamed section's (PEN-146); else null. */
export function settingsRedirect(pathname: string): string | null {
  const match = SETTINGS_PATH.exec(pathname);
  const to = match ? SETTINGS_REDIRECTS.get(match[1]!) : undefined;
  return to && match?.[2] === undefined ? `/settings/${to}` : null;
}

/** A section's path in Settings. */
export const settingsPath = (section: SettingsSection) => `/settings/${section}`;

export interface RouteLocation {
  readonly pathname: string;
  readonly search: string;
}

const NOTE_PATH = /^\/notes\/([^/]+)\/?$/;
const WINDOW_PATH = /^\/window\/notes\/([^/]+)\/?$/;
const SETTINGS_PATH = /^\/settings\/([a-z-]+)(?:\/([0-9A-HJKMNP-TV-Z]{26}|data))?\/?$/;

/** A git notebook's own page in Settings (A1098). */
export const gitNotebookPath = (sourceId: string) => `/settings/git-notebooks/${sourceId}`;

/** A git notebook's agents, on a page of their own in Settings → Agents (A1125). */
export const notebookAgentsPath = (sourceId: string) => `/settings/agents/${sourceId}`;

/** Analytics Data, Privacy's own page under it in Settings (PEN-137, ac36). */
export const PRIVACY_DATA_PATH = '/settings/privacy/data';

export function parseRoute(pathname: string): Route {
  switch (pathname) {
    case '/':
    case '':
      return { name: 'home' };
    case '/trash':
      return { name: 'trash' };
    case '/tags':
      return { name: 'tags' };
    case '/time-machine':
      return { name: 'time-machine' };
    case '/settings':
    case '/settings/':
      return { name: 'settings', section: SETTINGS_SECTIONS[0] };
    case '/graph':
      return { name: 'graph' };
  }
  const settings = SETTINGS_PATH.exec(pathname);
  const named = settings ? (SETTINGS_REDIRECTS.get(settings[1]!) ?? settings[1]!) : null;
  if (settings && named && (SETTINGS_SECTIONS as readonly string[]).includes(named)) {
    const section = named as SettingsSection;
    if (settings[2] === undefined) return { name: 'settings', section };
    const item = settings[2];
    if ((section === 'git-notebooks' || section === 'agents') && item !== 'data') {
      return { name: 'settings', section, item };
    }
    if (section === 'privacy' && item === 'data') return { name: 'settings', section, item };
  }
  const note = NOTE_PATH.exec(pathname);
  if (note) {
    const id = decodePart(note[1]!);
    // A short reference (PEN-69) opens too: NoteSourceScope replaces it with the note's id.
    if (id !== null && (isUlid(id) || isShortNoteRef(id))) return { name: 'note', id };
  }
  const window = WINDOW_PATH.exec(pathname);
  if (window) {
    const id = decodePart(window[1]!);
    if (id !== null && (isUlid(id) || isShortNoteRef(id))) return { name: 'window', id };
  }
  return { name: 'not-found' };
}

/** A decoded path segment, or null when it is malformed (such as `%E0`). */
function decodePart(part: string): string | null {
  try {
    return decodeURIComponent(part);
  } catch {
    return null;
  }
}

export const notePath = (id: string) => `/notes/${encodeURIComponent(id)}`;

/** Whether `pathname` is a note window's (T45). */
export const isNoteWindowPath = (pathname: string): boolean =>
  parseRoute(pathname).name === 'window';

/**
 * Where an in-app path goes from a note window: a note (or a note window) stays in it, as its
 * window path with the same query; null for anything else, which the main window shows.
 */
export function inWindowPath(path: string): string | null {
  const [pathname = '', query] = splitPath(path);
  const route = parseRoute(pathname);
  if (route.name === 'window') return path;
  if (route.name !== 'note') return null;
  const base = noteWindowPath(route.id);
  return query === undefined ? base : `${base}?${query}`;
}

function splitPath(path: string): [string, string | undefined] {
  const at = path.indexOf('?');
  return at === -1 ? [path, undefined] : [path.slice(0, at), path.slice(at + 1)];
}

/**
 * Who follows `navigate`. Called directly, not through a DOM event (A1179): while a DOM event's
 * listeners run, `window.event` is that event, and React gives an update made there the
 * default priority, a later task's, where the key that navigated gives it its own: at once.
 */
const navigated = new Set<() => void>();
/** The entry's place in this window's history (`history.state.penmossIndex`, T45). */
const INDEX_KEY = 'penmossIndex';
/** This window's furthest entry, kept across a reload (`sessionStorage` is per window). */
const LAST_KEY = 'penmoss.historyLast';

function entryIndex(state: unknown = window.history.state): number {
  const index = (state as Record<string, unknown> | null)?.[INDEX_KEY];
  return typeof index === 'number' && Number.isInteger(index) && index >= 0 ? index : 0;
}

function readLast(): number {
  try {
    const value = Number(window.sessionStorage.getItem(LAST_KEY));
    return Number.isInteger(value) && value >= 0 ? value : 0;
  } catch {
    return 0;
  }
}

function writeLast(last: number): void {
  try {
    window.sessionStorage.setItem(LAST_KEY, String(last));
  } catch {
    // Private mode: Forward knows only this page's entries.
  }
}

/**
 * Marks the page's first entry, once, as the page loads. A page opened fresh starts with no
 * entries ahead: a popup gets a copy of its opener's `sessionStorage`, and that window's
 * furthest entry is not this one's. A reload keeps the entry's mark, and what is ahead of it.
 */
export function startHistory(): void {
  if (typeof window === 'undefined') return;
  const state = window.history.state as Record<string, unknown> | null;
  if (typeof state?.[INDEX_KEY] === 'number') return;
  window.history.replaceState({ ...state, [INDEX_KEY]: 0 }, '');
  writeLast(0);
}

/**
 * Who keeps the main window's history (PEN-140, A1497): its tabs, each with its own Back and
 * Forward. The address follows the active tab's page; a note window, and a test with no tabs,
 * keep the browser's history (A710).
 */
export interface HistoryDriver {
  navigate(path: string, replace: boolean): void;
  back(): void;
  forward(): void;
  place(): HistoryPlace;
  /** A new tab showing `path`: in the background (⌘-click), or in front (⇧⌘-click, ⌘T). */
  open(path: string, background: boolean): void;
  /** A page asked for from outside the window's pages: the tab showing it, else a new one. */
  show(path: string): void;
  /**
   * A sidebar's note already open in a tab (A1574): a plain click or ⇧⌘-click makes that tab
   * active, a ⌘-click leaves the tabs as they are and points it out. False when no tab shows it,
   * or (a plain click) when the tab on screen does, so the caller opens it as before.
   */
  reveal(path: string, intent: 'current' | 'background' | 'foreground'): boolean;
}

let driver: HistoryDriver | null = null;

/** Hands the main window's history to `next` (its tabs); null gives it back to the browser. */
export function setHistoryDriver(next: HistoryDriver | null): void {
  driver = next;
}

/** The entry's place in this window's browser history (`history.state.penmossIndex`). */
export const browserEntryIndex = (state?: unknown): number =>
  entryIndex(state === undefined ? window.history.state : state);

/**
 * Shows `path` as this window's address without a page load, as a new browser entry or in
 * place of the current one, and tells whoever follows the location (the driver's way out).
 */
export function writeAddress(path: string, mode: 'push' | 'replace', index: number): void {
  const current = window.location.pathname + window.location.search;
  if (path !== current || mode === 'push') {
    if (mode === 'push') window.history.pushState({ [INDEX_KEY]: index }, '', path);
    else
      window.history.replaceState(
        { ...asRecord(window.history.state), [INDEX_KEY]: index },
        '',
        path,
      );
  }
  notifyNavigated();
}

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};

/** Tells the location's followers it may have changed (a tab switch keeps the address at times). */
export function notifyNavigated(): void {
  for (const listener of [...navigated]) {
    try {
      listener();
    } catch (error) {
      // As a DOM event's listener would: the others still hear it.
      console.error('[router] a navigation listener failed', error);
    }
  }
}

/** Back in this window: the active tab's history in the main window, else the browser's. */
export function goBack(): void {
  if (driver) driver.back();
  else window.history.back();
}

/** Forward in this window, as `goBack`. */
export function goForward(): void {
  if (driver) driver.forward();
  else window.history.forward();
}

export function navigate(path: string, options: { readonly replace?: boolean } = {}): void {
  if (driver && !isNoteWindowPath(window.location.pathname)) {
    driver.navigate(path, options.replace === true);
    return;
  }
  if (isNoteWindowPath(window.location.pathname)) {
    // A note window shows notes; anything else opens in the main window (T45, A710).
    const inWindow = inWindowPath(path);
    if (inWindow === null) {
      openInMain(path);
      return;
    }
    path = inWindow;
  }
  const current = window.location.pathname + window.location.search;
  if (path === current) return;
  const index = entryIndex();
  if (options.replace) {
    window.history.replaceState({ [INDEX_KEY]: index }, '', path);
  } else {
    // A new entry drops the ones ahead of it, as the browser does.
    window.history.pushState({ [INDEX_KEY]: index + 1 }, '', path);
    writeLast(index + 1);
  }
  notifyNavigated();
}

/** Whether Back and Forward have somewhere to go in this window (T45's note window). */
export interface HistoryPlace {
  readonly back: boolean;
  readonly forward: boolean;
}

let place: HistoryPlace = { back: false, forward: false };

/** Back and Forward's state in this window now (a stable reference between changes). */
export function historyPlace(): HistoryPlace {
  if (driver) return driver.place();
  const index = entryIndex();
  const last = Math.max(readLast(), index);
  const back = index > 0;
  const forward = index < last;
  if (place.back !== back || place.forward !== forward) place = { back, forward };
  return place;
}

/** Back and Forward's state in this window; follows `navigate` and history traversal. */
export function useHistoryPlace(): HistoryPlace {
  return useSyncExternalStore(
    typeof window === 'undefined' ? () => () => undefined : subscribe,
    typeof window === 'undefined' ? () => place : historyPlace,
    () => place,
  );
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener('popstate', onChange);
  navigated.add(onChange);
  return () => {
    window.removeEventListener('popstate', onChange);
    navigated.delete(onChange);
  };
}

const ROOT: RouteLocation = { pathname: '/', search: '' };
let cached: RouteLocation = ROOT;

function snapshot(): RouteLocation {
  const { pathname, search } = window.location;
  if (cached.pathname !== pathname || cached.search !== search) cached = { pathname, search };
  return cached;
}

/** The current location; re-renders on `navigate` and history traversal. */
export function useLocation(): RouteLocation {
  const location = useSyncExternalStore(
    typeof window === 'undefined' ? () => () => undefined : subscribe,
    typeof window === 'undefined' ? () => ROOT : snapshot,
    () => ROOT,
  );
  useNavigationFromCommit();
  return location;
}

/**
 * Follows `navigate` from the commit too (A1179), as the command dispatcher listens (A697).
 * useSyncExternalStore subscribes in a passive effect, which React runs in a later task, and
 * the browser handles queued keys before that task: ⌘⌥N pressed as the window showed made its
 * note, but the note view came only after that task, and the keys typed meanwhile went to the
 * page, not to the note's title. A change heard here re-renders at the event's priority (a
 * key's: in the microtask after it, before the next key), passive effects first.
 */
function useNavigationFromCommit(): void {
  const [, rerender] = useReducer(bump, 0);
  useLayoutEffect(() => (typeof window === 'undefined' ? undefined : subscribe(rerender)), []);
}

const bump = (count: number): number => count + 1;

/** A click the app should handle itself (not a new tab, window or download). */
export function isPlainLeftClick(
  event: Pick<
    MouseEvent,
    'button' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'defaultPrevented'
  >,
): boolean {
  return (
    !event.defaultPrevented &&
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey
  );
}

/**
 * An ⌥-click (Alt-click), which opens a note in a new window (T45, A710). The handler calls
 * `preventDefault`: a browser's own ⌥-click on a link downloads it.
 */
export function isWindowClick(
  event: Pick<
    MouseEvent,
    'button' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'defaultPrevented'
  >,
): boolean {
  return (
    !event.defaultPrevented &&
    event.button === 0 &&
    event.altKey &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey
  );
}

/** The note a path opens (`/notes/…` or its window), with its heading; null for other pages. */
export function noteOfPath(
  path: string,
): { readonly id: string; readonly heading: string | null } | null {
  const [pathname = '', query = ''] = splitPath(path);
  const route = parseRoute(pathname);
  if (route.name !== 'note' && route.name !== 'window') return null;
  return { id: route.id, heading: new URLSearchParams(query).get('heading') };
}

/**
 * Where a click opens a page (PEN-140, A1498): in the tab on screen (`current`), a new tab
 * behind it (`background`: ⌘-click, Ctrl-click or a middle click), a new tab in front
 * (`foreground`: ⇧⌘-click) or a note window (`window`: ⌥-click, T45). Null for a click the app
 * leaves alone (a right click, one already handled, other modifiers).
 */
export type OpenIntent = 'current' | 'background' | 'foreground' | 'window';

export function openIntent(
  event: Pick<
    MouseEvent,
    'button' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'defaultPrevented'
  >,
): OpenIntent | null {
  if (event.defaultPrevented) return null;
  if (event.button === 1) return event.altKey ? null : 'background';
  if (event.button !== 0) return null;
  if (isWindowClick(event)) return 'window';
  if (event.altKey) return null;
  const mod = event.metaKey || event.ctrlKey;
  if (mod) return event.shiftKey ? 'foreground' : 'background';
  return event.shiftKey ? null : 'current';
}

/** Whether this window has tabs (the main window, PEN-140). */
export const hasTabs = (): boolean =>
  driver !== null && typeof window !== 'undefined' && !isNoteWindowPath(window.location.pathname);

/** The sidebar's notes: a note already open in a tab is gone to there (A1574). */
export const REVEAL: OpenOptions = { existing: 'reveal' };

/** How an opener treats a note already open in a tab. */
export interface OpenOptions {
  /**
   * `reveal`: the sidebar's notes (A1574). A click goes to the tab that has the note, and a
   * ⌘-click opens no second one. Links in notes, Search, the palette and the rest open as asked.
   */
  readonly existing?: 'reveal';
}

/**
 * Opens `path` as `intent` says: where there are no tabs (a note window), a new tab is the main
 * window's, and anything but a window shows here.
 */
export function openPath(path: string, intent: OpenIntent, options: OpenOptions = {}): void {
  if (intent === 'window') {
    const note = noteOfPath(path);
    if (note) {
      openNoteWindow(note.id, note.heading);
      return;
    }
    intent = 'current';
  }
  if (options.existing === 'reveal' && hasTabs() && driver!.reveal(path, intent)) return;
  if (intent === 'current' || !driver) {
    navigate(path);
    return;
  }
  if (!hasTabs()) {
    // A note window's ⌘-click: a tab of the main window (A1498).
    openInMain(path);
    return;
  }
  driver.open(path, intent === 'background');
}

/**
 * A page asked for from outside the window's own pages (the menu bar icon, a deep link, Open
 * Today's Journal, a note window): the tab already showing it, else a new tab; never in place of
 * the page on screen (A1498). Without tabs, as `navigate`.
 */
export function showPath(path: string): void {
  if (hasTabs()) driver!.show(path);
  else navigate(path);
}

/**
 * onClick for in-app links: navigate without a page load. An ⌥-click on a link to a note opens
 * it in a new window (T45); a ⌘-click, a new tab (PEN-140).
 */
export function linkHandler(path: string, options: OpenOptions = {}) {
  return (event: MouseEvent<HTMLAnchorElement>) => {
    const intent = openIntent(event);
    if (intent === 'window' && !noteOfPath(path)) return;
    if (intent === null || (intent !== 'current' && intent !== 'window' && !hasTabs())) return;
    event.preventDefault();
    openPath(path, intent, options);
  };
}

/** onAuxClick for in-app links: a middle click opens a new tab behind this one (PEN-140). */
export function linkAuxHandler(path: string, options: OpenOptions = {}) {
  return (event: MouseEvent<HTMLElement>) => {
    if (event.button !== 1 || !hasTabs()) return;
    event.preventDefault();
    openPath(path, 'background', options);
  };
}
