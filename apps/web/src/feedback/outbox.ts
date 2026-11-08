/**
 * Send feedback's outbox (T49, A796): every submission goes through it, so one made offline, or
 * one that failed for a reason that may pass, is sent later without anyone asking. Entries are
 * sent oldest first, one at a time, by one window at a time (a Web Lock, where the browser has
 * them); the server files each `submissionId` once, so a second sender is harmless.
 *
 * - **Retryable** (no network, signed out, a 5xx, a 429, a 409 `in_progress`): back in the queue,
 *   tried again after a backoff (5 s doubling to 10 minutes, or the server's Retry-After), and at
 *   once when the browser comes back online.
 * - **Final** (any other 4xx): kept with its error, for Retry or Discard in Settings → Status.
 * - **Sent**: removed, and `onSent` listeners get the issue (the toast).
 *
 * Discard waits for any send of the entry to finish (this window's, and through the Web Lock
 * any other window's), then removes it, so a send that fails afterwards cannot put it back.
 */
import type { FeedbackStore, OutboxEntry, OutboxError } from './store';

export interface FiledIssue {
  readonly number: number;
  readonly url: string;
}

export type SendResult =
  | { readonly ok: true; readonly issue: FiledIssue }
  | {
      readonly ok: false;
      readonly retryable: boolean;
      readonly error: OutboxError;
      /** The server's Retry-After, in ms. */
      readonly retryAfterMs?: number;
    };

/** What happened to one entry when it was tried. */
export type Attempt =
  | { readonly kind: 'sent'; readonly issue: FiledIssue }
  | { readonly kind: 'queued'; readonly error: OutboxError | null }
  /** Another window is sending feedback now; this entry goes in its turn. */
  | { readonly kind: 'elsewhere' }
  | { readonly kind: 'failed'; readonly error: OutboxError };

export interface OutboxOptions {
  readonly store: FeedbackStore;
  readonly send: (entry: OutboxEntry) => Promise<SendResult>;
  /** Whether the device is online now (no point trying otherwise). */
  readonly online: () => boolean;
  readonly now?: () => number;
  /**
   * One sender across windows: runs `work` now and answers true, or answers false without
   * running it when another window holds the lock.
   */
  readonly exclusive?: (work: () => Promise<void>) => Promise<boolean>;
  /** The same lock, waited for: runs `work` once no other window holds it. */
  readonly exclusiveWait?: (work: () => Promise<void>) => Promise<void>;
  readonly schedule?: (run: () => void, ms: number) => () => void;
}

export const BACKOFF_FIRST_MS = 5_000;
export const BACKOFF_MAX_MS = 10 * 60_000;

/** How long to wait before trying an entry again after `attempts` failed tries. */
export function backoff(attempts: number, retryAfterMs?: number): number {
  const doubling = Math.min(BACKOFF_MAX_MS, BACKOFF_FIRST_MS * 2 ** Math.max(0, attempts - 1));
  return Math.max(doubling, Math.min(retryAfterMs ?? 0, 60 * 60_000));
}

/** Whether an answer (or no answer) may pass by itself (A796). */
export function retryable(status: number, code: string): boolean {
  if (status === 0) return true;
  if (status >= 500 || status === 429) return true;
  return status === 409 && code === 'in_progress';
}

/** Web Locks' `ifAvailable`, where the browser has them; otherwise this window just runs. */
export function webLock(name: string): (work: () => Promise<void>) => Promise<boolean> {
  return async (work) => {
    const locks = (globalThis.navigator as Navigator | undefined)?.locks;
    if (!locks) {
      await work();
      return true;
    }
    let ran = false;
    await locks.request(name, { ifAvailable: true }, async (lock) => {
      if (!lock) return;
      ran = true;
      await work();
    });
    return ran;
  };
}

/** The same Web Lock, waited for (Discard waits for another window's send to end). */
export function webLockWait(name: string): (work: () => Promise<void>) => Promise<void> {
  return async (work) => {
    const locks = (globalThis.navigator as Navigator | undefined)?.locks;
    if (!locks) return work();
    await locks.request(name, async () => {
      await work();
    });
  };
}

export class FeedbackOutbox {
  /** Codes whose waiting entries the next send takes at once (`flushWaiting`). */
  private readonly dueCodes = new Set<string>();
  private list: OutboxEntry[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly sentListeners = new Set<(entry: OutboxEntry, issue: FiledIssue) => void>();
  private flushing: Promise<void> | null = null;
  private again = false;
  private cancelTimer: (() => void) | null = null;
  /** The last attempt of each entry tried in this window, for `enqueue`'s answer. */
  private readonly attempts = new Map<string, Attempt>();
  private readonly now: () => number;
  private readonly exclusive: (work: () => Promise<void>) => Promise<boolean>;
  private readonly exclusiveWait: (work: () => Promise<void>) => Promise<void>;
  /** Entries discarded in this window: a send already under way never writes them back. */
  private readonly discarded = new Set<string>();
  /** Whether the last flush found another window holding the lock. */
  private elsewhere = false;
  private readonly schedule: (run: () => void, ms: number) => () => void;

  constructor(private readonly options: OutboxOptions) {
    this.now = options.now ?? Date.now;
    this.exclusive =
      options.exclusive ??
      (async (work) => {
        await work();
        return true;
      });
    this.exclusiveWait = options.exclusiveWait ?? ((work) => work());
    this.schedule =
      options.schedule ??
      ((run, ms) => {
        const timer = setTimeout(run, ms);
        return () => clearTimeout(timer);
      });
  }

  /** The entries, oldest first (a new array when they change). */
  entries = (): readonly OutboxEntry[] => this.list;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  onSent(listener: (entry: OutboxEntry, issue: FiledIssue) => void): () => void {
    this.sentListeners.add(listener);
    return () => this.sentListeners.delete(listener);
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }

  /** Reads what waits from the store; then sends what is due. */
  async start(): Promise<void> {
    await this.reload();
    void this.flush();
  }

  private async reload(): Promise<void> {
    const stored = await this.options.store.listOutbox();
    // An entry left `sending` by a window that went away is queued again.
    this.list = stored.map((entry) =>
      entry.state === 'sending' ? { ...entry, state: 'queued' as const } : entry,
    );
    this.changed();
  }

  /**
   * Adds a submission and tries it now when online. Answers what happened to it: sent, queued
   * (offline, or a failure that may pass) or failed (kept with its error).
   */
  async enqueue(entry: OutboxEntry): Promise<Attempt> {
    // An entry discarded for Edit comes back with the same submissionId.
    this.discarded.delete(entry.id);
    this.attempts.delete(entry.id);
    await this.options.store.putOutbox(entry);
    this.list = [...this.list.filter((item) => item.id !== entry.id), entry];
    this.changed();
    await this.flush();
    return this.attemptOf(entry.id);
  }

  private attemptOf(id: string): Attempt {
    const tried = this.attempts.get(id);
    if (tried) return tried;
    return this.elsewhere && this.options.online()
      ? { kind: 'elsewhere' }
      : { kind: 'queued', error: null };
  }

  /** Puts a failed entry back in the queue and tries it now. */
  async retry(id: string): Promise<Attempt> {
    const entry = this.list.find((item) => item.id === id);
    if (!entry) return { kind: 'queued', error: null };
    this.attempts.delete(id);
    await this.write({ ...entry, state: 'queued', nextAt: this.now(), error: null });
    await this.flush();
    return this.attemptOf(id);
  }

  /**
   * Removes an entry for good: after this window's send of it (if any) and, through the lock,
   * any other window's, so a send that then fails cannot write it back. Answers the entry as it
   * was. With `keep` (Edit), the stored entry is first handed to it under the lock and removed
   * only once `keep` has finished; when the entry was sent or removed meanwhile, `keep` is not
   * called and the answer is null. If `keep` fails, the entry stays.
   */
  async discard(
    id: string,
    keep?: (entry: OutboxEntry) => Promise<void>,
  ): Promise<OutboxEntry | null> {
    this.discarded.add(id);
    // As it is now: the send under way may remove it before the lock is ours.
    let removed: OutboxEntry | null = this.list.find((item) => item.id === id) ?? null;
    try {
      await this.flushing;
    } catch {
      // A failed flush still leaves the entry to remove.
    }
    try {
      await this.exclusiveWait(async () => {
        const stored = (await this.options.store.listOutbox()).find((item) => item.id === id);
        if (keep) {
          removed = stored ?? null;
          if (!stored) return;
          await keep(stored);
        } else {
          removed = stored ?? removed;
        }
        await this.options.store.deleteOutbox(id);
      });
    } catch (error) {
      this.discarded.delete(id);
      throw error;
    }
    this.list = this.list.filter((item) => item.id !== id);
    this.changed();
    return removed;
  }

  private async write(entry: OutboxEntry): Promise<void> {
    await this.options.store.putOutbox(entry);
    this.list = this.list.map((item) => (item.id === entry.id ? entry : item));
    this.changed();
  }

  /**
   * Sends now what waited for `code`, whatever its backoff: entries that waited for a GitHub
   * token, once one is saved (T57, A1012). Other windows' entries too (the send reloads them).
   */
  flushWaiting(code: string): Promise<void> {
    this.dueCodes.add(code);
    return this.flush();
  }

  /** Sends every due entry, oldest first; another call while one runs runs once more after. */
  flush(): Promise<void> {
    if (this.flushing) {
      this.again = true;
      return this.flushing;
    }
    this.flushing = (async () => {
      try {
        do {
          this.again = false;
          this.elsewhere = !(await this.exclusive(() => this.sendDue()));
        } while (this.again);
      } finally {
        this.flushing = null;
        this.plan();
      }
    })();
    return this.flushing;
  }

  private async sendDue(): Promise<void> {
    // Another window may have sent or added entries since this one last looked.
    await this.reload();
    const codes = new Set(this.dueCodes);
    this.dueCodes.clear();
    for (const entry of this.list) {
      const waited = entry.error !== null && codes.has(entry.error.code);
      if (entry.state !== 'queued' || (entry.nextAt > this.now() && !waited)) continue;
      if (this.discarded.has(entry.id)) continue;
      if (!this.options.online()) return;
      await this.write({ ...entry, state: 'sending' });
      let result: SendResult;
      try {
        result = await this.options.send(entry);
      } catch (error) {
        result = {
          ok: false,
          retryable: true,
          error: {
            status: 0,
            code: 'network',
            message: error instanceof Error ? error.message : 'Could not reach Penmoss',
          },
        };
      }
      if (result.ok) {
        await this.options.store.deleteOutbox(entry.id);
        this.list = this.list.filter((item) => item.id !== entry.id);
        this.attempts.set(entry.id, { kind: 'sent', issue: result.issue });
        this.changed();
        for (const listener of this.sentListeners) listener(entry, result.issue);
        continue;
      }
      const attempts = entry.attempts + 1;
      // Discarded while it was being sent: it stays gone.
      if (this.discarded.has(entry.id)) {
        await this.options.store.deleteOutbox(entry.id);
        this.list = this.list.filter((item) => item.id !== entry.id);
        this.changed();
        continue;
      }
      if (result.retryable) {
        await this.write({
          ...entry,
          state: 'queued',
          attempts,
          nextAt: this.now() + backoff(attempts, result.retryAfterMs),
          error: result.error,
        });
        this.attempts.set(entry.id, { kind: 'queued', error: result.error });
        // Offline or signed out: the rest would fail alike.
        if (result.error.status === 0) return;
      } else {
        await this.write({ ...entry, state: 'failed', attempts, error: result.error });
        this.attempts.set(entry.id, { kind: 'failed', error: result.error });
      }
    }
  }

  /** A timer for the next entry that is due. */
  private plan(): void {
    this.cancelTimer?.();
    this.cancelTimer = null;
    const due = this.list
      .filter((entry) => entry.state === 'queued')
      .map((entry) => entry.nextAt)
      .sort((a, b) => a - b)[0];
    if (due === undefined) return;
    this.cancelTimer = this.schedule(() => void this.flush(), Math.max(1000, due - this.now()));
  }

  stop(): void {
    this.cancelTimer?.();
    this.cancelTimer = null;
  }
}
