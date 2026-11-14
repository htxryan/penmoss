/**
 * The indexing lease's takeover (A1157, A1350), with a fake clock and fake pids over the real lock
 * file: a stale heartbeat or a dead holder is taken over, the app's service takes the lease from a
 * live agent's `penmoss mcp`, and a process that lost the race at its start takes the lease once
 * the holder is gone (the bug on Ryan's Mac: nobody indexed for two hours).
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LeaseKeeper } from '@penmoss/core/search';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Lease, leaseHolder, leasePath, outranks, type LeaseOptions } from '../src/lease';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'penmoss-lease-'));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

/** This Mac as the tests see it: a clock that can be moved on, and the pids that run. */
function fakeMac() {
  const mac = { offsetMs: 0, running: new Set<number>() };
  const options = (pid: number, more: LeaseOptions = {}): LeaseOptions => ({
    pid,
    now: () => Date.now() + mac.offsetMs,
    alive: (other) => mac.running.has(other),
    // No heartbeat during a test: the fake clock decides how old the file is.
    heartbeatMs: 60 * 60_000,
    ...more,
  });
  return { mac, options };
}

const APP = 101;
const MCP = 202;
const CLI = 303;

describe('the lease takes over (A1157, A1350)', () => {
  it('a stale heartbeat, but not a fresh one, even when its pid still runs', async () => {
    const { mac, options } = fakeMac();
    mac.running.add(APP).add(MCP);
    const app = await Lease.acquire(home, 'app', options(APP));
    expect(app).toBeDefined();
    mac.offsetMs = 29_000;
    expect(await Lease.acquire(home, 'mcp', options(MCP))).toBeUndefined();
    // Hung for longer than staleMs: taken over, and the old holder learns it lost it.
    mac.offsetMs = 31_000;
    const mcp = await Lease.acquire(home, 'mcp', options(MCP));
    expect(mcp?.holder).toMatchObject({ writer: 'mcp', pid: MCP });
    expect(await app!.held()).toBe(false);
    await mcp!.release();
  });

  it('a fresh lease whose process is gone, at once', async () => {
    const { mac, options } = fakeMac();
    mac.running.add(MCP);
    await Lease.acquire(home, 'app', options(APP)).then((lease) => lease?.release());
    await writeFile(leasePath(home), JSON.stringify({ writer: 'app', pid: APP, token: 'old' }));
    const mcp = await Lease.acquire(home, 'mcp', options(MCP));
    expect(mcp?.holder.pid).toBe(MCP);
    await mcp!.release();
  });

  it('from a live agent’s penmoss, when the app’s service asks', async () => {
    const { mac, options } = fakeMac();
    mac.running.add(APP).add(MCP).add(CLI);
    let lost = false;
    const mcp = await Lease.acquire(home, 'mcp', options(MCP, { onLost: () => (lost = true) }));
    expect(mcp).toBeDefined();
    // Neither another agent nor a one-shot search takes it from a live holder.
    expect(await Lease.acquire(home, 'mcp', options(CLI))).toBeUndefined();
    expect(await Lease.acquire(home, 'cli', options(CLI))).toBeUndefined();
    const app = await Lease.acquire(home, 'app', options(APP));
    expect(app?.holder).toMatchObject({ writer: 'app', pid: APP });
    expect(await mcp!.held()).toBe(false);
    expect(lost).toBe(true);
    // The agent's server cannot take it back while the app runs.
    expect(await Lease.acquire(home, 'mcp', options(MCP))).toBeUndefined();
    // A second app (a dev build beside the installed one) waits its turn.
    expect(await Lease.acquire(home, 'app', options(CLI))).toBeUndefined();
    expect((await leaseHolder(home))?.writer).toBe('app');
    await mcp!.release();
    expect((await leaseHolder(home))?.writer).toBe('app');
    await app!.release();
  });

  it('ranks the app above every other writer, and no one above the app', () => {
    expect(outranks('app', 'mcp')).toBe(true);
    expect(outranks('app', 'cli')).toBe(true);
    expect(outranks('app', '')).toBe(true);
    expect(outranks('app', 'app')).toBe(false);
    expect(outranks('mcp', 'app')).toBe(false);
    expect(outranks('mcp', 'cli')).toBe(false);
    expect(outranks('cli', 'mcp')).toBe(false);
  });
});

describe('a process that lost the race keeps trying (A1350)', () => {
  it('takes the lease once the app that held it dies, as Ryan’s Mac needed', async () => {
    const { mac, options } = fakeMac();
    mac.running.add(APP).add(MCP);
    const app = await Lease.acquire(home, 'app', options(APP));
    expect(app).toBeDefined();
    // `penmoss mcp` opens while the app indexes: it loses the race, then keeps trying.
    const changes: boolean[] = [];
    const keeper = new LeaseKeeper(() => Lease.acquire(home, 'mcp', options(MCP)), {
      retryMs: 20,
      onChange: (held) => changes.push(held),
    });
    expect(await keeper.start()).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(keeper.held).toBe(false);
    // The app quits without letting go (killed); the file names its dead pid.
    mac.running.delete(APP);
    await vi.waitFor(() => expect(keeper.held).toBe(true), { timeout: 2_000, interval: 10 });
    expect(await leaseHolder(home)).toMatchObject({ writer: 'mcp', pid: MCP });
    expect(changes).toEqual([true]);
    // The app starts again and reclaims indexing; the agent's server hears it lost the lease.
    mac.running.add(APP);
    const again = await Lease.acquire(home, 'app', options(APP));
    expect(again).toBeDefined();
    await vi.waitFor(() => expect(keeper.held).toBe(false), { timeout: 2_000, interval: 10 });
    expect(changes).toEqual([true, false]);
    await keeper.stop();
    expect((await leaseHolder(home))?.writer).toBe('app');
    await again!.release();
  });

  it('takes a lease whose heartbeat stopped hours ago', async () => {
    const { mac, options } = fakeMac();
    mac.running.add(APP).add(MCP);
    await Lease.acquire(home, 'app', options(APP));
    const keeper = new LeaseKeeper(() => Lease.acquire(home, 'mcp', options(MCP)), {
      retryMs: 20,
    });
    expect(await keeper.start()).toBe(false);
    // The app hung (its pid is still there) and its heartbeat is two hours old.
    mac.offsetMs = 2 * 60 * 60_000;
    await vi.waitFor(() => expect(keeper.held).toBe(true), { timeout: 2_000, interval: 10 });
    await keeper.stop();
  });
});

describe('a stale takeover moves aside only the lease it judged stale (A1373)', () => {
  const HOUR_AGO = new Date(Date.now() - 60 * 60_000);

  /** A lease file named `token`, its heartbeat at `at`. */
  function writeLease(token: string, pid: number, at: Date) {
    writeFileSync(leasePath(home), JSON.stringify({ writer: 'mcp', pid, token }));
    utimesSync(leasePath(home), at, at);
  }

  it('keeps a fresh lease another taker wrote after this one judged the old one stale', async () => {
    const { mac, options } = fakeMac();
    mac.running.add(MCP).add(CLI);
    await Lease.acquire(home, 'mcp', options(MCP)).then((lease) => lease?.release());
    writeLease('stale', APP, HOUR_AGO);
    // The other taker wins the race at the worst moment: just after this one read the stale lease
    // and judged it by the clock, before it moved it aside.
    let raced = false;
    const taker = await Lease.acquire(
      home,
      'mcp',
      options(CLI, {
        now: () => {
          if (!raced) {
            raced = true;
            writeLease('winner', MCP, new Date());
          }
          return Date.now();
        },
      }),
    );
    expect(taker).toBeUndefined();
    expect(JSON.parse(readFileSync(leasePath(home), 'utf8'))).toMatchObject({ token: 'winner' });
  });

  it('gives a stale lease to exactly one of several takers racing for it', async () => {
    const { mac, options } = fakeMac();
    const pids = [401, 402, 403, 404, 405, 406];
    for (const pid of pids) mac.running.add(pid);
    mkdirSync(join(home, 'vectors'), { recursive: true });
    for (let round = 0; round < 25; round++) {
      writeLease(`stale-${round}`, APP, HOUR_AGO);
      const leases = await Promise.all(pids.map((pid) => Lease.acquire(home, 'mcp', options(pid))));
      const won = leases.filter((lease) => lease !== undefined);
      expect(won).toHaveLength(1);
      // The winner still holds it: no loser moved its fresh lease aside.
      expect(await won[0]!.held()).toBe(true);
      expect((await leaseHolder(home))?.token).toBe(won[0]!.holder.token);
      await won[0]!.release();
    }
    expect(existsSync(`${leasePath(home)}.takeover`)).toBe(false);
  });

  it('clears a takeover lock left by a taker that died mid-takeover', async () => {
    const { mac, options } = fakeMac();
    mac.running.add(MCP);
    await Lease.acquire(home, 'mcp', options(MCP)).then((lease) => lease?.release());
    writeLease('stale', APP, HOUR_AGO);
    const lock = `${leasePath(home)}.takeover`;
    writeFileSync(lock, JSON.stringify({ writer: 'mcp', pid: CLI, token: 'crashed' }));
    utimesSync(lock, HOUR_AGO, HOUR_AGO);
    const lease = await Lease.acquire(home, 'mcp', options(MCP));
    expect(lease?.holder.pid).toBe(MCP);
    expect(existsSync(lock)).toBe(false);
    await lease!.release();
  });
});
