/**
 * The local usage record on a Mac (PEN-137, N10): one SQLite database,
 * `~/.penmoss/analytics/events.db`, shared by the app (its main process's worker thread), the
 * CLI and the local MCP server, through `node:sqlite` in WAL mode. It is both the upload queue
 * and what the viewer pages through. Android keeps the same table in Room.
 *
 * It stays fast at the largest limits (800,000 events): every query the clients run is served
 * by an index, counts by state are kept by triggers, the viewer pages by keyset on (at, id), and
 * pruning deletes PRUNE_BATCH rows at a time, yielding between batches.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import {
  STATES,
  STATE_NAMES,
  stateName,
  type AnalyticsEvent,
  type StateCode,
  type StateName,
} from '../events';
import type { Limits } from '../limits';
import type { Cursor, Page, PageQuery, StoredEvent } from '../viewer';

export type { ClientFilter, Cursor, Page, PageQuery, StoredEvent } from '../viewer';

/**
 * `node:sqlite`, loaded when a store is first opened, never at import: a bundle (the CLI's)
 * would otherwise hoist the import to its top, so every command would load SQLite (and print
 * Node's ExperimentalWarning), and a Node without it could not start the CLI at all. Throws
 * where there is no `node:sqlite`.
 */
export function sqliteModule(): typeof import('node:sqlite') {
  const loaded = process.getBuiltinModule?.('node:sqlite') as
    typeof import('node:sqlite') | undefined;
  if (!loaded?.DatabaseSync) throw new Error('node:sqlite is not available');
  return loaded;
}

const SCHEMA_VERSION = '1';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  session TEXT NOT NULL,
  seq INTEGER NOT NULL,
  client TEXT NOT NULL,
  actor TEXT NOT NULL,
  version TEXT NOT NULL,
  channel TEXT NOT NULL,
  os TEXT NOT NULL,
  os_version TEXT NOT NULL,
  size_class TEXT,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  props TEXT NOT NULL,
  state INTEGER NOT NULL,
  sent_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS events_key ON events(session, seq);
CREATE INDEX IF NOT EXISTS events_at ON events(at, id);
CREATE INDEX IF NOT EXISTS events_state_at ON events(state, at, id);
CREATE INDEX IF NOT EXISTS events_client_at ON events(client, at, id);
CREATE TABLE IF NOT EXISTS state_counts (state INTEGER PRIMARY KEY, n INTEGER NOT NULL);
INSERT OR IGNORE INTO state_counts (state, n) VALUES (0, 0), (1, 0), (2, 0), (3, 0), (4, 0);
CREATE TRIGGER IF NOT EXISTS events_counted_insert AFTER INSERT ON events BEGIN
  UPDATE state_counts SET n = n + 1 WHERE state = NEW.state;
END;
CREATE TRIGGER IF NOT EXISTS events_counted_delete AFTER DELETE ON events BEGIN
  UPDATE state_counts SET n = n - 1 WHERE state = OLD.state;
END;
CREATE TRIGGER IF NOT EXISTS events_counted_update AFTER UPDATE OF state ON events
WHEN OLD.state <> NEW.state BEGIN
  UPDATE state_counts SET n = n - 1 WHERE state = OLD.state;
  UPDATE state_counts SET n = n + 1 WHERE state = NEW.state;
END;
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
`;

/**
 * Rows per DELETE when pruning. Each batch is one statement and its commit; at 800,000 events on
 * a busy Mac 500 rows took 1–4 ms (95th percentile under 4 ms, the slowest about 10 ms with a
 * WAL checkpoint), where 5,000 took 12–20 ms and up to 190 ms, and 800,000 → 5,000 takes about
 * 2.5 s (analytics-store.budget.test.ts).
 */
export const PRUNE_BATCH = 500;

export interface PruneOptions {
  /** Rows per DELETE. */
  readonly batch?: number;
  /** Called between batches; an async store yields here. */
  readonly between?: () => void | Promise<void>;
}

interface Row {
  id: number;
  at: number;
  session: string;
  seq: number;
  client: string;
  actor: string;
  version: string;
  channel: string;
  os: string;
  os_version: string;
  size_class: string | null;
  kind: string;
  name: string;
  props: string;
  state: number;
  sent_at: number | null;
}

function fromRow(row: Row): StoredEvent {
  let props: AnalyticsEvent['props'];
  try {
    props = JSON.parse(row.props) as AnalyticsEvent['props'];
  } catch {
    props = {};
  }
  return {
    id: row.id,
    at: row.at,
    session: row.session,
    seq: row.seq,
    client: row.client as AnalyticsEvent['client'],
    actor: row.actor as AnalyticsEvent['actor'],
    version: row.version,
    channel: row.channel as AnalyticsEvent['channel'],
    os: row.os as AnalyticsEvent['os'],
    osVersion: row.os_version,
    ...(row.size_class ? { sizeClass: row.size_class as AnalyticsEvent['sizeClass'] } : {}),
    kind: row.kind as AnalyticsEvent['kind'],
    name: row.name,
    props,
    state: stateName(row.state),
    sentAt: row.sent_at,
  };
}

/** The event as it goes in a batch: the stored fields only. */
export function wireEvent(event: StoredEvent): AnalyticsEvent {
  const wire: Record<string, unknown> = { ...event };
  for (const key of ['id', 'state', 'sentAt']) delete wire[key];
  return wire as unknown as AnalyticsEvent;
}

const DAY = 86_400_000;

export class AnalyticsStore {
  private readonly db: DatabaseSync;
  private readonly statements = new Map<string, StatementSync>();

  private constructor(db: DatabaseSync) {
    this.db = db;
  }

  /** Opens (and makes) the database at `path`; `:memory:` for tests. */
  static open(path: string): AnalyticsStore {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const db = new (sqliteModule().DatabaseSync)(path, { timeout: 2000 });
    // auto_vacuum must be set before the first table; it is a no-op on an existing database.
    db.exec('PRAGMA auto_vacuum = INCREMENTAL');
    if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec('PRAGMA busy_timeout = 2000');
    db.exec(SCHEMA);
    db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('schema', ?)").run(SCHEMA_VERSION);
    return new AnalyticsStore(db);
  }

  private statement(sql: string): StatementSync {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  private transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** Inserts events in one transaction; one already there (same session and seq) is skipped. */
  insert(
    events: ReadonlyArray<{ readonly event: AnalyticsEvent; readonly state: StateCode }>,
  ): number {
    if (events.length === 0) return 0;
    const insert = this.statement(
      `INSERT OR IGNORE INTO events
        (at, session, seq, client, actor, version, channel, os, os_version, size_class, kind, name, props, state)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    return this.transaction(() => {
      let added = 0;
      for (const { event, state } of events) {
        const result = insert.run(
          event.at,
          event.session,
          event.seq,
          event.client,
          event.actor,
          event.version,
          event.channel,
          event.os,
          event.osVersion,
          event.sizeClass ?? null,
          event.kind,
          event.name,
          JSON.stringify(event.props),
          state,
        );
        added += Number(result.changes);
      }
      return added;
    });
  }

  private move(from: readonly StateCode[], to: StateCode): number {
    const marks = from.map(() => '?').join(', ');
    const result = this.statement(`UPDATE events SET state = ? WHERE state IN (${marks})`).run(
      to,
      ...from,
    );
    return Number(result.changes);
  }

  /** The first answer: pending events become waiting (Yes) or local (No). */
  applyAnswer(consent: 'yes' | 'no'): number {
    return this.move([STATES.pending], consent === 'yes' ? STATES.waiting : STATES.local);
  }

  /** Sharing turned off: waiting events become local at once. */
  sharingOff(): number {
    return this.move([STATES.waiting], STATES.local);
  }

  /** A new ID: unsent events become local, so none goes under the new one. */
  unsentToLocal(): number {
    return this.move([STATES.waiting, STATES.pending], STATES.local);
  }

  /** The oldest waiting events, at most `limit`. */
  nextBatch(limit = 200): StoredEvent[] {
    const rows = this.statement('SELECT * FROM events WHERE state = ? ORDER BY at, id LIMIT ?').all(
      STATES.waiting,
      limit,
    ) as unknown as Row[];
    return rows.map(fromRow);
  }

  private mark(ids: readonly number[], state: StateCode, at: number | null): void {
    if (ids.length === 0) return;
    const update = this.statement(
      'UPDATE events SET state = ?, sent_at = ? WHERE id = ? AND state = ?',
    );
    this.transaction(() => {
      for (const id of ids) update.run(state, at, id, STATES.waiting);
    });
  }

  /** The endpoint took these. */
  markSent(ids: readonly number[], at: number): void {
    this.mark(ids, STATES.sent, at);
  }

  /** The endpoint refused these (a 4xx, or named in `refused`). */
  markRefused(ids: readonly number[]): void {
    this.mark(ids, STATES.refused, null);
  }

  /** How many events are in each state (from the kept counts). */
  counts(): Record<StateName, number> {
    const rows = this.statement('SELECT state, n FROM state_counts').all() as unknown as Array<{
      state: number;
      n: number;
    }>;
    const counts = Object.fromEntries(STATE_NAMES.map((name) => [name, 0])) as Record<
      StateName,
      number
    >;
    for (const row of rows) counts[stateName(row.state)] = Math.max(0, row.n);
    return counts;
  }

  /** How many events there are. */
  size(): number {
    return Object.values(this.counts()).reduce((sum, n) => sum + n, 0);
  }

  private filter(query: PageQuery): { where: string[]; args: Array<string | number> } {
    const where: string[] = [];
    const args: Array<string | number> = [];
    if (query.state && query.state !== 'all') {
      where.push('state = ?');
      args.push(STATES[query.state]);
    }
    const client = query.client ?? 'all';
    if (client === 'app') where.push("client IN ('mac', 'android')");
    else if (client !== 'all') {
      where.push('client = ?');
      args.push(client);
    }
    return { where, args };
  }

  /** How many events match a page's filters. */
  total(query: PageQuery = {}): number {
    const { where, args } = this.filter(query);
    if (where.length === 0) return this.size();
    if (where.length === 1 && query.state && query.state !== 'all') {
      return this.counts()[query.state];
    }
    const row = this.statement(`SELECT COUNT(*) AS n FROM events WHERE ${where.join(' AND ')}`).get(
      ...args,
    ) as { n: number };
    return row.n;
  }

  /** One page of events, newest first, by keyset on (at, id). */
  page(query: PageQuery = {}): Page {
    const limit = Math.max(1, Math.min(query.limit ?? 100, 1000));
    const { where, args } = this.filter(query);
    const total = this.total(query);
    if (query.after) {
      const rows = this.statement(
        `SELECT * FROM events WHERE ${[...where, '(at, id) > (?, ?)'].join(' AND ')}
         ORDER BY at ASC, id ASC LIMIT ?`,
      ).all(...args, query.after.at, query.after.id, limit) as unknown as Row[];
      const events = rows.map(fromRow).reverse();
      return { events, total, newer: this.newerThan(where, args, events[0]) };
    }
    // Row values, so SQLite seeks the (at, id) index rather than scanning it (an OR scans).
    const keyset = query.before ? ['(at, id) < (?, ?)'] : [];
    const keyArgs = query.before ? [query.before.at, query.before.id] : [];
    const clause = [...where, ...keyset];
    const rows = this.statement(
      `SELECT * FROM events ${clause.length ? `WHERE ${clause.join(' AND ')}` : ''}
       ORDER BY at DESC, id DESC LIMIT ?`,
    ).all(...args, ...keyArgs, limit) as unknown as Row[];
    const events = rows.map(fromRow);
    return { events, total, newer: query.before ? this.newerThan(where, args, events[0]) : 0 };
  }

  /** The place of the event with this id, for paging from it (`penmoss analytics show --before`). */
  cursor(id: number): Cursor | null {
    const row = this.statement('SELECT at, id FROM events WHERE id = ?').get(id) as
      Cursor | undefined;
    return row ? { at: row.at, id: row.id } : null;
  }

  private newerThan(
    where: readonly string[],
    args: ReadonlyArray<string | number>,
    first: StoredEvent | undefined,
  ): number {
    if (!first) return 0;
    const clause = [...where, '(at, id) > (?, ?)'];
    const row = this.statement(
      `SELECT COUNT(*) AS n FROM events WHERE ${clause.join(' AND ')}`,
    ).get(...args, first.at, first.id) as { n: number };
    return row.n;
  }

  /** How many events the limits would remove now: older than the days, or beyond the cap. */
  outside(limits: Pick<Limits, 'events.days' | 'events.max'>, now: number): number {
    const cutoff = now - limits['events.days'] * DAY;
    const old = (
      this.statement('SELECT COUNT(*) AS n FROM events WHERE at < ?').get(cutoff) as { n: number }
    ).n;
    const kept = this.size() - old;
    return old + Math.max(0, kept - limits['events.max']);
  }

  /** Deletes a batch at a time, yielding the running total after each. */
  private *pruneSteps(
    limits: Pick<Limits, 'events.days' | 'events.max'>,
    now: number,
    batch: number,
  ): Generator<number, number> {
    const before = this.size();
    let removed = 0;
    const cutoff = now - limits['events.days'] * DAY;
    const byAge = this.statement(
      'DELETE FROM events WHERE id IN (SELECT id FROM events WHERE at < ? ORDER BY at, id LIMIT ?)',
    );
    const byCap = this.statement(
      'DELETE FROM events WHERE id IN (SELECT id FROM events ORDER BY at, id LIMIT ?)',
    );
    for (;;) {
      const changes = Number(byAge.run(cutoff, batch).changes);
      removed += changes;
      if (changes < batch) break;
      yield removed;
    }
    for (;;) {
      const excess = this.size() - limits['events.max'];
      if (excess <= 0) break;
      const changes = Number(byCap.run(Math.min(batch, excess)).changes);
      removed += changes;
      // A count that drifted from the rows must not loop forever.
      if (changes === 0) break;
      yield removed;
    }
    if (before > 0 && removed / before > 0.1) this.vacuum();
    return removed;
  }

  /** Removes what falls outside the limits, `batch` rows at a time; how many went. */
  async prune(
    limits: Pick<Limits, 'events.days' | 'events.max'>,
    now: number,
    options: PruneOptions = {},
  ): Promise<number> {
    const steps = this.pruneSteps(limits, now, options.batch ?? PRUNE_BATCH);
    for (;;) {
      const step = steps.next();
      if (step.done) return step.value;
      await options.between?.();
    }
  }

  /** The same, without yielding (the CLI's and MCP server's prune). */
  pruneNow(
    limits: Pick<Limits, 'events.days' | 'events.max'>,
    now: number,
    batch = PRUNE_BATCH,
  ): number {
    const steps = this.pruneSteps(limits, now, batch);
    for (;;) {
      const step = steps.next();
      if (step.done) return step.value;
    }
  }

  /** Gives back the free pages after a large prune. */
  vacuum(): void {
    try {
      this.db.exec('PRAGMA incremental_vacuum');
    } catch {
      // Another process holds the database; the next prune tries again.
    }
  }

  meta(key: string): string | null {
    const row = this.statement('SELECT value FROM meta WHERE key = ?').get(key) as
      { value: string | null } | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.statement('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, value);
  }

  close(): void {
    this.statements.clear();
    this.db.close();
  }
}
