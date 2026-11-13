/**
 * One indexer per Mac (A1157): `~/.penmoss/vectors/indexer.lease`, a lock file naming its holder
 * and kept fresh by a heartbeat. The holder embeds notes and compacts the cache; everyone else
 * reads vectors and embeds only queries. A lease whose heartbeat stopped (its process died or
 * hung) is taken over, and so is a fresh one whose process is gone. The app's service, which sees
 * every open notebook, also takes the lease from a live `penmoss mcp` or `penmoss search`, which
 * index only their own notebook (A1350). A holder that finds the file no longer names it has
 * lost the lease and says so through `onLost`.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, unlink, utimes } from 'node:fs/promises';
import { join } from 'node:path';

export interface LeaseHolder {
  readonly writer: string;
  readonly pid: number;
  readonly token: string;
}

export interface LeaseOptions {
  /** A heartbeat older than this means the holder is gone (ms, default 30 s). */
  readonly staleMs?: number;
  /** How often the holder touches the file (ms, default 5 s). */
  readonly heartbeatMs?: number;
  readonly onLost?: () => void;
  /** Tests: the clock the heartbeat's age is measured on (default `Date.now`). */
  readonly now?: () => number;
  /** Tests: whether a pid runs on this Mac (default: `kill(pid, 0)`). */
  readonly alive?: (pid: number) => boolean;
  /** Tests: the pid written as this holder's (default `process.pid`). */
  readonly pid?: number;
}

/**
 * Whether `taker` takes the lease from a live `holder` (A1350): only the app's service does, from
 * anyone but another app, since it indexes every open notebook and the CLI only its one.
 */
export function outranks(taker: string, holder: string): boolean {
  return taker === 'app' && holder !== 'app';
}

export function leasePath(home: string): string {
  return join(home, 'vectors', 'indexer.lease');
}

async function readHolder(
  path: string,
): Promise<{ holder: LeaseHolder; mtimeMs: number } | undefined> {
  let handle;
  try {
    handle = await open(path, 'r');
  } catch {
    return undefined;
  }
  try {
    const [text, info] = await Promise.all([handle.readFile('utf8'), handle.stat()]);
    try {
      return { holder: JSON.parse(text) as LeaseHolder, mtimeMs: info.mtimeMs };
    } catch {
      // Half written: as good as stale once it is old.
      return { holder: { writer: '', pid: 0, token: '' }, mtimeMs: info.mtimeMs };
    }
  } finally {
    await handle.close();
  }
}

/** Who holds the lease now, if anyone live does. */
export async function leaseHolder(
  home: string,
  staleMs = 30_000,
  now: () => number = Date.now,
): Promise<LeaseHolder | undefined> {
  const found = await readHolder(leasePath(home));
  if (!found || now() - found.mtimeMs > staleMs) return undefined;
  return found.holder;
}

/** Whether a process with this pid runs on this machine (0: unknown, taken as alive). */
function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export class Lease {
  private timer: ReturnType<typeof setInterval> | undefined;
  private lost = false;

  private constructor(
    private readonly path: string,
    readonly holder: LeaseHolder,
    private readonly options: LeaseOptions,
  ) {}

  /** Takes the lease, or answers undefined while a live process holds it. */
  static async acquire(
    home: string,
    writer: string,
    options: LeaseOptions = {},
  ): Promise<Lease | undefined> {
    const path = leasePath(home);
    await mkdir(join(home, 'vectors'), { recursive: true });
    const holder: LeaseHolder = { writer, pid: options.pid ?? process.pid, token: randomUUID() };
    const now = options.now ?? Date.now;
    const isAlive = options.alive ?? alive;
    // A third try: another taker can slip in between moving a stale lease aside and writing ours.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const handle = await open(path, 'wx');
        try {
          await handle.writeFile(JSON.stringify(holder));
        } finally {
          await handle.close();
        }
        const lease = new Lease(path, holder, options);
        lease.start();
        return lease;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      const found = await readHolder(path);
      const fresh = found && now() - found.mtimeMs <= (options.staleMs ?? 30_000);
      // Fresh but its process is gone (a crashed service): stale at once. The lease is this
      // Mac's, so the pid is too. A live holder keeps it, unless this is the app's service and the
      // holder an agent's `penmoss` (A1350): it learns at its next heartbeat that it lost it.
      if (fresh && isAlive(found.holder.pid) && !outranks(writer, found.holder.writer)) {
        return undefined;
      }
      // Stale (or outranked): move it aside (only one taker's rename succeeds), then try again.
      await rename(path, `${path}.stale-${holder.token}`)
        .then(() => unlink(`${path}.stale-${holder.token}`))
        .catch(() => undefined);
    }
    return undefined;
  }

  /** True while the file still names this holder. */
  async held(): Promise<boolean> {
    if (this.lost) return false;
    const found = await readHolder(this.path);
    if (found?.holder.token !== this.holder.token) this.lose();
    return !this.lost;
  }

  async release(): Promise<void> {
    this.stop();
    if (this.lost) return;
    this.lost = true;
    const found = await readHolder(this.path);
    if (found?.holder.token === this.holder.token) await unlink(this.path).catch(() => undefined);
  }

  private start(): void {
    this.timer = setInterval(() => void this.beat(), this.options.heartbeatMs ?? 5_000);
    this.timer.unref();
  }

  private stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async beat(): Promise<void> {
    if (!(await this.held())) return;
    const now = new Date();
    await utimes(this.path, now, now).catch(() => undefined);
  }

  private lose(): void {
    if (this.lost) return;
    this.lost = true;
    this.stop();
    this.options.onLost?.();
  }
}
