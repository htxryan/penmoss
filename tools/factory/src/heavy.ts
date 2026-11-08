/**
 * The Mac's heavy-job slots (W12, A1175), taken from the host. `scripts/heavy.sh` frees a slot
 * whose owner pid is gone, and inside Seatbelt `kill -0` on any process outside the sandbox
 * fails, so a sandbox must never see the shared folder: it would free every host job's slot.
 * The factory takes the slot here instead, with the daemon's own pid, around each heavy step
 * (the gate, proof, the doctor's slow checks); inside, the sandbox has a private folder of its own.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface HeavyOptions {
  readonly dir?: string;
  readonly slots?: number;
  readonly pid?: number;
  readonly alive?: (pid: number) => boolean;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Called once, when every slot is taken, with who holds them. */
  readonly onWait?: (holders: string[]) => void;
}

export const heavyDir = (env: NodeJS.ProcessEnv = process.env) =>
  env['PENMOSS_HEAVY_DIR'] ?? join(homedir(), '.cache', 'penmoss', 'heavy');

const heavySlots = (env: NodeJS.ProcessEnv = process.env) =>
  Number(env['PENMOSS_HEAVY_SLOTS']) || 2;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists, it's just not ours.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function take(
  lock: string,
  pid: number,
  label: string,
  cwd: string,
  alive: (pid: number) => boolean,
): boolean {
  try {
    mkdirSync(lock);
  } catch {
    let owner = NaN;
    try {
      owner = Number(readFileSync(join(lock, 'owner'), 'utf8').split('\n')[0]);
    } catch {
      // The holder is still writing its owner file.
    }
    if (!Number.isInteger(owner) || owner <= 0 || alive(owner)) return false;
    rmSync(lock, { recursive: true, force: true });
    return take(lock, pid, label, cwd, alive);
  }
  writeFileSync(join(lock, 'owner'), `${pid}\n${label}\n${cwd}\n`);
  return true;
}

/** Waits for a free slot and returns its release; the same folders and format as heavy.sh. */
export async function takeHeavySlot(
  label: string,
  cwd: string,
  options: HeavyOptions = {},
): Promise<() => void> {
  const dir = options.dir ?? heavyDir();
  const slots = options.slots ?? heavySlots();
  const pid = options.pid ?? process.pid;
  const alive = options.alive ?? isAlive;
  const sleep = options.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  mkdirSync(dir, { recursive: true });
  let told = false;
  for (;;) {
    for (let i = 1; i <= slots; i++) {
      const lock = join(dir, `slot-${i}`);
      if (take(lock, pid, label, cwd, alive))
        return () => rmSync(lock, { recursive: true, force: true });
    }
    if (!told) {
      told = true;
      const holders: string[] = [];
      for (let i = 1; i <= slots; i++) {
        try {
          holders.push(
            readFileSync(join(dir, `slot-${i}`, 'owner'), 'utf8')
              .split('\n')
              .slice(1, 3)
              .join(' '),
          );
        } catch {
          // Freed meanwhile.
        }
      }
      options.onWait?.(holders);
    }
    await sleep(5000);
  }
}

/** Runs `fn` while holding a slot. */
export async function withHeavySlot<T>(
  label: string,
  cwd: string,
  fn: () => Promise<T>,
  options?: HeavyOptions,
): Promise<T> {
  const release = await takeHeavySlot(label, cwd, options);
  try {
    return await fn();
  } finally {
    release();
  }
}
