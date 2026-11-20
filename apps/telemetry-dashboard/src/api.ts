/**
 * The dashboard's read-only API (PEN-137): GET /api/<view>?days=&client=&actor=&channel=&version=
 * for its eight views, and /api/versions for the filter. Each view runs fixed named queries
 * (apps/telemetry/queries/*.sql); every filter is checked against its list or pattern and bound
 * as a parameter. No route takes SQL, and nothing here writes.
 *
 * Nothing is shown per install outside Sessions (PEN-173, amending A1641): every other row is a
 * count, and a path is shown only when at least MIN_SESSIONS sessions took it, to keep its chart
 * readable. Sessions (/api/sessions, /api/session) lists sessions and gives one session's events
 * and its install's sessions; the page shows an install only by its first 8 hex characters.
 */
import {
  ACTORS,
  CATALOGUE,
  CHANNELS,
  CLIENTS,
  FIRSTRUN_STEPS,
  INSTALL_PATTERN,
  KINDS,
  SESSION_PATTERN,
  isCatalogued,
} from '@penmoss/core/analytics';
import { runQuery, type QueryName, type QueryParams } from '@penmoss/telemetry/queries';
import shortcutsContract from '../../android/contract/shortcuts-v1.json';

/** Each command's default combinations, from the shortcut map every client shares. */
export const DEFAULT_KEYS: ReadonlyMap<string, readonly string[]> = new Map(
  shortcutsContract.commands.map((command) => [command.id, command.keys]),
);

export const DAYS = [7, 30, 90, 365, 395] as const;
/** First Run and Paths read events, not rollups: at most this many days. */
export const RAW_DAYS = 90;
/** A path seen in fewer sessions than this is never shown. */
export const MIN_SESSIONS = 5;
/** Sessions' list: this many a page (sessions.sql's LIMIT). */
export const SESSIONS_PAGE = 50;
/** A session's timeline shows at most this many events (session.sql reads one more). */
export const MAX_EVENTS = 5000;
/** Rows written a day on D1's Workers Free plan (D20): the Health view's line. */
export const DAILY_WRITE_CAP = 100_000;

const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[a-z0-9.]{1,20})?$/;
const FILTERS = ['days', 'client', 'actor', 'channel', 'version', 'start'] as const;
/** The parameters only one view takes (PEN-173): the list's page, a session's two ids. */
const VIEW_FILTERS: Partial<Record<View, readonly string[]>> = {
  sessions: ['page'],
  session: ['install', 'session'],
};

export const VIEWS = [
  'overview',
  'commands',
  'firstrun',
  'paths',
  'sessions',
  'session',
  'platforms',
  'agents',
  'health',
  'versions',
] as const;
export type View = (typeof VIEWS)[number];

export interface Filters {
  readonly days: (typeof DAYS)[number];
  readonly client: string;
  readonly actor: string;
  readonly channel: string;
  readonly version: string;
  /** Paths' start event, kind:name, or ''. */
  readonly start: string;
  /** Sessions' page, from 1 (only on /api/sessions). */
  readonly page?: number;
  /** A session's install and id (only on /api/session, where both are needed). */
  readonly install?: string;
  readonly session?: string;
}

export class BadRequest extends Error {}

const oneOf = (name: string, value: string, list: readonly string[]) => {
  if (value !== '' && !list.includes(value)) throw new BadRequest(`${name} is not one we know`);
  return value;
};

/** The filters in `url` for `view`, checked; a BadRequest says which one is wrong. */
export function readFilters(url: URL, view: View): Filters {
  const known: readonly string[] = [...FILTERS, ...(VIEW_FILTERS[view] ?? [])];
  for (const key of url.searchParams.keys()) {
    if (!known.includes(key)) throw new BadRequest(`no filter ${key}`);
  }
  const get = (key: string) => url.searchParams.get(key) ?? '';
  const days = Number(get('days') || 30);
  if (!(DAYS as readonly number[]).includes(days))
    throw new BadRequest('days is 7, 30, 90, 365 or 395');
  const version = get('version');
  if (version !== '' && !VERSION.test(version)) throw new BadRequest('version is x.y.z');
  const start = get('start');
  if (start !== '') {
    const [kind = '', name = ''] = start.split(/:(.*)/s);
    if (!(KINDS as readonly string[]).includes(kind) || !isCatalogued(kind, name)) {
      throw new BadRequest('start is a catalogued kind:name');
    }
  }
  const filters: Filters = {
    days: days as Filters['days'],
    client: oneOf('client', get('client'), CLIENTS),
    actor: oneOf('actor', get('actor'), ACTORS),
    channel: oneOf('channel', get('channel'), CHANNELS),
    version,
    start,
  };
  if (view === 'sessions') {
    const page = get('page') || '1';
    if (!/^[1-9]\d{0,3}$/.test(page)) throw new BadRequest('page is a whole number, 1 to 9999');
    return { ...filters, page: Number(page) };
  }
  if (view === 'session') {
    const install = get('install');
    const session = get('session');
    if (!INSTALL_PATTERN.test(install)) throw new BadRequest('install is 32 hex characters');
    if (!SESSION_PATTERN.test(session)) throw new BadRequest('session is 16 hex characters');
    return { ...filters, install, session };
  }
  return filters;
}

type Row = Record<string, string | number | null>;

/** A row without the query's `total` column, which the answer gives once. */
const withoutTotal = (row: Row): Row =>
  Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'total'));

interface PathNode {
  readonly event: string;
  readonly sessions: number;
  /** Of the sessions at the node above, the share that went here, 0–100. */
  readonly share: number;
  readonly children: PathNode[];
}

/** next.sql's rows as a tree: the top 3 next events at each step, three steps deep. */
export function pathTree(start: string, rows: readonly Row[]): PathNode | null {
  const root = rows.find((row) => row['depth'] === 0);
  const sessions = Number(root?.['sessions'] ?? 0);
  if (!root || sessions < MIN_SESSIONS) return null;
  const level = (depth: number, parent: readonly string[], above: number): PathNode[] =>
    rows
      .filter(
        (row) =>
          row['depth'] === depth &&
          Number(row['sessions']) >= MIN_SESSIONS &&
          parent.every((event, index) => row[`n${index + 1}`] === event),
      )
      .sort((a, b) => Number(b['sessions']) - Number(a['sessions']))
      .slice(0, 3)
      .map((row) => {
        const event = String(row[`n${depth}`]);
        const count = Number(row['sessions']);
        return {
          event,
          sessions: count,
          share: Math.round((1000 * count) / above) / 10,
          children: depth < 3 && event !== 'end' ? level(depth + 1, [...parent, event], count) : [],
        };
      });
  return { event: start, sessions, share: 100, children: level(1, [], sessions) };
}

/** Today in UTC, YYYY-MM-DD. */
const todayOf = (now: number) => new Date(now).toISOString().slice(0, 10);

/** One view's data under `filters`, at time `now`. */
export async function viewData(
  db: D1Database,
  view: View,
  filters: Filters,
  now: number,
): Promise<Record<string, unknown>> {
  const params: QueryParams = { ...filters, today: todayOf(now) };
  const run = (name: QueryName, overrides: Partial<QueryParams> = {}) =>
    runQuery<Row>(db, name, { ...params, ...overrides });
  const raw = { days: Math.min(filters.days, RAW_DAYS) };
  switch (view) {
    case 'overview': {
      const [totals, active, actors, versions] = await Promise.all([
        run('active-totals'),
        run('active'),
        run('actors'),
        run('versions'),
      ]);
      return { totals: totals[0] ?? {}, active, actors, versions: versions.slice(0, 20) };
    }
    case 'commands': {
      const [commands, shortcuts, unused] = await Promise.all([
        run('commands'),
        run('shortcuts'),
        run('unused'),
      ]);
      return {
        commands,
        shortcuts: shortcuts.map((row) => ({
          ...row,
          default_keys: (DEFAULT_KEYS.get(String(row['name'])) ?? []).join(' or '),
        })),
        unused,
      };
    }
    case 'firstrun': {
      const [steps, gaveUp] = await Promise.all([run('firstrun', raw), run('gave-up', raw)]);
      const order = (step: unknown) => FIRSTRUN_STEPS.indexOf(String(step));
      return {
        ...raw,
        steps: [...steps].sort((a, b) => order(a['step']) - order(b['step'])),
        gaveUp,
      };
    }
    case 'paths': {
      // Every catalogued event, with how often it occurred in the period, most first.
      const seen = new Map(
        (await run('starts', raw)).map((row) => [`${row['kind']}:${row['name']}`, row['events']]),
      );
      const options = Object.entries(CATALOGUE)
        .flatMap(([kind, names]) => names.map((name) => `${kind}:${name}`))
        .map((event) => ({ event, events: Number(seen.get(event) ?? 0) }))
        .sort((a, b) => b.events - a.events);
      if (!filters.start) return { ...raw, options, tree: null };
      const [startKind = '', startName = ''] = filters.start.split(/:(.*)/s);
      const rows = await run('next', { ...raw, startKind, startName });
      return { ...raw, options, start: filters.start, tree: pathTree(filters.start, rows) };
    }
    case 'sessions': {
      // A page past the end (the list shrank, an old link) answers the first page instead.
      let page = filters.page ?? 1;
      let rows = await run('sessions', { ...raw, page });
      if (rows.length === 0 && page > 1) {
        page = 1;
        rows = await run('sessions', { ...raw, page });
      }
      return {
        ...raw,
        page,
        pageSize: SESSIONS_PAGE,
        total: Number(rows[0]?.['total'] ?? 0),
        sessions: rows.map(withoutTotal),
      };
    }
    case 'session': {
      // The last 90 days, whatever the period or the filters.
      const ids = {
        days: RAW_DAYS,
        install: filters.install ?? '',
        session: filters.session ?? '',
      };
      const [events, others] = await Promise.all([
        run('session', ids),
        run('install-sessions', ids),
      ]);
      return {
        days: RAW_DAYS,
        install: filters.install,
        session: filters.session,
        events: events.slice(0, MAX_EVENTS).map((row) => ({
          ...row,
          props: JSON.parse(String(row['props'] ?? '{}')) as unknown,
        })),
        more: events.length > MAX_EVENTS,
        others: others.map(withoutTotal),
        othersTotal: Number(others[0]?.['total'] ?? 0),
      };
    }
    case 'platforms': {
      const [platforms, adoption, sizes, windowSizes] = await Promise.all([
        run('platforms'),
        run('adoption'),
        run('sizes'),
        // Main windows' sizes (PEN-174): the 10 most per client, then Other.
        run('window-sizes'),
      ]);
      return { platforms, adoption, sizes, windowSizes };
    }
    case 'agents': {
      const [actors, agents] = await Promise.all([run('actors'), run('agents')]);
      return { actors, agents };
    }
    case 'health': {
      const [health, sync, feedback] = await Promise.all([
        run('health'),
        run('sync'),
        run('feedback'),
      ]);
      return { health, sync, feedback, writeCap: DAILY_WRITE_CAP };
    }
    case 'versions': {
      // The filter's list: every version seen in the last 13 months, whatever is chosen.
      const versions = await run('versions', {
        days: 395,
        client: '',
        actor: '',
        channel: '',
        version: '',
      });
      return { versions: [...new Set(versions.map((row) => row['version']))] };
    }
  }
}

/** When the newest event arrived (ms, or null) and the last day the nightly rollup reached. */
export async function freshness(
  db: D1Database,
  now: number,
): Promise<{ receivedAt: number | null; rolledUpThrough: string | null }> {
  const [row] = await runQuery<Row>(db, 'freshness', {
    days: 1,
    client: '',
    actor: '',
    channel: '',
    version: '',
    today: todayOf(now),
  });
  const received = row?.['received_at'];
  const rolled = row?.['rolled_up_through'];
  return {
    receivedAt: typeof received === 'number' ? received : null,
    rolledUpThrough: typeof rolled === 'string' ? rolled : null,
  };
}
