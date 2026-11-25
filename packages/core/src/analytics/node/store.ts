/**
 * The local usage record on a Mac (PEN-137, N10): one SQLite database,
 * `~/.penmoss/analytics/events.db`, shared by the app (its main process's worker thread), the
 * CLI and the local MCP server, through `node:sqlite` in WAL mode. It is both the upload queue
 * and what the viewer pages through. Android keeps the same table in Room.
 *
 * It stays fast at the largest limits (800,000 events): every query the clients run is served
 * by an index, counts by state are kept by triggers, the viewer pages by keyset on (at, id), and
 * pruning runs in time-boxed steps (STEP_MS each): small DELETEs whose size follows how long the
 * last took, a WAL checkpoint after each step, and the vacuum a few pages at a time, yielding
 * after every step, so no step holds the database long.
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

export type { Cursor, Page, PageQuery, StoredEvent } from '../viewer';

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
 * How long one prune step may run before it yields, in ms: a step keeps taking small DELETEs (or
 * vacuum slices) while it is under this, so a step ends within it plus one chunk. The chunks
 * size themselves to CHUNK_SHARE of it, so a chunk that runs long on a busy disk makes the next
 * one smaller. A fixed 500-row DELETE took 1–3 ms on a Mac but up to 118 ms on CI.
 */
export const STEP_MS = 8;
/** The share of a step one chunk aims at: four chunks a step at the chunk's usual pace. */
const CHUNK_SHARE = 0.25;
/** Rows the first DELETE of a prune takes; later ones follow how long the last took. */
export const PRUNE_BATCH = 200;
/** The smallest and largest DELETE. */
const MIN_ROWS = 16;
const MAX_ROWS = 4000;
/** Free pages the first vacuum slice gives back, and the bounds of later ones. */
const VACUUM_PAGES = 16;
const MIN_PAGES = 1;
const MAX_PAGES = 512;

/**
 * Pages of WAL that trigger a checkpoint (1 MB at SQLite's 4 KB pages) outside a prune. While a
 * prune runs this connection's auto-checkpoint is off, so no chunk's commit writes the WAL back
 * and syncs it (on CI's disk such a commit took 100–270 ms where the rest took 3 ms); the prune
 * checkpoints after every step instead, as a step of its own, so each checkpoint writes back
 * only the few pages one step wrote.
 */
const WAL_CHECKPOINT_PAGES = 250;
/** Bytes the WAL file is cut back to once it has been checkpointed. */
const WAL_SIZE_LIMIT = 4 * 1024 * 1024;

/** One step of a prune: time-boxed DELETEs, a checkpoint of the WAL, or a slice of the vacuum. */
export type PruneStep = 'delete' | 'checkpoint' | 'vacuum';

/** What a step did: the rows its DELETEs removed, or the pages its vacuum gave back. */
export interface PruneStepDone {
  readonly rows?: number;
  readonly pages?: number;
  /** How many DELETEs or vacuum slices the step ran. */
  readonly chunks?: number;
}

export interface PruneOptions {
  /** Rows the first DELETE takes; later ones follow how long the last took. */
  readonly batch?: number;
  /** How long one step may run before it yields, in ms (STEP_MS). */
  readonly stepMs?: number;
  /** The clock steps and chunks are timed by, in ms (tests pass a fake one). */
  readonly clock?: () => number;
  /** Called after every step; an async store yields here. */
  readonly between?: (step: PruneStep, done: PruneStepDone) => void | Promise<void>;
}

/**
 * The size of the next chunk, from how long the last took: aims each chunk at a share of the
 * step, growing at most twice and shrinking at most to a quarter at a time, within its bounds.
 */
class ChunkSizer {
  private current: number;

  constructor(
    first: number,
    private readonly target: number,
    private readonly min: number,
    private readonly max: number,
  ) {
    this.current = Math.min(max, Math.max(min, Math.round(first)));
  }

  get size(): number {
    return this.current;
  }

  /** Records that a chunk of `size` took `ms`. */
  took(size: number, ms: number): void {
    const ratio = ms <= 0 ? 2 : Math.min(2, Math.max(0.25, this.target / ms));
    this.current = Math.min(this.max, Math.max(this.min, Math.round(size * ratio)));
  }
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
    // Checkpoint every 250 pages (1 MB), not SQLite's 1,000: the commit that crosses the mark
    // writes the WAL back and syncs it, and a prune's batch that does that with 4 MB took over
    // 100 ms on CI's disk where the rest took 3 ms. And give the WAL file back after a big prune
    // or vacuum, which otherwise leaves it at its largest (about 180 MB from 800,000 events).
    db.exec(`PRAGMA wal_autocheckpoint = ${WAL_CHECKPOINT_PAGES}`);
    db.exec(`PRAGMA journal_size_limit = ${WAL_SIZE_LIMIT}`);
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

  /**
   * Deletes the oldest events in time-boxed steps, then gives back the free pages, yielding after
   * every step. A delete step runs small DELETEs, each its own transaction and sized by how long
   * the last took, until it has run `stepMs` or nothing is left; a checkpoint of the few WAL
   * pages it wrote follows it as a step of its own; the vacuum runs the same way, a few pages a
   * slice. Auto-checkpoint is off meanwhile, so a checkpoint never lands inside a chunk's commit.
   * Returns how many events went.
   */
  private *pruneSteps(
    limits: Pick<Limits, 'events.days' | 'events.max'>,
    now: number,
    options: Omit<PruneOptions, 'between'>,
  ): Generator<[PruneStep, PruneStepDone], number> {
    const stepMs = options.stepMs ?? STEP_MS;
    const clock = options.clock ?? (() => performance.now());
    const before = this.size();
    let removed = 0;
    const cutoff = now - limits['events.days'] * DAY;
    const byAge = this.statement(
      'DELETE FROM events WHERE id IN (SELECT id FROM events WHERE at < ? ORDER BY at, id LIMIT ?)',
    );
    const byCap = this.statement(
      'DELETE FROM events WHERE id IN (SELECT id FROM events ORDER BY at, id LIMIT ?)',
    );
    const rows = new ChunkSizer(
      options.batch ?? PRUNE_BATCH,
      stepMs * CHUNK_SHARE,
      MIN_ROWS,
      MAX_ROWS,
    );
    // One DELETE of at most `rows.size` rows, timed; how many it removed and whether it found
    // fewer than it asked for.
    const chunk = (run: (limit: number) => number, most = Infinity) => {
      const size = Math.min(rows.size, most);
      const started = clock();
      const changes = this.transaction(() => run(size));
      // Only a full chunk of the sizer's own size says how long that size takes.
      if (changes === size && size === rows.size) rows.took(size, clock() - started);
      removed += changes;
      return { changes, last: changes < size };
    };
    this.db.exec('PRAGMA wal_autocheckpoint = 0');
    try {
      // By age, then by cap: each step runs chunks until its time is up or nothing is left.
      for (let done = false; !done;) {
        const started = clock();
        let step = 0;
        let chunks = 0;
        do {
          const { changes, last } = chunk((limit) => Number(byAge.run(cutoff, limit).changes));
          step += changes;
          chunks += 1;
          done = last;
        } while (!done && clock() - started < stepMs);
        if (step === 0) break;
        yield ['delete', { rows: step, chunks }];
        this.checkpoint();
        yield ['checkpoint', {}];
      }
      for (let done = false; !done;) {
        const started = clock();
        let step = 0;
        let chunks = 0;
        do {
          const excess = this.size() - limits['events.max'];
          if (excess <= 0) {
            done = true;
            break;
          }
          const { changes } = chunk((limit) => Number(byCap.run(limit).changes), excess);
          step += changes;
          chunks += 1;
          // A count that drifted from the rows must not loop forever.
          if (changes === 0) done = true;
        } while (!done && clock() - started < stepMs);
        if (step === 0) break;
        yield ['delete', { rows: step, chunks }];
        this.checkpoint();
        yield ['checkpoint', {}];
      }
      if (before > 0 && removed / before > 0.1) yield* this.vacuumSteps(stepMs, clock);
    } finally {
      this.db.exec(`PRAGMA wal_autocheckpoint = ${WAL_CHECKPOINT_PAGES}`);
    }
    return removed;
  }

  /** Removes what falls outside the limits in time-boxed steps, yielding after each; how many went. */
  async prune(
    limits: Pick<Limits, 'events.days' | 'events.max'>,
    now: number,
    options: PruneOptions = {},
  ): Promise<number> {
    const steps = this.pruneSteps(limits, now, options);
    try {
      for (;;) {
        const step = steps.next();
        if (step.done) return step.value;
        await options.between?.(...step.value);
      }
    } finally {
      // A `between` that threw leaves the generator open: close it, so auto-checkpoint is back.
      steps.return(0);
    }
  }

  /** The same, without yielding (the CLI's and MCP server's prune). */
  pruneNow(
    limits: Pick<Limits, 'events.days' | 'events.max'>,
    now: number,
    options: Omit<PruneOptions, 'between'> = {},
  ): number {
    const steps = this.pruneSteps(limits, now, options);
    for (;;) {
      const step = steps.next();
      if (step.done) return step.value;
    }
  }

  /** Writes the WAL back without waiting for readers; another process's lock skips it. */
  private checkpoint(): void {
    try {
      this.db.exec('PRAGMA wal_checkpoint(PASSIVE)');
    } catch {
      // Another process holds the database; its own checkpoint or the next one catches up.
    }
  }

  private freePages(): number {
    return (this.statement('PRAGMA freelist_count').get() as { freelist_count: number })
      .freelist_count;
  }

  /**
   * Gives back the free pages in time-boxed steps: each runs `incremental_vacuum` slices, sized
   * by how long the last took, until it has run `stepMs` or none are left, and a checkpoint
   * follows each step.
   */
  private *vacuumSteps(
    stepMs: number,
    clock: () => number,
  ): Generator<[PruneStep, PruneStepDone], void> {
    const pages = new ChunkSizer(VACUUM_PAGES, stepMs * CHUNK_SHARE, MIN_PAGES, MAX_PAGES);
    try {
      let free = this.freePages();
      let stuck = false;
      while (free > 0 && !stuck) {
        const started = clock();
        const was = free;
        let chunks = 0;
        do {
          const size = Math.min(pages.size, free);
          const slice = clock();
          this.db.exec(`PRAGMA incremental_vacuum(${size})`);
          pages.took(size, clock() - slice);
          chunks += 1;
          const left = this.freePages();
          // A vacuum that freed nothing (another process holds the database) stops here.
          stuck = left >= free;
          free = left;
        } while (!stuck && free > 0 && clock() - started < stepMs);
        if (free >= was) break;
        yield ['vacuum', { pages: was - free, chunks }];
        this.checkpoint();
        yield ['checkpoint', {}];
      }
    } catch {
      // Another process holds the database; the next prune tries again.
    }
  }

  /** Gives back the free pages after a large prune, all at once (tests and maintenance). */
  vacuum(): void {
    const steps = this.vacuumSteps(STEP_MS, () => performance.now());
    while (!steps.next().done) {
      // Each step runs as the loop asks for it.
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
