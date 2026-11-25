/**
 * The dashboard's state (PEN-137, PEN-173): the view and the filters, in the address so a reload
 * keeps them, and the API request each view makes.
 */

export const VIEW_NAMES = {
  overview: 'Overview',
  commands: 'Commands & Shortcuts',
  firstrun: 'First Run',
  paths: 'Paths',
  sessions: 'Sessions',
  platforms: 'Platforms',
  agents: 'Agents',
  health: 'Health',
} as const;
export type ViewName = keyof typeof VIEW_NAMES;

// ---------------------------------------------------------------------------------------------
// State: the filters and the view, in the address so a reload keeps them; on Sessions, the
// list's page and an open session's install and id too (PEN-173).

interface State {
  view: ViewName;
  days: string;
  client: string;
  actor: string;
  channel: string;
  version: string;
  start: string;
  /** Sessions' page, from 1. */
  page: number;
  /** An open session's install and id, as the address has them (checked before use). */
  install: string;
  session: string;
}

export const FILTER_KEYS = ['client', 'actor', 'channel', 'version'] as const;

const DEFAULTS: State = {
  view: 'overview',
  days: '30',
  client: '',
  actor: '',
  channel: '',
  version: '',
  start: 'command:app.palette',
  page: 1,
  install: '',
  session: '',
};

export const INSTALL_ID = /^[0-9a-f]{32}$/;
export const SESSION_ID = /^[0-9a-f]{16}$/;

/**
 * The state an address (`#view?…`) stands for, from `current`. A bare `#view` keeps the current
 * filters and Start From and opens the view's first page. A hash with any parameter is the whole
 * filter bar: a filter it leaves out is All, a missing page is 1; only Paths' start, which only
 * Paths writes, keeps the current one when it is missing.
 */
export function stateOf(hash: string, current: State): State {
  const text = hash.replace(/^#/, '');
  const at = text.indexOf('?');
  const name = at < 0 ? text : text.slice(0, at);
  const view = (name in VIEW_NAMES ? name : 'overview') as ViewName;
  const query = at < 0 ? '' : text.slice(at + 1);
  if (query === '') return { ...current, view, page: 1, install: '', session: '' };
  const params = new URLSearchParams(query);
  const page = params.get('page') ?? '';
  return {
    view,
    days: params.get('days') ?? DEFAULTS.days,
    client: params.get('client') ?? '',
    actor: params.get('actor') ?? '',
    channel: params.get('channel') ?? '',
    version: params.get('version') ?? '',
    start: params.get('start') ?? current.start,
    page: /^[1-9]\d{0,3}$/.test(page) ? Number(page) : 1,
    install: view === 'sessions' ? (params.get('install') ?? '') : '',
    session: view === 'sessions' ? (params.get('session') ?? '') : '',
  };
}

export let state = stateOf(location.hash, DEFAULTS);

/** The state from here on (main.ts, when the address or a filter changes). */
export function setState(next: State): void {
  state = next;
}

/** Draws the view again: main.ts's render, for a view that changes the state itself (Paths). */
let redrawView: () => void = () => {};
export const redraw = () => redrawView();
export function onRedraw(draw: () => void): void {
  redrawView = draw;
}

export const sameState = (a: State, b: State) =>
  (Object.keys(a) as (keyof State)[]).every((key) => a[key] === b[key]);

/** The period and filters as parameters. */
function filterParams(from: State = state): URLSearchParams {
  const params = new URLSearchParams({ days: from.days });
  for (const key of FILTER_KEYS) {
    if (from[key]) params.set(key, from[key]);
  }
  return params;
}

/** The address's parameters for `from`: the filters, Paths' start, Sessions' page and session. */
function query(from: State = state): string {
  const params = filterParams(from);
  if (from.view === 'paths' && from.start) params.set('start', from.start);
  if (from.view === 'sessions') {
    if (from.page > 1) params.set('page', String(from.page));
    if (from.install) params.set('install', from.install);
    if (from.session) params.set('session', from.session);
  }
  return params.toString();
}

/** The address of `changes` made to the state: a link's href. */
export const hrefOf = (changes: Partial<State>) => {
  const to = { ...state, ...changes };
  return `#${to.view}?${query(to)}`;
};

/** Sessions' list at `page`, with the address's filters. */
export const listHref = (page = state.page) =>
  hrefOf({ view: 'sessions', page, install: '', session: '' });

/** A session's address: the list's, with the install and the session. */
export const sessionHref = (install: string, session: string) =>
  hrefOf({ view: 'sessions', install, session });

/** Whether Sessions is showing a session (or an address that tries to name one). */
export const sessionOpen = () =>
  state.view === 'sessions' && (state.install !== '' || state.session !== '');

export function writeHash(): void {
  history.replaceState(null, '', `#${state.view}?${query()}`);
}

/** The API request for the view: only what each view needs. */
export function requestPath(): string {
  if (sessionOpen()) {
    return `/api/session?${new URLSearchParams({ install: state.install, session: state.session }).toString()}`;
  }
  if (state.view === 'sessions') {
    const params = filterParams();
    if (state.page > 1) params.set('page', String(state.page));
    return `/api/sessions?${params.toString()}`;
  }
  const params = filterParams();
  if (state.view === 'paths' && state.start) params.set('start', state.start);
  return `/api/${state.view}?${params.toString()}`;
}

export async function load<T>(path: string): Promise<T> {
  const response = await fetch(path, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return response.json() as Promise<T>;
}
