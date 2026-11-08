/**
 * One engine per clone (A839): the lock the CLI and the local MCP share. A dead holder's lock is
 * taken over, by one waiter at a time; a live one, or one on another machine, is waited for and
 * then refused with who holds it and where the lock file is (#165).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bootId, LockHeldError, lockNotebook, machineId } from '../src/node/lock';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'penmoss-lock-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A process id that ran and is gone. */
function deadPid(): number {
  const done = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], {
    encoding: 'utf8',
  });
  return Number(done.stdout.trim());
}

function holder(fields: Record<string, unknown>): void {
  writeFileSync(
    join(dir, 'lock'),
    `${JSON.stringify({ what: 'penmoss mcp', since: Date.now(), ...fields })}\n`,
  );
}

describe('lockNotebook', () => {
  it('names this machine by a stable id, not its host name', () => {
    expect(machineId()).toBe(machineId());
    if (process.platform === 'linux' && existsSync('/etc/machine-id')) {
      expect(machineId()).toBe(readFileSync('/etc/machine-id', 'utf8').trim());
    }
    expect(bootId()).toBe(bootId());
    if (process.platform === 'linux') {
      expect(bootId()).toBe(
        `linux:${readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()}`,
      );
    }
  });

  it('takes over a lock whose holder died, and one from before a reboot', async () => {
    holder({ pid: deadPid(), host: 'renamed-by-a-vpn', machine: machineId(), boot: bootId() });
    const first = await lockNotebook(dir, 'penmoss sync', { waitMs: 500 });
    await first.release();
    // Alive, but that process ran before this machine last booted: the pid is someone else's.
    const kind = bootId().split(':')[0]!;
    holder({ pid: process.pid, host: hostname(), machine: machineId(), boot: `${kind}:before` });
    const second = await lockNotebook(dir, 'penmoss sync', { waitMs: 500 });
    await second.release();
    // A lock written before machine ids: judged by host name.
    holder({ pid: deadPid(), host: hostname() });
    const third = await lockNotebook(dir, 'penmoss sync', { waitMs: 500 });
    await third.release();
    expect(existsSync(join(dir, 'lock'))).toBe(false);
  });

  it("waits for a live holder, never takes another machine's, and names the lock file", async () => {
    holder({ pid: process.pid, host: hostname(), machine: machineId(), boot: bootId() });
    const live = await lockNotebook(dir, 'x', { waitMs: 150 }).catch((e: unknown) => e);
    expect(live).toBeInstanceOf(LockHeldError);
    expect((live as Error).message).toContain('in use by penmoss mcp');
    expect((live as Error).message).toContain(join(dir, 'lock'));

    // A boot id worked out from the clock differs after a clock jump (a VM resumed): alone it
    // never breaks a live holder's lock.
    holder({ pid: process.pid, host: hostname(), machine: machineId(), boot: 'uptime:12345' });
    const jumped = await lockNotebook(dir, 'x', { waitMs: 150 }).catch((e: unknown) => e);
    expect(jumped).toBeInstanceOf(LockHeldError);

    holder({ pid: deadPid(), host: 'elsewhere', machine: 'another-machine', boot: 'linux:x' });
    const remote = await lockNotebook(dir, 'x', { waitMs: 150 }).catch((e: unknown) => e);
    expect(remote).toBeInstanceOf(LockHeldError);
    expect((remote as Error).message).toContain('on elsewhere');
    expect(existsSync(join(dir, 'lock'))).toBe(true);
  });

  it('lets exactly one of many waiters take over a dead lock at a time', async () => {
    holder({ pid: deadPid(), host: hostname(), machine: machineId(), boot: bootId() });
    let inside = 0;
    let most = 0;
    let done = 0;
    await Promise.all(
      Array.from({ length: 12 }, async (_, i) => {
        const lock = await lockNotebook(dir, `waiter ${i}`, { waitMs: 20_000, pollMs: 5 });
        inside++;
        most = Math.max(most, inside);
        await new Promise((resolve) => setTimeout(resolve, 15));
        inside--;
        done++;
        await lock.release();
      }),
    );
    expect(done).toBe(12);
    expect(most).toBe(1);
    expect(existsSync(join(dir, 'lock'))).toBe(false);
    expect(existsSync(join(dir, 'lock.takeover'))).toBe(false);
  });

  it('a release never removes a lock someone else holds now', async () => {
    const mine = await lockNotebook(dir, 'a', { waitMs: 100 });
    // Taken over meanwhile (this holder was judged dead): the release leaves the new one alone.
    holder({ pid: process.pid, host: hostname(), machine: machineId(), boot: bootId() });
    await mine.release();
    expect(JSON.parse(readFileSync(join(dir, 'lock'), 'utf8'))).toMatchObject({
      what: 'penmoss mcp',
    });
  });
});
