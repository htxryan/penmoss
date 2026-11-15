/** Work in the Mac's test VM, once the VM can take it (F7, F10). */
import { VmUnavailable } from './proof/mac.ts';
import type { RunSandbox, RunDeps } from './run-deps.ts';
import { withTimeout } from './timeout.ts';

/**
 * `work` in the test VM, once the VM can take it (F7, F10): a Mac proof, or validation's Mac
 * walkthrough. While it can't (tart missing, the VM not made, another run on it, a VM started
 * some other way, a boot that fails), the run waits a poll and asks again: no failure, no round
 * used, and `factory:status` says why. The check and the work hold the heavy-job slot; the waits
 * don't. Only after `macProof.waitHours` does it give up, with the reason.
 */
export async function whenVmFree<T>(
  deps: Pick<RunDeps, 'config' | 'heavy' | 'macVmCheck' | 'now' | 'log' | 'sleep' | 'waitingFor'>,
  gate: RunSandbox,
  /** What waits, as `factory:status` says it: "the Mac proof". */
  what: string,
  heavyLabel: string,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; why: string }> {
  const since = deps.now();
  let said: string | undefined;
  try {
    for (;;) {
      const tried = await deps.heavy(heavyLabel, async () => {
        const check = await deps.macVmCheck(gate);
        if (!check.ok) return { wait: check.reason };
        try {
          return {
            value: await withTimeout(work, deps.config.timeouts.proofMinutes, `running ${what}`),
          };
        } catch (error) {
          if (error instanceof VmUnavailable) return { wait: error.message };
          throw error;
        }
      });
      if ('value' in tried) return { ok: true, value: tried.value };
      const hours = (deps.now().getTime() - since.getTime()) / 3_600_000;
      if (hours >= deps.config.macProof.waitHours)
        return {
          ok: false,
          why: `${what} waited ${deps.config.macProof.waitHours} h for the test VM (${deps.config.macProof.vm}), which still can't take it: ${tried.wait}.`,
        };
      if (tried.wait !== said) {
        deps.log('proof-waiting', { platform: 'mac', reason: tried.wait });
        said = tried.wait;
      }
      deps.waitingFor(`${what} waits for the test VM: ${tried.wait}`);
      await deps.sleep(deps.config.pollSeconds);
    }
  } finally {
    deps.waitingFor(null);
  }
}
