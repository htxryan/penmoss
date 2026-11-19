/**
 * The nightly cron (PEN-137, 02:15 UTC): roll the last days' events up into daily_counts and
 * daily_installs, delete what is past its keeping time in batches, and refresh the catalogue.
 *
 * Rolling up is idempotent: a day's rows are deleted and rebuilt from its events. The last
 * ROLL_DAYS days are rebuilt each night, not only yesterday, because a device that was offline,
 * or a first run answered Yes to later, sends its events days after they happened.
 */
import { CATALOGUE } from '@penmoss/core/analytics';
import { addDays, dayOf, monthsBefore } from './day';

/** How many days before today are rebuilt each night. */
export const ROLL_DAYS = 7;
/** Events are kept 13 months; the rollups 25. */
export const EVENT_MONTHS = 13;
export const ROLLUP_MONTHS = 25;
/** Rows deleted per statement, so no one statement runs long. */
export const PRUNE_BATCH = 5000;
/** At most this many prune statements per table a night; the rest waits for the next night. */
const MAX_PRUNE_ROUNDS = 400;
/** Pairs per catalogue insert: D1 binds at most 100 parameters to a statement. */
const CATALOGUE_CHUNK = 45;

const ROLL_COUNTS = `INSERT INTO daily_counts
  (day, client, actor, version, channel, kind, name, source, events)
  SELECT day, client, actor, version, channel, kind, name,
    CASE WHEN kind = 'command' THEN COALESCE(json_extract(props, '$.source'), '') ELSE '' END,
    COUNT(*)
  FROM events WHERE day = ?1
  GROUP BY day, client, actor, version, channel, kind, name, 8`;

/** An install's row per day, client and actor carries what its latest event that day said. */
const ROLL_INSTALLS = `INSERT INTO daily_installs
  (day, install, client, actor, version, channel, os, os_version, size_class)
  SELECT day, install, client, actor, version, channel, os, os_version, size_class FROM (
    SELECT day, install, client, actor, version, channel, os, os_version, size_class,
      ROW_NUMBER() OVER (PARTITION BY install, client, actor ORDER BY at DESC, seq DESC) AS latest
    FROM events WHERE day = ?1
  ) WHERE latest = 1`;

export interface NightlyReport {
  readonly rolled: readonly string[];
  readonly prunedEvents: number;
  readonly prunedRollups: number;
  readonly catalogue: number;
}

/** Rebuilds the rollups of the `count` (ROLL_DAYS) days before `today`. */
export async function rollUp(db: D1Database, today: string, count = ROLL_DAYS): Promise<string[]> {
  const days = Array.from({ length: count }, (_, index) => addDays(today, -(index + 1)));
  for (const day of days) {
    await db.batch([
      db.prepare('DELETE FROM daily_counts WHERE day = ?1').bind(day),
      db.prepare(ROLL_COUNTS).bind(day),
      db.prepare('DELETE FROM daily_installs WHERE day = ?1').bind(day),
      db.prepare(ROLL_INSTALLS).bind(day),
    ]);
  }
  return days;
}

/** Deletes `table`'s rows from before `cutoff`, PRUNE_BATCH at a time. */
async function pruneTable(
  db: D1Database,
  table: 'events' | 'daily_counts' | 'daily_installs' | 'ingest_daily',
  cutoff: string,
): Promise<number> {
  const statement = db.prepare(
    `DELETE FROM ${table} WHERE rowid IN
      (SELECT rowid FROM ${table} WHERE day < ?1 LIMIT ${PRUNE_BATCH})`,
  );
  let deleted = 0;
  for (let round = 0; round < MAX_PRUNE_ROUNDS; round++) {
    const result = await statement.bind(cutoff).run();
    const changes = result.meta.changes ?? 0;
    deleted += changes;
    if (changes < PRUNE_BATCH) break;
  }
  return deleted;
}

/** Deletes events older than 13 months and rollups older than 25. */
export async function prune(
  db: D1Database,
  today: string,
): Promise<{ events: number; rollups: number }> {
  const events = await pruneTable(db, 'events', monthsBefore(today, EVENT_MONTHS));
  const rollupCutoff = monthsBefore(today, ROLLUP_MONTHS);
  let rollups = 0;
  for (const table of ['daily_counts', 'daily_installs', 'ingest_daily'] as const) {
    rollups += await pruneTable(db, table, rollupCutoff);
  }
  return { events, rollups };
}

/** Adds every catalogued name to the catalogue table (the catalogue only grows). */
export async function refreshCatalogue(db: D1Database): Promise<number> {
  const pairs = Object.entries(CATALOGUE).flatMap(([kind, names]) =>
    names.map((name) => [kind, name] as const),
  );
  const statements: D1PreparedStatement[] = [];
  for (let start = 0; start < pairs.length; start += CATALOGUE_CHUNK) {
    const chunk = pairs.slice(start, start + CATALOGUE_CHUNK);
    statements.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO catalogue (kind, name) VALUES ${chunk.map(() => '(?, ?)').join(', ')}`,
        )
        .bind(...chunk.flat()),
    );
  }
  if (statements.length > 0) await db.batch(statements);
  return pairs.length;
}

/** The whole nightly run, for the cron firing at `now` (ms since the epoch). */
export async function nightly(db: D1Database, now: number): Promise<NightlyReport> {
  const today = dayOf(now);
  const rolled = await rollUp(db, today);
  const pruned = await prune(db, today);
  const catalogue = await refreshCatalogue(db);
  return { rolled, prunedEvents: pruned.events, prunedRollups: pruned.rollups, catalogue };
}
