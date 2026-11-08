/**
 * Main asking a window to store (A724, #170 F8, #174 review): each ask has its own id and its
 * waiter takes only the reply with that id, so a quick store-only `flush` (the capture window
 * showing) never ends a `close` that is still pushing. On the page's side a flush waits for a
 * close already running, so what it stores is after the close's.
 *
 * Plain data both ways: main and the preload share it, with no Electron in it.
 */

export type StoreReason = 'close' | 'flush';

export interface StoreRequest {
  readonly id: number;
  readonly reason: StoreReason;
}

export interface StoreReply {
  readonly id: number;
  readonly ok: boolean;
}

const isId = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

/** A reply from a page, or null for anything else. */
export function storeReply(value: unknown): StoreReply | null {
  if (typeof value !== 'object' || value === null) return null;
  const { id, ok } = value as { id?: unknown; ok?: unknown };
  return isId(id) ? { id, ok: ok === true } : null;
}

/** A request as the page receives it, or null for anything else. */
export function storeRequest(value: unknown): StoreRequest | null {
  if (typeof value !== 'object' || value === null) return null;
  const { id, reason } = value as { id?: unknown; reason?: unknown };
  if (!isId(id)) return null;
  return { id, reason: reason === 'close' ? 'close' : 'flush' };
}

/** Main's side: a new id for each ask. */
export class StoreRequests {
  private next = 1;

  make(reason: StoreReason): StoreRequest {
    return { id: this.next++, reason };
  }

  /** Whether `reply` answers `request` (and no other). */
  static answers(request: StoreRequest, reply: StoreReply | null): boolean {
    return reply !== null && reply.id === request.id;
  }
}

/** The page's side: runs each store, a flush after any close already running. */
export class StoreAnswers {
  private closing: Promise<void> | null = null;

  constructor(private readonly save: (reason: StoreReason) => Promise<void>) {}

  /** Stores as asked; resolves with the reply to send, or null for a request that is not one. */
  async answer(value: unknown): Promise<StoreReply | null> {
    const request = storeRequest(value);
    if (!request) return null;
    const before = this.closing;
    const run = (async () => {
      // A flush (or a second close) after the close running now: never answered before it.
      if (before) await before;
      await this.save(request.reason);
    })();
    if (request.reason === 'close') {
      const tracked = run
        .catch(() => undefined)
        .finally(() => {
          if (this.closing === tracked) this.closing = null;
        });
      this.closing = tracked;
    }
    return run.then(
      () => ({ id: request.id, ok: true }),
      () => ({ id: request.id, ok: false }),
    );
  }
}
