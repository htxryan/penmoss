/**
 * One engine per clone (A839): a lock file the CLI and the local MCP share. It is created with
 * O_EXCL and names its holder: a random token, the process id, this machine's id and boot time.
 * A lock is waited for briefly, then refused with who holds it, so two engines never write the
 * same writer's files from one clone.
 *
 * A lock whose process is gone is taken over, safely when several wait at once (A847 makes that
 * likely: a detached sync waits while the server it replaces exits):
 *
 * - "Gone" needs the same machine (its machine id, not its host name, which a VPN changes on a
 *   Mac) and the process missing, or a reboot since (another boot id: the pid may be reused).
 *   The boot id is the kernel's (`/proc/sys/kernel/random/boot_id`, the Mac's `kern.boottime`),
 *   never one worked out from the clock, so a clock jump (a VM resumed) never breaks a live lock;
 *   where there is none, a reboot also needs the process gone.
 * - The takeover itself runs under a second O_EXCL file, `<lock>.takeover`, and checks again,
 *   by inode and content, that the lock is still the dead one before removing it. So a waiter
 *   never removes a lock another waiter just took. A takeover file older than a minute is from a
 *   process that died during one, and is cleared the same careful way.
 * - The new lock is still made with O_EXCL, and read back before it counts.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { open, readFile, rm, stat } from 'node:fs/promises';
import { hostname, uptime } from 'node:os';
import { join } from 'node:path';

export interface LockHolder {
  readonly pid: number;
  readonly host: string;
  /** This machine's id (`/etc/machine-id`, the Mac's hardware UUID; else the host name). */
  readonly machine?: string;
  /** This boot of the machine (`linux:<boot_id>`, `darwin:<boottime>`, else `uptime:<s>`). */
  readonly boot?: string;
  /** What holds it: `penmoss mcp`, `penmoss sync`, … */
  readonly what: string;
  /** Epoch ms. */
  readonly since: number;
  readonly token?: string;
}

export class LockHeldError extends Error {
  constructor(
    readonly path: string,
    readonly holder: LockHolder | null,
  ) {
    super(
      holder
        ? `This notebook is in use by ${holder.what} (process ${holder.pid}${holder.machine === machineId() ? '' : ` on ${holder.host}`}, since ${new Date(holder.since).toISOString()}). Try again when it finishes. If no penmoss is running, remove the lock file: ${path}`
        : `This notebook is in use by another penmoss process. If none is running, remove the lock file: ${path}`,
    );
    this.name = 'LockHeldError';
  }
}

export interface NotebookLock {
  readonly path: string;
  release(): Promise<void>;
}

let machine: string | null = null;

/** A stable id for this machine: unlike the host name, a VPN or a network change keeps it. */
export function machineId(): string {
  if (machine !== null) return machine;
  const read = (path: string) => {
    try {
      return readFileSync(path, 'utf8').trim();
    } catch {
      return '';
    }
  };
  let id = '';
  if (process.platform === 'linux')
    id = read('/etc/machine-id') || read('/var/lib/dbus/machine-id');
  if (!id && process.platform === 'darwin') {
    try {
      const out = execFileSync('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], {
        encoding: 'utf8',
        timeout: 5_000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      id = /"IOPlatformUUID" = "([^"]+)"/.exec(out)?.[1] ?? '';
    } catch {
      id = '';
    }
  }
  machine = id || `host:${hostname()}`;
  return machine;
}

let boot: string | null = null;

/** This boot of this machine, as the kernel names it: another value means a reboot since. */
export function bootId(): string {
  if (boot !== null) return boot;
  let id = '';
  if (process.platform === 'linux') {
    try {
      id = `linux:${readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()}`;
    } catch {
      id = '';
    }
  }
  if (!id && process.platform === 'darwin') {
    try {
      const out = execFileSync('/usr/sbin/sysctl', ['-n', 'kern.boottime'], {
        encoding: 'utf8',
        timeout: 5_000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const sec = /sec = (\d+)/.exec(out)?.[1];
      id = sec ? `darwin:${sec}` : '';
    } catch {
      id = '';
    }
  }
  // From the clock: only a hint, never enough alone (see dead()).
  boot = id || `uptime:${Math.round((Date.now() / 1000 - uptime()) / 60) * 60}`;
  return boot;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The holder, and what identifies this very file (its inode and bytes). */
async function inspect(
  path: string,
): Promise<{ holder: LockHolder | null; ino: number; text: string } | null> {
  try {
    const [info, text] = await Promise.all([stat(path), readFile(path, 'utf8')]);
    let holder: LockHolder | null = null;
    try {
      holder = JSON.parse(text) as LockHolder;
    } catch {
      holder = null;
    }
    return { holder, ino: info.ino, text };
  } catch {
    return null;
  }
}

/** Whether `holder` is a process on this machine that no longer runs. */
function dead(holder: LockHolder | null, since: number, now: number): boolean {
  if (!holder) {
    // Unreadable: a holder that died while writing it, if it has been like that a while.
    return now - since > 60_000;
  }
  const sameMachine = holder.machine ? holder.machine === machineId() : holder.host === hostname();
  if (!sameMachine) return false;
  const ours = bootId();
  const theirs = typeof holder.boot === 'string' ? holder.boot : null;
  // Another boot by the kernel's own id: the pid is from before it, whoever has it now.
  if (theirs && theirs !== ours && !theirs.startsWith('uptime:') && !ours.startsWith('uptime:')) {
    return true;
  }
  return !alive(holder.pid);
}

async function create(path: string, text: string): Promise<boolean> {
  try {
    const handle = await open(path, 'wx', 0o600);
    try {
      await handle.writeFile(text);
    } finally {
      await handle.close();
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
}

/** Removes `path` only while it is still exactly what `seen` was (same inode, same bytes). */
async function removeIfSame(path: string, seen: { ino: number; text: string }): Promise<boolean> {
  const now = await inspect(path);
  if (!now || now.ino !== seen.ino || now.text !== seen.text) return false;
  await rm(path, { force: true });
  return true;
}

/** Takes a dead holder's lock away, one waiter at a time. */
async function takeOver(path: string, seen: { ino: number; text: string }): Promise<void> {
  const guard = `${path}.takeover`;
  const mine = `${JSON.stringify({ pid: process.pid, token: randomUUID(), since: Date.now() })}\n`;
  if (!(await create(guard, mine))) {
    const other = await inspect(guard);
    const at = other ? (await stat(guard).catch(() => null))?.mtimeMs : undefined;
    // A takeover takes milliseconds: one a minute old was left by a process that died in it.
    if (other && at !== undefined && Date.now() - at > 60_000) await removeIfSame(guard, other);
    return;
  }
  try {
    await removeIfSame(path, seen);
  } finally {
    const held = await inspect(guard);
    if (held?.text === mine) await rm(guard, { force: true });
  }
}

/**
 * Takes `<dir>/<file>` (default `lock`), waiting up to `waitMs` for another holder to finish.
 */
export async function lockNotebook(
  dir: string,
  what: string,
  options: { readonly waitMs?: number; readonly pollMs?: number; readonly file?: string } = {},
): Promise<NotebookLock> {
  const path = join(dir, options.file ?? 'lock');
  const deadline = Date.now() + (options.waitMs ?? 10_000);
  const me: LockHolder = {
    pid: process.pid,
    host: hostname(),
    machine: machineId(),
    boot: bootId(),
    what,
    since: Date.now(),
    token: randomUUID(),
  };
  const text = `${JSON.stringify(me)}\n`;
  /** When this waiter first saw the current (unreadable) lock. */
  let firstSeen = new Map<number, number>();
  for (;;) {
    if (await create(path, text)) {
      // Read back: the lock counts only if it is this one.
      const now = await inspect(path);
      if (now?.text === text) {
        let released = false;
        return {
          path,
          async release() {
            if (released) return;
            released = true;
            const held = await inspect(path);
            if (held?.text === text) await rm(path, { force: true });
          },
        };
      }
      continue;
    }
    const seen = await inspect(path);
    if (seen) {
      const since = firstSeen.get(seen.ino) ?? Date.now();
      firstSeen = new Map([[seen.ino, since]]);
      if (dead(seen.holder, since, Date.now())) {
        await takeOver(path, seen);
        continue;
      }
    }
    if (Date.now() >= deadline) throw new LockHeldError(path, seen?.holder ?? null);
    await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 100));
  }
}
