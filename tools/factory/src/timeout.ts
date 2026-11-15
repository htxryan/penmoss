/** A step's time bound (F13): a hung step stops the run, not the Mac. */

/** How long a timed-out step gets to stop what it started before the run goes on without it. */
export const SETTLE_MS = 120_000;

/**
 * Rejects when `work` takes longer than `minutes` (F13): a hung step stops the run, not the Mac.
 * Given as a function, `work` gets a signal that aborts at the timeout, so it can stop what it
 * started (`nodeExec` kills the command's process group); the rejection then waits for it to
 * finish stopping, up to `settleMs`, so the VM's lock or a slot's emulator is free before the
 * run moves on.
 */
export function withTimeout<T>(
  work: Promise<T> | ((signal: AbortSignal) => Promise<T>),
  minutes: number,
  what: string,
  settleMs = SETTLE_MS,
): Promise<T> {
  const controller = new AbortController();
  const running = typeof work === 'function' ? work(controller.signal) : work;
  // Once the step has timed out, whatever it returns while it stops doesn't count.
  const never = new Promise<never>(() => undefined);
  let late = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      late = true;
      const error = new Error(`${what} took longer than ${minutes} min`);
      if (typeof work !== 'function') return reject(error);
      controller.abort(error);
      const settle = setTimeout(() => reject(error), settleMs);
      void running
        .catch(() => undefined)
        .finally(() => {
          clearTimeout(settle);
          reject(error);
        });
    }, minutes * 60_000);
  });
  const onTime = running.then(
    (value) => (late ? never : value),
    (error: unknown) => {
      if (late) return never;
      throw error;
    },
  );
  return Promise.race([onTime, timedOut]).finally(() => clearTimeout(timer));
}
