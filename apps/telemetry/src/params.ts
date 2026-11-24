/**
 * The named queries' parameters (PEN-137, PEN-173), defined once for the Worker (queries.ts), the
 * dashboard (apps/telemetry-dashboard) and `task telemetry:query` (scripts/query.mjs). Node runs
 * this file as it is, stripping its types, so it imports nothing (no `.sql`) and uses only
 * TypeScript that erases.
 */

/** The periods a query covers, in days ending today; the last is 13 months, the retention. */
export const DAYS = [7, 30, 90, 365, 395] as const;
export type Days = (typeof DAYS)[number];

export function isDays(days: number): days is Days {
  return (DAYS as readonly number[]).includes(days);
}

/**
 * An install's id, 32 hex characters, and a session's, 16: core's `INSTALL_PATTERN` and
 * `SESSION_PATTERN` (test/queries.test.ts keeps them the same), here for Node.
 */
export const INSTALL_HEX = /^[0-9a-f]{32}$/;
export const SESSION_HEX = /^[0-9a-f]{16}$/;

/** The parameters every query takes, in order (?1 to ?6), and the ones some take (?7 to ?11). */
export interface QueryParams {
  /** How many days the period is, ending today. */
  readonly days: number;
  /** '' for every client, actor, channel or version. */
  readonly client: string;
  readonly actor: string;
  readonly channel: string;
  readonly version: string;
  /** Today, YYYY-MM-DD (UTC). */
  readonly today: string;
  /** next.sql's start event (?7, ?8). */
  readonly startKind?: string;
  readonly startName?: string;
  /** The Sessions tab's (PEN-173): an install's 32 hex characters (?9), a session's 16 (?10). */
  readonly install?: string;
  readonly session?: string;
  /** sessions.sql's page, from 1 (?11). */
  readonly page?: number;
}

/** Every parameter's value, ?1 to ?11 in order; a query uses as many as its highest ?N. */
export function queryValues(params: QueryParams): (string | number)[] {
  return [
    params.days,
    params.client,
    params.actor,
    params.channel,
    params.version,
    params.today,
    params.startKind ?? '',
    params.startName ?? '',
    params.install ?? '',
    params.session ?? '',
    params.page ?? 1,
  ];
}
