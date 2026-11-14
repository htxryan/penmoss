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

export { noteWindowPath } from './window/open';

export type Route =
  | { readonly name: 'home' }
  | { readonly name: 'note'; readonly id: string }
  /** A note in a window of its own (T45, A710): no sidebar. */
  | { readonly name: 'window'; readonly id: string }
  | { readonly name: 'graph' }
  | { readonly name: 'trash' }
  /** Every tag, with what each means (PEN-68). */
  | { readonly name: 'tags' }
  | {
      readonly name: 'settings';
      readonly section: SettingsSection;
      /** One git notebook's own page under Notebooks (its source id; A1098). */
      readonly item?: string;
    }
  | { readonly name: 'capture' }
  | { readonly name: 'not-found' };

/**
 * Sections of Settings (T20 onwards). In every client's order
 * (T39 pass 3, A551): Appearance first, so `/settings` opens there, as the phone's Settings
 * lists it first.
 */
export const SETTINGS_SECTIONS = [
  'appearance',
  'display',
  'symbols',
  // T50 (A856): the Mac app's git notebooks, and the agents that reach them (A1098).
  'git-notebooks',
  'agents',
  'journal',
  'shortcuts',
  // Search by meaning on this Mac (T78, A1158).
  'meaning',
  // Auto-Update, in the Mac app (T64 item 2, A1112).
  'updates',
  // Send feedback's GitHub token and outbox (T49, T57).
  'status',
] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export interface RouteLocation {
  readonly pathname: string;
  readonly search: string;
}

const NOTE_PATH = /^\/notes\/([^/]+)\/?$/;
const WINDOW_PATH = /^\/window\/notes\/([^/]+)\/?$/;
const SETTINGS_PATH = /^\/settings\/([a-z-]+)(?:\/([0-9A-HJKMNP-TV-Z]{26}))?\/?$/;

/** A git notebook's own page in Settings (A1098). */
export const gitNotebookPath = (sourceId: string) => `/settings/git-notebooks/${sourceId}`;

/** A git notebook's agents, on a page of their own in Settings → Agents (A1125). */
export const notebookAgentsPath = (sourceId: string) => `/settings/agents/${sourceId}`;

export function parseRoute(pathname: string): Route {
  switch (pathname) {
    case '/':
    case '':
      return { name: 'home' };
    case '/trash':
      return { name: 'trash' };
    case '/tags':
      return { name: 'tags' };
    case '/settings':
    case '/settings/':
      return { name: 'settings', section: SETTINGS_SECTIONS[0] };
    case '/capture':
      return { name: 'capture' };
    case '/graph':
      return { name: 'graph' };
  }
  const settings = SETTINGS_PATH.exec(pathname);
  if (settings && (SETTINGS_SECTIONS as readonly string[]).includes(settings[1]!)) {
    const section = settings[1] as SettingsSection;
    if (settings[2] === undefined) return { name: 'settings', section };
    if (section === 'git-notebooks' || section === 'agents') {
      return { name: 'settings', section, item: settings[2] };
    }
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

export function navigate(path: string, options: { readonly replace?: boolean } = {}): void {
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
  for (const listener of [...navigated]) {
    try {
      listener();
    } catch (error) {
      // As a DOM event's listener would: the others still hear it.
      console.error('[router] a navigation listener failed', error);
    }
  }
}

/** Whether Back and Forward have somewhere to go in this window (T45's note window). */
export interface HistoryPlace {
  readonly back: boolean;
  readonly forward: boolean;
}

let place: HistoryPlace = { back: false, forward: false };

/** Back and Forward's state in this window now (a stable reference between changes). */
export function historyPlace(): HistoryPlace {
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
 * onClick for in-app links: navigate without a page load. An ⌥-click on a link to a note opens
 * it in a new window (T45).
 */
export function linkHandler(path: string) {
  return (event: MouseEvent<HTMLAnchorElement>) => {
    const note = isWindowClick(event) ? noteOfPath(path) : null;
    if (note) {
      event.preventDefault();
      openNoteWindow(note.id, note.heading);
      return;
    }
    if (!isPlainLeftClick(event)) return;
    event.preventDefault();
    navigate(path);
  };
}
