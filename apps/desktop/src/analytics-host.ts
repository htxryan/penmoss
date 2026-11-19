/**
 * The usage record's worker side (PEN-137, Local store and sending): the Mac app keeps
 * `~/.penmoss/analytics/events.db` in a worker thread, so no SQLite runs on the main thread.
 * Main stamps and checks each event and posts it here (`analytics-store.ts`); this side inserts
 * them every second or every 100 events in one transaction, prunes hourly and when a limit
 * drops (a batch at a time, yielding between batches, so a page or a count is answered while it
 * runs), and answers main's questions: counts, a viewer page, what the limits would remove, the
 * next batch to send.
 *
 * Pure Node, no Electron: `analytics-worker.ts` runs it on the worker's `parentPort`, and the
 * tests run it in-process over a `MessageChannel`.
 */
import type { AnalyticsEvent, Limits, PageQuery, StateCode } from '@penmoss/core/analytics';
import { PRUNE_BATCH, type AnalyticsStore } from '@penmoss/core/analytics/node';

/** An event to insert, with the state it was recorded in. */
export interface Inserted {
  readonly event: AnalyticsEvent;
  readonly state: StateCode;
}

export type EventLimits = Pick<Limits, 'events.days' | 'events.max'>;

/** Main's questions, each answered by its `id`. */
export type HostCall =
  | { readonly op: 'counts' }
  | { readonly op: 'page'; readonly query: PageQuery }
  | { readonly op: 'outside'; readonly limits: EventLimits; readonly now: number }
  | { readonly op: 'nextBatch'; readonly limit: number }
  | { readonly op: 'meta'; readonly key: string }
  | { readonly op: 'applyAnswer'; readonly consent: 'yes' | 'no' }
  | { readonly op: 'sharingOff' }
  | { readonly op: 'unsentToLocal' }
  | { readonly op: 'prune'; readonly limits: EventLimits; readonly now: number }
  | { readonly op: 'flush' }
  | { readonly op: 'close' };

/** What main tells it without waiting for an answer. */
export type HostNote =
  | { readonly op: 'insert'; readonly events: readonly Inserted[] }
  | { readonly op: 'markSent'; readonly ids: readonly number[]; readonly at: number }
  | { readonly op: 'markRefused'; readonly ids: readonly number[] }
  | { readonly op: 'setMeta'; readonly key: string; readonly value: string }
  | { readonly op: 'limits'; readonly limits: EventLimits };

export type HostMessage = (HostCall & { readonly id: number }) | HostNote;

export type HostReply =
  | { readonly id: number; readonly ok: true; readonly value: unknown }
  | { readonly id: number; readonly ok: false; readonly error: string };

/** The worker's start-up data. */
export interface HostData {
  /** The database's path (`:memory:` in tests). */
  readonly path: string;
  readonly limits: EventLimits;
}

export interface HostOptions {
  /** Insert at least this often while events wait (ms). */
  readonly flushMs?: number;
  /** Or as soon as this many wait. */
  readonly flushAt?: number;
  /** Prune this often (ms); and once, `firstPruneMs` after starting. */
  readonly pruneEveryMs?: number;
  readonly firstPruneMs?: number;
  /** Rows per prune batch (core's PRUNE_BATCH unless a test says). */
  readonly pruneBatch?: number;
  readonly now?: () => number;
  /** Told of a failure that is kept from main (a busy database, a prune that failed). */
  readonly onError?: (message: string) => void;
}

/** How many events may wait for a busy database before the oldest are dropped. */
export const MAX_BUFFERED = 20_000;

const yieldNow = () => new Promise<void>((resolve) => setImmediate(resolve));

/** One worker's store: buffers inserts, prunes, answers main's calls in the order they came. */
export class StoreHost {
  private buffer: Inserted[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private pruneTimer: ReturnType<typeof setInterval> | null = null;
  private firstPrune: ReturnType<typeof setTimeout> | null = null;
  private pruning: Promise<number> | null = null;
  private limits: EventLimits;
  private closed = false;
  private readonly flushMs: number;
  private readonly flushAt: number;
  private readonly now: () => number;

  constructor(
    private readonly store: AnalyticsStore,
    private readonly reply: (reply: HostReply) => void,
    limits: EventLimits,
    private readonly options: HostOptions = {},
  ) {
    this.limits = limits;
    this.flushMs = options.flushMs ?? 1000;
    this.flushAt = options.flushAt ?? 100;
    this.now = options.now ?? Date.now;
    const every = options.pruneEveryMs ?? 3_600_000;
    this.pruneTimer = setInterval(() => void this.pruneQuietly(), every);
    this.pruneTimer.unref?.();
    this.firstPrune = setTimeout(() => void this.pruneQuietly(), options.firstPruneMs ?? 30_000);
    this.firstPrune.unref?.();
  }

  /** One message from main. */
  handle(message: HostMessage): void {
    if (this.closed) {
      if ('id' in message) this.reply({ id: message.id, ok: false, error: 'closed' });
      return;
    }
    if (!('id' in message)) {
      this.note(message);
      return;
    }
    void this.call(message).then(
      (value) => this.reply({ id: message.id, ok: true, value }),
      (error: unknown) =>
        this.reply({
          id: message.id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }),
    );
  }

  private note(message: HostNote): void {
    switch (message.op) {
      case 'insert':
        this.buffer.push(...message.events);
        if (this.buffer.length > MAX_BUFFERED) {
          this.buffer.splice(0, this.buffer.length - MAX_BUFFERED);
        }
        if (this.buffer.length >= this.flushAt) this.flush();
        else this.flushTimer ??= setTimeout(() => this.flush(), this.flushMs);
        return;
      case 'markSent':
        this.guard(() => this.store.markSent(message.ids, message.at));
        return;
      case 'markRefused':
        this.guard(() => this.store.markRefused(message.ids));
        return;
      case 'setMeta':
        this.guard(() => this.store.setMeta(message.key, message.value));
        return;
      case 'limits':
        this.limits = message.limits;
        return;
    }
  }

  private guard(work: () => void): void {
    try {
      this.flush();
      work();
    } catch (error) {
      this.options.onError?.(`analytics store: ${String(error)}`);
    }
  }

  /**
   * Inserts what waits, in one transaction. A busy database (the CLI writing) keeps the events
   * for the next try.
   */
  flush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (this.buffer.length === 0) return;
    const events = this.buffer;
    this.buffer = [];
    try {
      this.store.insert(events);
    } catch (error) {
      this.buffer = [...events, ...this.buffer];
      if (!this.closed) this.flushTimer = setTimeout(() => this.flush(), this.flushMs);
      this.options.onError?.(`analytics insert: ${String(error)}`);
    }
  }

  /** How many events wait to be inserted (the tests read it). */
  get buffered(): number {
    return this.buffer.length;
  }

  private async call(message: HostCall): Promise<unknown> {
    // What was recorded before a call is in the store when it runs: a state change or a count
    // never misses an event still waiting to be inserted.
    this.flush();
    switch (message.op) {
      case 'counts':
        return this.store.counts();
      case 'page':
        return this.store.page(message.query);
      case 'outside':
        return this.store.outside(message.limits, message.now);
      case 'nextBatch':
        return this.store.nextBatch(message.limit);
      case 'meta':
        return this.store.meta(message.key);
      case 'applyAnswer':
        return this.store.applyAnswer(message.consent);
      case 'sharingOff':
        return this.store.sharingOff();
      case 'unsentToLocal':
        return this.store.unsentToLocal();
      case 'prune':
        this.limits = message.limits;
        return this.prune(message.limits, message.now);
      case 'flush':
        return null;
      case 'close':
        await this.close();
        return null;
    }
  }

  /** Removes what falls outside the limits, yielding between batches; one prune at a time. */
  async prune(limits: EventLimits = this.limits, now = this.now()): Promise<number> {
    while (this.pruning) await this.pruning.catch(() => 0);
    const running = this.store.prune(limits, now, {
      batch: this.options.pruneBatch ?? PRUNE_BATCH,
      between: () => {
        this.flush();
        return yieldNow();
      },
    });
    this.pruning = running;
    try {
      return await running;
    } finally {
      this.pruning = null;
    }
  }

  private async pruneQuietly(): Promise<void> {
    try {
      await this.prune();
    } catch (error) {
      this.options.onError?.(`analytics prune: ${String(error)}`);
    }
  }

  /** Inserts what waits, stops the timers and closes the database. */
  async close(): Promise<void> {
    if (this.closed) return;
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    if (this.firstPrune) clearTimeout(this.firstPrune);
    await this.pruning?.catch(() => 0);
    this.flush();
    this.closed = true;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    try {
      this.store.close();
    } catch {
      // Already closed.
    }
  }
}
