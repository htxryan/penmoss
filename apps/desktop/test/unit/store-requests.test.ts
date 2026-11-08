import { describe, expect, it } from 'vitest';
import { StoreAnswers, StoreRequests, storeReply } from '../../src/store-requests';

/** A promise and its resolve, to hold a store open. */
function held() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('asking a window to store (#174 delta review, F8)', () => {
  it('a waiter takes only the reply to its own request', () => {
    const requests = new StoreRequests();
    const close = requests.make('close');
    const flush = requests.make('flush');
    expect(close.id).not.toBe(flush.id);
    expect(close.reason).toBe('close');
    // The flush's quick answer never ends the close still running.
    const quick = storeReply({ id: flush.id, ok: true });
    expect(quick).toEqual({ id: flush.id, ok: true });
    expect(StoreRequests.answers(close, quick)).toBe(false);
    expect(StoreRequests.answers(flush, quick)).toBe(true);
    // A bare `true` (the old reply, or a page's own) answers nothing.
    expect(storeReply(true)).toBeNull();
    expect(StoreRequests.answers(close, storeReply(true))).toBe(false);
    expect(storeReply({ id: 'x', ok: true })).toBeNull();
  });

  it('a flush waits for a close already running, and each request gets its own reply', async () => {
    const order: string[] = [];
    const closing = held();
    const answers = new StoreAnswers(async (reason) => {
      order.push(`${reason} start`);
      if (reason === 'close') await closing.promise;
      order.push(`${reason} end`);
    });
    const replies: Array<{ id: number; ok: boolean }> = [];
    const close = answers.answer({ id: 1, reason: 'close' }).then((reply) => replies.push(reply!));
    // ⌘Q while a push runs, then the capture hotkey: its flush must not answer first.
    const flush = answers.answer({ id: 2, reason: 'flush' }).then((reply) => replies.push(reply!));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(order).toEqual(['close start']);
    expect(replies).toEqual([]);
    closing.resolve();
    await Promise.all([close, flush]);
    expect(order).toEqual(['close start', 'close end', 'flush start', 'flush end']);
    expect(replies).toEqual([
      { id: 1, ok: true },
      { id: 2, ok: true },
    ]);
  });

  it('a flush with no close running stores at once; a failed store says so; junk is ignored', async () => {
    const seen: string[] = [];
    const answers = new StoreAnswers((reason) => {
      seen.push(reason);
      return reason === 'close' ? Promise.reject(new Error('disk full')) : Promise.resolve();
    });
    expect(await answers.answer({ id: 7, reason: 'flush' })).toEqual({ id: 7, ok: true });
    expect(await answers.answer({ id: 8, reason: 'close' })).toEqual({ id: 8, ok: false });
    // After a failed close, a flush still runs.
    expect(await answers.answer({ id: 9, reason: 'flush' })).toEqual({ id: 9, ok: true });
    expect(await answers.answer('close')).toBeNull();
    expect(await answers.answer({ id: -1, reason: 'close' })).toBeNull();
    expect(seen).toEqual(['flush', 'close', 'flush']);
  });
});
