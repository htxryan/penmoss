/**
 * Main's handle on the usage record (PEN-137): the worker thread that owns
 * `~/.penmoss/analytics/events.db` (`analytics-host.ts`), reached by messages. Inserts and marks
 * are posted and never waited for; questions come back as promises. Should the worker fail
 * (no `node:sqlite`, a database it cannot open), every question answers as if the record were
 * empty and nothing is kept: recording never takes the app down.
 */
import {
  STATE_NAMES,
  type Page,
  type PageQuery,
  type StateName,
  type StoredEvent,
} from '@penmoss/core/analytics';
import type { EventLimits, HostCall, HostMessage, HostReply, Inserted } from './analytics-host';

/** What main asks of the record. */
export interface StoreApi {
  insert(events: readonly Inserted[]): void;
  markSent(ids: readonly number[], at: number): void;
  markRefused(ids: readonly number[]): void;
  setMeta(key: string, value: string): void;
  /** The limits the hourly prune uses. */
  setLimits(limits: EventLimits): void;
  counts(): Promise<Record<StateName, number>>;
  page(query: PageQuery): Promise<Page>;
  outside(limits: EventLimits, now: number): Promise<number>;
  nextBatch(limit: number): Promise<StoredEvent[]>;
  meta(key: string): Promise<string | null>;
  applyAnswer(consent: 'yes' | 'no'): Promise<number>;
  sharingOff(): Promise<number>;
  unsentToLocal(): Promise<number>;
  prune(limits: EventLimits, now: number): Promise<number>;
  /** Inserts what waits and closes the database (the app quits). */
  close(): Promise<void>;
}

/** A worker, or one end of a MessageChannel in the tests. */
export interface StorePort {
  postMessage(message: HostMessage): void;
  on(event: 'message', listener: (message: unknown) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'exit', listener: (code: number) => void): unknown;
}

export const NO_COUNTS: Readonly<Record<StateName, number>> = Object.fromEntries(
  STATE_NAMES.map((name) => [name, 0]),
) as Record<StateName, number>;

const EMPTY_PAGE: Page = { events: [], total: 0, newer: 0 };

/** The empty answer to each question, for a record that is not there. */
function fallback(call: HostCall): unknown {
  switch (call.op) {
    case 'counts':
      return { ...NO_COUNTS };
    case 'page':
      return EMPTY_PAGE;
    case 'nextBatch':
      return [];
    case 'meta':
    case 'flush':
    case 'close':
      return null;
    default:
      return 0;
  }
}

export class WorkerStore implements StoreApi {
  private nextId = 1;
  private readonly waiting = new Map<
    number,
    { readonly call: HostCall; readonly resolve: (value: unknown) => void }
  >();
  private dead = false;

  constructor(
    private readonly port: StorePort,
    private readonly log: (message: string) => void = () => undefined,
  ) {
    port.on('message', (message) => this.receive(message));
    port.on('error', (error) => this.fail(`analytics worker failed: ${String(error)}`));
    port.on('exit', (code) => this.fail(`analytics worker ended (${code})`));
  }

  /** Whether the worker is gone (a failure, or closed). */
  get gone(): boolean {
    return this.dead;
  }

  private receive(message: unknown): void {
    if (!message || typeof message !== 'object') return;
    if ('log' in message) {
      this.log(String(message.log));
      return;
    }
    const reply = message as HostReply;
    const waiting = this.waiting.get(reply.id);
    if (!waiting) return;
    this.waiting.delete(reply.id);
    if (reply.ok) waiting.resolve(reply.value);
    else {
      if (reply.error !== 'closed') this.log(`analytics ${waiting.call.op}: ${reply.error}`);
      waiting.resolve(fallback(waiting.call));
    }
  }

  private fail(message: string): void {
    if (this.dead) return;
    this.dead = true;
    this.log(message);
    for (const { call, resolve } of this.waiting.values()) resolve(fallback(call));
    this.waiting.clear();
  }

  private post(message: HostMessage): void {
    if (this.dead) return;
    try {
      this.port.postMessage(message);
    } catch (error) {
      this.fail(`analytics worker unreachable: ${String(error)}`);
    }
  }

  private ask<T>(call: HostCall): Promise<T> {
    if (this.dead) return Promise.resolve(fallback(call) as T);
    const id = this.nextId++;
    return new Promise<T>((resolve) => {
      this.waiting.set(id, { call, resolve: resolve as (value: unknown) => void });
      this.post({ ...call, id });
    });
  }

  insert(events: readonly Inserted[]): void {
    if (events.length > 0) this.post({ op: 'insert', events });
  }
  markSent(ids: readonly number[], at: number): void {
    if (ids.length > 0) this.post({ op: 'markSent', ids, at });
  }
  markRefused(ids: readonly number[]): void {
    if (ids.length > 0) this.post({ op: 'markRefused', ids });
  }
  setMeta(key: string, value: string): void {
    this.post({ op: 'setMeta', key, value });
  }
  setLimits(limits: EventLimits): void {
    this.post({ op: 'limits', limits });
  }
  counts(): Promise<Record<StateName, number>> {
    return this.ask({ op: 'counts' });
  }
  page(query: PageQuery): Promise<Page> {
    return this.ask({ op: 'page', query });
  }
  outside(limits: EventLimits, now: number): Promise<number> {
    return this.ask({ op: 'outside', limits, now });
  }
  nextBatch(limit: number): Promise<StoredEvent[]> {
    return this.ask({ op: 'nextBatch', limit });
  }
  meta(key: string): Promise<string | null> {
    return this.ask({ op: 'meta', key });
  }
  applyAnswer(consent: 'yes' | 'no'): Promise<number> {
    return this.ask({ op: 'applyAnswer', consent });
  }
  sharingOff(): Promise<number> {
    return this.ask({ op: 'sharingOff' });
  }
  unsentToLocal(): Promise<number> {
    return this.ask({ op: 'unsentToLocal' });
  }
  prune(limits: EventLimits, now: number): Promise<number> {
    return this.ask({ op: 'prune', limits, now });
  }
  async close(): Promise<void> {
    await this.ask({ op: 'close' });
    this.dead = true;
  }
}
