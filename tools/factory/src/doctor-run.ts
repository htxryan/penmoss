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
import { doctorChecks, judge, limitSkipped, usageLimited, type CheckOutcome } from './doctor.ts';
import type { AgentName } from './config.ts';
import { writeDoctorSummary } from './doctor-summary.ts';
import type { Exec } from './exec.ts';
import { hostGit } from './git.ts';
import { loadSecrets, type Secrets } from './secrets.ts';
import { createAppTokens, loadAppCredentials } from './github-app.ts';
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

  // The sandbox's read-only GitHub token comes from the app, as in a real run (A1222).
  const creds = loadAppCredentials(expandHome(config.publisher.envFile));
  let ghToken: string | undefined;
  if (!creds.ok) options.log(`GitHub App: ${creds.error}; the GitHub check is skipped`);
  else
    ghToken = await createAppTokens({ ...creds, repo: config.repo })
      .read()
      .catch((error: unknown) => {
        options.log(`GitHub App: ${error instanceof Error ? error.message : String(error)}`);
        return undefined;
      });
  const tokens = { ...secrets, ...(ghToken ? { GH_TOKEN: ghToken } : {}) };
  const spec = sandboxSpec(config, slot, tokens);
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
  // Agents whose plan hit its usage limit: their later checks would only hit it again (A1376).
  const limited = new Set<AgentName>();
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
      const missing = (check.needs ?? []).filter((key) => !tokens[key]);
      if (missing.length > 0) {
        outcomes.push({
          check,
          status: 'skipped',
          detail: `needs ${missing.join(', ')} (${missing.includes('GH_TOKEN') ? 'the GitHub App' : 'the env file'})`,
          seconds: 0,
        });
        continue;
      }
      if (check.agent && limited.has(check.agent)) {
        outcomes.push({ check, status: 'warned', detail: limitSkipped(check.agent), seconds: 0 });
        options.log(`! ${check.name}`);
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
      const limit = verdict.ok ? null : usageLimited(check, result.stdout + result.stderr);
      if (limit && check.agent) limited.add(check.agent);
      const outcome: CheckOutcome = {
        check,
        status: verdict.ok ? 'ok' : limit ? 'warned' : 'failed',
        detail: verdict.ok
          ? verdict.detail
          : (limit ?? `${verdict.detail}\n    ${tail(result.stdout + result.stderr)}`),
        seconds: (Date.now() - started) / 1000,
      };
      outcomes.push(outcome);
      options.log(
        `${{ ok: '✓', failed: '✗', warned: '!', skipped: '–' }[outcome.status]} ${check.name}`,
      );
    }
  } finally {
    await sandbox.close();
    await hostGit(options.exec, options.repo, ['branch', '-D', branch]);
  }
  // The Factory UI's health bar reads the last full result per slot (A1233).
  if (options.only === undefined)
    writeDoctorSummary(config, {
      slot: slot.id,
      at: new Date().toISOString(),
      failed: outcomes.filter((o) => o.status === 'failed').map((o) => o.check.name),
      limited: [...limited],
    });
  return outcomes;
}

function tail(text: string): string {
  return text.trim().split('\n').slice(-6).join('\n    ');
}
