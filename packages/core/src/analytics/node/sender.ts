/**
 * Sending (PEN-137, Local store and sending): only the Mac app's main process sends (Android's
 * WorkManager does the same in Kotlin). Up to 200 waiting events, oldest first, with a 10 s
 * timeout. Offline, a 5xx or a timeout keeps them and backs off up to an hour; a 4xx marks the
 * batch refused; 429 honours Retry-After. Nothing here ever throws to its caller.
 */
import {
  BATCH_VERSION,
  MAX_BACKOFF_MS,
  MAX_BATCH_BYTES,
  MAX_BATCH_EVENTS,
  SEND_EVERY_MS,
  SEND_TIMEOUT_MS,
  type AnalyticsBatch,
} from '../events';
import { wireEvent, type StoredEvent } from './store';

export const ANALYTICS_BASE = 'https://t.penmoss.app';

/** The endpoint's base: `PENMOSS_ANALYTICS_URL` (tests) or t.penmoss.app. */
export function analyticsBase(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  return (env.PENMOSS_ANALYTICS_URL?.trim() || ANALYTICS_BASE).replace(/\/+$/, '');
}

export interface SendQueue {
  nextBatch(limit: number): StoredEvent[];
  markSent(ids: readonly number[], at: number): void;
  markRefused(ids: readonly number[]): void;
  setMeta(key: string, value: string): void;
}

export type SendOutcome =
  | { readonly kind: 'empty' }
  | { readonly kind: 'sent'; readonly sent: number; readonly refused: number }
  | { readonly kind: 'refused'; readonly refused: number; readonly status: number }
  | { readonly kind: 'retry'; readonly status: number | null; readonly retryAfterMs?: number };

export interface SendOptions {
  readonly base: string;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

/** The batch body for `events`, trimmed to the byte limit. */
export function batchBody(
  install: string,
  events: readonly StoredEvent[],
): {
  body: string;
  events: StoredEvent[];
} {
  let kept = [...events];
  for (;;) {
    const batch: AnalyticsBatch = { v: BATCH_VERSION, install, events: kept.map(wireEvent) };
    const body = JSON.stringify(batch);
    if (new TextEncoder().encode(body).length <= MAX_BATCH_BYTES || kept.length <= 1) {
      return { body, events: kept };
    }
    kept = kept.slice(0, Math.ceil(kept.length / 2));
  }
}

function retryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_BACKOFF_MS);
  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : Math.max(0, Math.min(at - Date.now(), MAX_BACKOFF_MS));
}

/** Sends the next batch of waiting events from `queue`. */
export async function sendNext(
  queue: SendQueue,
  install: string,
  options: SendOptions,
): Promise<SendOutcome> {
  const now = options.now ?? Date.now;
  const waiting = queue.nextBatch(MAX_BATCH_EVENTS);
  if (waiting.length === 0) return { kind: 'empty' };
  const { body, events } = batchBody(install, waiting);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? SEND_TIMEOUT_MS);
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort);
  try {
    const response = await (options.fetch ?? fetch)(`${options.base}/v1/batch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: controller.signal,
    });
    const status = response.status;
    if (status === 202 || status === 200) {
      let refusedIndexes: number[] = [];
      try {
        const answer = (await response.json()) as { refused?: unknown };
        if (Array.isArray(answer.refused)) {
          refusedIndexes = answer.refused.filter((n): n is number => typeof n === 'number');
        }
      } catch {
        // An answer without a body: every event was taken.
      }
      // `refused` holds the index in the batch of each event the Worker dropped.
      const refusedSet = new Set(refusedIndexes);
      const refused = events.filter((_event, index) => refusedSet.has(index));
      const sent = events.filter((_event, index) => !refusedSet.has(index));
      queue.markSent(
        sent.map((event) => event.id),
        now(),
      );
      queue.markRefused(refused.map((event) => event.id));
      queue.setMeta('lastBatch', body);
      queue.setMeta('lastBatchAt', String(now()));
      return { kind: 'sent', sent: sent.length, refused: refused.length };
    }
    if (status === 429) {
      const after = retryAfter(response.headers.get('retry-after'));
      return after === undefined
        ? { kind: 'retry', status }
        : { kind: 'retry', status, retryAfterMs: after };
    }
    if (status >= 400 && status < 500) {
      queue.markRefused(events.map((event) => event.id));
      return { kind: 'refused', refused: events.length, status };
    }
    return { kind: 'retry', status };
  } catch {
    return { kind: 'retry', status: null };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
  }
}

/** The wait before the next try: a minute, doubling to an hour, reset by a success. */
export class Backoff {
  private failures = 0;

  next(outcome: SendOutcome): number {
    if (outcome.kind === 'retry') {
      if (outcome.retryAfterMs !== undefined) return outcome.retryAfterMs;
      this.failures += 1;
      return Math.min(SEND_EVERY_MS * 2 ** (this.failures - 1), MAX_BACKOFF_MS);
    }
    this.failures = 0;
    return SEND_EVERY_MS;
  }

  get failing(): boolean {
    return this.failures > 0;
  }
}

export type ForgetOutcome = 'ok' | 'offline' | 'failed';

/** Asks the server to delete everything shared under `install` (Delete My Shared Data). */
export async function forgetShared(
  install: string,
  options: Pick<SendOptions, 'base' | 'fetch' | 'timeoutMs'>,
): Promise<ForgetOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? SEND_TIMEOUT_MS);
  try {
    const response = await (options.fetch ?? fetch)(`${options.base}/v1/forget`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ v: BATCH_VERSION, install }),
      signal: controller.signal,
    });
    return response.ok ? 'ok' : 'failed';
  } catch {
    return 'offline';
  } finally {
    clearTimeout(timer);
  }
}
