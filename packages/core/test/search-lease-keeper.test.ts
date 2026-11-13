/**
 * The indexing lease's keeper (A1157, A1350): a process that lost the race keeps trying, so a
 * holder that dies or quits is replaced, and a holder that loses the lease hears of it. Fake timers
 * and a fake lease; the file lease itself is tested in `@penmoss/embed`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LeaseKeeper, type HeldLease } from '../src/search';

/** The lease file as these tests control it: free, or held by someone else. */
function fakeLeases() {
  const control = { free: false, takes: 0, released: 0, current: null as { held: boolean } | null };
  const take = (): Promise<HeldLease | undefined> => {
    control.takes++;
    if (!control.free) return Promise.resolve(undefined);
    control.free = false;
    const mine = { held: true };
    control.current = mine;
    return Promise.resolve({
      held: () => Promise.resolve(mine.held),
      release: () => {
        control.released++;
        mine.held = false;
        control.free = true;
        return Promise.resolve();
      },
    });
  };
  return { control, take };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('LeaseKeeper (A1350)', () => {
  it('keeps trying while another process holds the lease, and takes it once that one is gone', async () => {
    const { control, take } = fakeLeases();
    const changes: boolean[] = [];
    const keeper = new LeaseKeeper(take, {
      retryMs: 30_000,
      onChange: (held) => changes.push(held),
    });
    expect(await keeper.start()).toBe(false);
    expect(keeper.held).toBe(false);
    await vi.advanceTimersByTimeAsync(90_000);
    // One try at the start, then one every 30 s: it never gives up.
    expect(control.takes).toBe(4);
    expect(keeper.held).toBe(false);
    // The holder died (its heartbeat went stale, or its pid is gone): the next try takes it.
    control.free = true;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(keeper.held).toBe(true);
    expect(changes).toEqual([true]);
    await keeper.stop();
    expect(control.released).toBe(1);
  });

  it('notices it lost the lease, says so, and tries for it again', async () => {
    const { control, take } = fakeLeases();
    control.free = true;
    const changes: boolean[] = [];
    const keeper = new LeaseKeeper(take, {
      retryMs: 1_000,
      onChange: (held) => changes.push(held),
    });
    expect(await keeper.start()).toBe(true);
    // The app's service took it over (A1350).
    control.current!.held = false;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(keeper.held).toBe(false);
    expect(changes).toEqual([true, false]);
    // The app quit: the lease is free again, and the keeper takes it back.
    control.free = true;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(keeper.held).toBe(true);
    expect(changes).toEqual([true, false, true]);
    await keeper.stop();
  });

  it('stops trying once stopped, and lets go of a lease that arrives after', async () => {
    const { control, take } = fakeLeases();
    const keeper = new LeaseKeeper(take, { retryMs: 1_000 });
    await keeper.start();
    await keeper.stop();
    control.free = true;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(control.takes).toBe(1);
    expect(keeper.held).toBe(false);
  });

  it('shares one round between overlapping checks, and survives a failing try', async () => {
    let takes = 0;
    const logged: string[] = [];
    const keeper = new LeaseKeeper(
      () => {
        takes++;
        return Promise.reject(new Error('EACCES'));
      },
      { retryMs: 1_000, log: (text) => logged.push(text) },
    );
    await Promise.all([keeper.check(), keeper.check(), keeper.check()]);
    expect(takes).toBe(1);
    expect(logged).toEqual(['could not take the indexing lease: EACCES']);
    await keeper.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(takes).toBe(3);
    await keeper.stop();
  });
});
