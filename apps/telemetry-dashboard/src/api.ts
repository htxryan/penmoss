/**
 * The dashboard's read-only API (PEN-137): GET /api/<view>?days=&client=&actor=&channel=&version=
 * for its seven views, and /api/versions for the filter. Each view runs fixed named queries
 * (apps/telemetry/queries/*.sql); every filter is checked against its list or pattern and bound
 * as a parameter. No route takes SQL, and nothing here writes.
 *
 * Nothing is shown per install: every row is a count, and a path is shown only when at least
 * MIN_SESSIONS sessions took it.
 */
import {
  ACTORS,
  CATALOGUE,
  CHANNELS,
  CLIENTS,
  FIRSTRUN_STEPS,
  KINDS,
  isCatalogued,
} from '@penmoss/core/analytics';
import { runQuery, type QueryName, type QueryParams } from '@penmoss/telemetry/queries';

export const DAYS = [7, 30, 90, 365, 395] as const;
/** First Run and Paths read events, not rollups: at most this many days. */
export const RAW_DAYS = 90;
/** A path seen in fewer sessions than this is never shown. */
export const MIN_SESSIONS = 5;
/** Rows written a day on D1's Workers Free plan (D20): the Health view's line. */
export const DAILY_WRITE_CAP = 100_000;

const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[a-z0-9.]{1,20})?$/;
const FILTERS = ['days', 'client', 'actor', 'channel', 'version', 'start'] as const;

export const VIEWS = [
  'overview',
  'commands',
  'firstrun',
  'paths',
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
}

export class BadRequest extends Error {}

const oneOf = (name: string, value: string, list: readonly string[]) => {
  if (value !== '' && !list.includes(value)) throw new BadRequest(`${name} is not one we know`);
  return value;
};

/** The filters in `url`, checked; a BadRequest says which one is wrong. */
export function readFilters(url: URL): Filters {
  for (const key of url.searchParams.keys()) {
    if (!(FILTERS as readonly string[]).includes(key)) throw new BadRequest(`no filter ${key}`);
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
  return {
    days: days as Filters['days'],
    client: oneOf('client', get('client'), CLIENTS),
    actor: oneOf('actor', get('actor'), ACTORS),
    channel: oneOf('channel', get('channel'), CHANNELS),
    version,
    start,
  };
}

type Row = Record<string, string | number | null>;

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
      return { totals: totals[0] ?? {}, active, actors, versions: versions.slice(0, 10) };
    }
    case 'commands': {
      const [commands, shortcuts, unused] = await Promise.all([
        run('commands'),
        run('shortcuts'),
        run('unused'),
      ]);
      return { commands, shortcuts, unused };
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
      const options = Object.entries(CATALOGUE).flatMap(([kind, names]) =>
        names.map((name) => `${kind}:${name}`),
      );
      if (!filters.start) return { ...raw, options, tree: null };
      const [startKind = '', startName = ''] = filters.start.split(/:(.*)/s);
      const rows = await run('next', { ...raw, startKind, startName });
      return { ...raw, options, start: filters.start, tree: pathTree(filters.start, rows) };
    }
    case 'platforms': {
      const [platforms, adoption, sizes] = await Promise.all([
        run('platforms'),
        run('adoption'),
        run('sizes'),
      ]);
      return { platforms, adoption, sizes };
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
      return { versions: versions.map((row) => row['version']) };
    }
  }
}
