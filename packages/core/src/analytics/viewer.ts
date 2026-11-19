/**
 * The viewer's page of the local record (PEN-137, Analytics data viewer): the types the Mac's
 * store answers with, the page asks for over the bridge, and the CLI's `analytics show` prints.
 */
import type { AnalyticsEvent, StateName } from './events';

/** An event as the store holds it. */
export interface StoredEvent extends AnalyticsEvent {
  readonly id: number;
  readonly state: StateName;
  readonly sentAt: number | null;
}

/** A place in the list, newest first. */
export interface Cursor {
  readonly at: number;
  readonly id: number;
}

/** Which clients a page shows: `app` is the Mac app and Android. */
export type ClientFilter = 'all' | 'app' | 'cli' | 'mcp';

export interface PageQuery {
  readonly state?: StateName | 'all' | undefined;
  readonly client?: ClientFilter | undefined;
  /** Older than this (Earlier). */
  readonly before?: Cursor | undefined;
  /** Newer than this (Later). */
  readonly after?: Cursor | undefined;
  readonly limit?: number | undefined;
}

export interface Page {
  readonly events: readonly StoredEvent[];
  /** How many events match the filters. */
  readonly total: number;
  /** How many newer than the page match (so the first row's number is `newer + 1`). */
  readonly newer: number;
}

/** What Delete My Shared Data did, and the state after it. */
export interface ForgetResult {
  readonly outcome: 'ok' | 'offline' | 'failed';
}
