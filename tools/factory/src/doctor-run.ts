/**
 * Runs the doctor's checks in a real sandbox: a throwaway branch and worktree from `main`,
 * the slot's Seatbelt provider, then teardown (worktree and branch both removed).
 */
import { ensureAvd } from './avd.ts';
import { withHeavySlot } from './heavy.ts';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { FactoryConfig, SlotConfig } from './config.ts';
import { doctorChecks, judge, type CheckOutcome } from './doctor.ts';
import type { Exec } from './exec.ts';
import { loadSecrets, missingSecrets, type Secrets } from './secrets.ts';
import { makeOwnDirs, sandboxSpec, seatbeltProvider } from './sandbox.ts';
import { expandHome } from './config.ts';

export interface DoctorOptions {
  readonly repo: string;
  readonly full: boolean;
  /** The ref the throwaway branch starts from (default `origin/main`). */
  readonly base: string;
  /** Only checks whose name contains this. */
  readonly only?: string;
  readonly exec: Exec;
  readonly log: (line: string) => void;
}

export async function runDoctor(config: FactoryConfig, slot: SlotConfig, options: DoctorOptions) {
  const loaded = loadSecrets(expandHome(config.envFile));
  const secrets: Secrets = loaded.ok ? loaded.secrets : {};
  if (!loaded.ok) options.log(`env file: ${loaded.error}; checks that need tokens are skipped`);
  else if (loaded.ignored.length > 0)
    options.log(`env file: ignored unknown keys ${loaded.ignored.join(', ')}`);

  const spec = sandboxSpec(config, slot, secrets);
  makeOwnDirs(spec);
  const { createSandbox } = await import('@ai-hero/sandcastle');
  const branch = `factory/doctor-slot${slot.id}-${Date.now().toString(36)}`;
  const sandbox = await createSandbox({
    branch,
    baseBranch: options.base,
    cwd: options.repo,
    sandbox: await seatbeltProvider(spec),
  });
  const outcomes: CheckOutcome[] = [];
  // Each check's whole output, for when its tail isn't enough.
  const logs = join(expandHome(config.stateDir), 'doctor');
  mkdirSync(logs, { recursive: true });
  try {
    for (const check of doctorChecks(config, slot, homedir())) {
      if (options.only !== undefined && !check.setup && !check.name.includes(options.only))
        continue;
      if (check.slow && !options.full) {
        outcomes.push({ check, status: 'skipped', detail: 'slow: run with --full', seconds: 0 });
        continue;
      }
      const missing = missingSecrets(secrets, check.needs ?? []);
      if (missing.length > 0) {
        outcomes.push({
          check,
          status: 'skipped',
          detail: `needs ${missing.join(', ')} in the env file`,
          seconds: 0,
        });
        continue;
      }
      const started = Date.now();
      if (check.needsAvd) await ensureAvd(config, slot, options.exec);
      // Slow checks count against the Mac's heavy-job slots, like anyone's `task check` (W12).
      const result = check.slow
        ? await withHeavySlot(
            `factory doctor: ${check.name}`,
            sandbox.worktreePath,
            () => sandbox.exec(check.command),
            {
              onWait: (holders) =>
                options.log(`  waits for a heavy-job slot (held by ${holders.join('; ')})`),
            },
          )
        : await sandbox.exec(check.command);
      const verdict = judge(check, result.exitCode, result.stdout);
      const logFile = join(
        logs,
        `slot${slot.id}-${check.name.replaceAll(/[^\w]+/g, '-').toLowerCase()}.log`,
      );
      writeFileSync(
        logFile,
        `$ ${check.command}\n\n${result.stdout}\n--- stderr ---\n${result.stderr}\n`,
      );
      const outcome: CheckOutcome = {
        check,
        status: verdict.ok ? 'ok' : 'failed',
        detail: verdict.ok
          ? verdict.detail
          : `${verdict.detail}\n    ${tail(result.stdout + result.stderr)}`,
        seconds: (Date.now() - started) / 1000,
      };
      outcomes.push(outcome);
      options.log(`${verdict.ok ? '✓' : '✗'} ${check.name}`);
    }
  } finally {
    await sandbox.close();
    await options.exec('git', ['-C', options.repo, 'branch', '-D', branch]);
  }
  return outcomes;
}

function tail(text: string): string {
  return text.trim().split('\n').slice(-6).join('\n    ');
}
