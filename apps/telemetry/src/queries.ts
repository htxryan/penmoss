/**
 * The named queries (PEN-137): one SELECT each in queries/*.sql, run by the dashboard
 * (apps/telemetry-dashboard) and by `task telemetry:query -- <name>` (scripts/query.mjs).
 *
 * Every query takes the same parameters, ?1 to ?6 (QueryParams, in params.ts); next.sql also
 * takes ?7 and ?8, the start event's kind and name, and the Sessions tab's queries (PEN-173) ?9
 * to ?11, an install, a session and a page. The dashboard binds them; the script, which runs a
 * query through `wrangler d1 execute`, writes them in as checked literals.
 */
import { queryValues, type QueryParams } from './params';
import activeTotals from '../queries/active-totals.sql';
import active from '../queries/active.sql';
import actors from '../queries/actors.sql';
import adoption from '../queries/adoption.sql';
import agents from '../queries/agents.sql';
import commands from '../queries/commands.sql';
import feedback from '../queries/feedback.sql';
import firstrun from '../queries/firstrun.sql';
import freshness from '../queries/freshness.sql';
import gaveUp from '../queries/gave-up.sql';
import health from '../queries/health.sql';
import installSessions from '../queries/install-sessions.sql';
import next from '../queries/next.sql';
import platforms from '../queries/platforms.sql';
import session from '../queries/session.sql';
import sessions from '../queries/sessions.sql';
import settings from '../queries/settings.sql';
import shortcuts from '../queries/shortcuts.sql';
import sizes from '../queries/sizes.sql';
import starts from '../queries/starts.sql';
import sync from '../queries/sync.sql';
import unused from '../queries/unused.sql';
import versions from '../queries/versions.sql';
import windowSizes from '../queries/window-sizes.sql';

/** Every named query's SQL, by name. */
export const NAMED_QUERIES = {
  'active-totals': activeTotals,
  active,
  actors,
  adoption,
  agents,
  commands,
  feedback,
  firstrun,
  freshness,
  'gave-up': gaveUp,
  health,
  'install-sessions': installSessions,
  next,
  platforms,
  session,
  sessions,
  settings,
  shortcuts,
  sizes,
  starts,
  sync,
  unused,
  versions,
  'window-sizes': windowSizes,
} as const satisfies Record<string, string>;

export type QueryName = keyof typeof NAMED_QUERIES;

export const QUERY_NAMES = Object.keys(NAMED_QUERIES) as QueryName[];

export type { QueryParams } from './params';

/** The highest ?N in `sql`, comments aside: how many values it binds. */
export function parameterCount(sql: string): number {
  let highest = 0;
  const code = sql.replace(/--.*$/gm, '');
  for (const match of code.matchAll(/\?(\d+)/g)) highest = Math.max(highest, Number(match[1]));
  return highest;
}

/** The values to bind to `sql`, in order. */
export function bindingsFor(sql: string, params: QueryParams): (string | number)[] {
  return queryValues(params).slice(0, parameterCount(sql));
}

/** Runs the named query `name` with `params`. */
export async function runQuery<Row = Record<string, unknown>>(
  db: D1Database,
  name: QueryName,
  params: QueryParams,
): Promise<Row[]> {
  const sql = NAMED_QUERIES[name];
  const result = await db
    .prepare(sql)
    .bind(...bindingsFor(sql, params))
    .all<Row>();
  return result.results;
}
