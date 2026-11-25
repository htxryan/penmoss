/**
 * The nightly cron (PEN-137, 02:15 UTC): roll the last days' events up into daily_counts and
 * daily_installs, delete what is past its keeping time in batches, and refresh the catalogue.
 *
 * Rolling up is idempotent: a day's rows are deleted and rebuilt from its events. The last
 * ROLL_DAYS days are rebuilt each night, not only yesterday, because a device that was offline,
 * or a first run answered Yes to later, sends its events days after they happened.
 *
 * Session detail (PEN-177, O8): note, input and tree events are kept 90 days, the dashboard's
 * raw window (the Sessions tab, A1661), so every session it can open can also be played back;
 * every other kind stays 13 months, and the rollups count the new kinds for 25 months. They are
 * pruned first, with their own budget. When D1 nears its limit (its size, read from the night's
 * first query, past PRUNE_FIRST_BYTES), the oldest of them go too: as many as bring the estimate
 * back to PRUNE_TO_BYTES, worked out once from the size and the events' row count, never by
 * reading the size again in a loop (a SQLite delete frees pages for reuse without shrinking the
 * file, so new rows reuse them and the file stops growing). No other kind is pruned early: with
 * no session detail left, the night logs it, so it needs a decision.
 */
import { CATALOGUE } from '@penmoss/core/analytics';
import { addDays, dayOf, monthsBefore } from './day';

/** How many days before today are rebuilt each night. */
const ROLL_DAYS = 7;
/** Events are kept 13 months; the rollups 25. */
const EVENT_MONTHS = 13;
const ROLLUP_MONTHS = 25;
/** Rows deleted per statement, so no one statement runs long. */
export const PRUNE_BATCH = 5000;
/** At most this many prune statements per table a night; the rest waits for the next night. */
const MAX_PRUNE_ROUNDS = 400;
/** Session detail's kinds (PEN-177): kept DETAIL_DAYS, and pruned first. */
const DETAIL_KINDS = ['note', 'input', 'tree'] as const;
const DETAIL_DAYS = 90;
/** Session detail's own prune statements a night, apart from the other kinds' MAX_PRUNE_ROUNDS. */
export const MAX_DETAIL_ROUNDS = 400;
const GB = 1_000_000_000;
/** Past this size (80% of D1's 10 GB), the oldest session detail is pruned early… */
const PRUNE_FIRST_BYTES = 8 * GB;
/** …down to an estimate of this. */
export const PRUNE_TO_BYTES = 7.5 * GB;
/** What the night logs when D1 is past PRUNE_FIRST_BYTES and no session detail is left. */
export const NOTHING_LEFT_LOG = 'd1 over 8 GB with no session detail left to prune';
const DETAIL_IN = `kind IN (${DETAIL_KINDS.map((kind) => `'${kind}'`).join(', ')})`;

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

interface NightlyReport {
  readonly rolled: readonly string[];
  /** Note, input and tree events deleted: past DETAIL_DAYS, and early for D1's size. */
  readonly prunedDetail: number;
  /** Of those, how many went early, for D1's size. */
  readonly prunedForSize: number;
  /** D1's size in bytes as the night's first query left it (null: not told). */
  readonly sizeBytes: number | null;
  readonly prunedEvents: number;
  readonly prunedRollups: number;
  readonly catalogue: number;
}

/**
 * Rebuilds the rollups of the `count` (ROLL_DAYS) days before `today`; the days, and D1's size
 * in bytes after the first of its queries (the night's first), or null when D1 didn't say.
 */
export async function rollUp(
  db: D1Database,
  today: string,
  count = ROLL_DAYS,
): Promise<{ days: string[]; sizeBytes: number | null }> {
  const days = Array.from({ length: count }, (_, index) => addDays(today, -(index + 1)));
  let sizeBytes: number | null = null;
  for (const day of days) {
    const results = await db.batch([
      db.prepare('DELETE FROM daily_counts WHERE day = ?1').bind(day),
      db.prepare(ROLL_COUNTS).bind(day),
      db.prepare('DELETE FROM daily_installs WHERE day = ?1').bind(day),
      db.prepare(ROLL_INSTALLS).bind(day),
    ]);
    if (day === days[0]) {
      const size = (results[0]?.meta as { size_after?: unknown } | undefined)?.size_after;
      sizeBytes = typeof size === 'number' && Number.isFinite(size) ? size : null;
    }
  }
  return { days, sizeBytes };
}

/** Runs `statement` (a delete of at most `batch` rows) until it deletes fewer, or `rounds` run out. */
async function deleteRounds(
  next: (limit: number) => D1PreparedStatement,
  budget: { rounds: number },
  wanted = Number.POSITIVE_INFINITY,
): Promise<{ deleted: number; exhausted: boolean }> {
  let deleted = 0;
  while (budget.rounds > 0 && deleted < wanted) {
    budget.rounds -= 1;
    const limit = Math.min(PRUNE_BATCH, wanted - deleted);
    const result = await next(limit).run();
    const changes = result.meta.changes ?? 0;
    deleted += changes;
    if (changes < limit) return { deleted, exhausted: true };
  }
  return { deleted, exhausted: false };
}

/**
 * Prunes session detail (PEN-177, O8): note, input and tree events older than DETAIL_DAYS; then,
 * when D1 is past PRUNE_FIRST_BYTES, as many of the oldest as bring the estimate back to
 * PRUNE_TO_BYTES: (size − PRUNE_TO_BYTES) ÷ (size ÷ the events' row count), worked out once.
 * Both share one budget of MAX_DETAIL_ROUNDS statements; what is left waits for the next night.
 */
async function pruneDetail(
  db: D1Database,
  today: string,
  sizeBytes: number | null,
  log: (line: string) => void = () => undefined,
): Promise<{ aged: number; forSize: number }> {
  // The row count the estimate divides by, read with the size, before anything is deleted.
  let perRow: number | null = null;
  if (sizeBytes !== null && sizeBytes > PRUNE_FIRST_BYTES) {
    const counted = await db.prepare('SELECT COUNT(*) AS n FROM events').first<{ n: number }>();
    const rows = counted?.n ?? 0;
    perRow = rows > 0 ? sizeBytes / rows : null;
  }
  const budget = { rounds: MAX_DETAIL_ROUNDS };
  const agedStatement = db.prepare(
    `DELETE FROM events WHERE rowid IN
      (SELECT rowid FROM events WHERE day < ?1 AND ${DETAIL_IN} LIMIT ?2)`,
  );
  const cutoff = addDays(today, -DETAIL_DAYS);
  const aged = (await deleteRounds((limit) => agedStatement.bind(cutoff, limit), budget)).deleted;
  if (sizeBytes === null || sizeBytes <= PRUNE_FIRST_BYTES) return { aged, forSize: 0 };
  if (perRow === null) {
    log(NOTHING_LEFT_LOG);
    return { aged, forSize: 0 };
  }
  // What the aged prune already took counts towards the estimate.
  const wanted = Math.max(0, Math.ceil((sizeBytes - PRUNE_TO_BYTES) / perRow) - aged);
  if (wanted === 0) return { aged, forSize: 0 };
  const oldestStatement = db.prepare(
    `DELETE FROM events WHERE rowid IN
      (SELECT rowid FROM events WHERE ${DETAIL_IN} ORDER BY day, at LIMIT ?1)`,
  );
  const sized = await deleteRounds((limit) => oldestStatement.bind(limit), budget, wanted);
  if (sized.exhausted && sized.deleted < wanted) log(NOTHING_LEFT_LOG);
  return { aged, forSize: sized.deleted };
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
  const budget = { rounds: MAX_PRUNE_ROUNDS };
  return (await deleteRounds(() => statement.bind(cutoff), budget)).deleted;
}

/** Deletes events older than 13 months and rollups older than 25. */
async function prune(db: D1Database, today: string): Promise<{ events: number; rollups: number }> {
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

/**
 * The whole nightly run, for the cron firing at `now` (ms since the epoch): the rollups, then
 * session detail's prune (first), then the other kinds' and the rollups'.
 */
export async function nightly(
  db: D1Database,
  now: number,
  log: (line: string) => void = (line) => console.log(line),
): Promise<NightlyReport> {
  const today = dayOf(now);
  const { days: rolled, sizeBytes } = await rollUp(db, today);
  const detail = await pruneDetail(db, today, sizeBytes, log);
  const pruned = await prune(db, today);
  const catalogue = await refreshCatalogue(db);
  return {
    rolled,
    prunedDetail: detail.aged + detail.forSize,
    prunedForSize: detail.forSize,
    sizeBytes,
    prunedEvents: pruned.events,
    prunedRollups: pruned.rollups,
    catalogue,
  };
}
