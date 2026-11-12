/**
 * The factory updates itself (A1293; amends A1226). A third LaunchAgent, the updater, looks at
 * `origin/main` every `autoUpdateMinutes` from the factory's own code checkout. When main has
 * changed what the factory runs (`tools/factory/` apart from its tests and docs, or the VM script
 * the Mac proof runs from the checkout), it runs the same update as `task factory:update -- --wait`: new work is held, the
 * active run or merge finishes, then the daemon and the UI restart on the new main. A commit
 * whose update failed isn't tried again; the next one on main is.
 *
 * The updater never stops itself: after an update it exits with RESTART, and launchd starts it
 * again on the new code (KeepAlive restarts it on any exit but 0). `autoUpdateMinutes: 0` turns it
 * off, and it exits 0 at once. While the daemon is stopped (`task factory:stop`) it updates
 * nothing, since an update starts the daemon again.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expandHome, type FactoryConfig } from './config.ts';
import { codeDir, liveDaemon, updateFactory, updatePending, type UpdateDeps } from './code.ts';
import type { Exec } from './exec.ts';
import { mustGit } from './git.ts';

/** What main changes that the factory runs from its code checkout. */
export const FACTORY_PATHS = ['tools/factory/', 'scripts/vm/'] as const;

/**
 * Whether a changed file under FACTORY_PATHS changes what the installed factory runs (A1344).
 * The factory's own tests (`test/`, the UI's `e2e/` and their two configs) and its Markdown, apart
 * from the prompts the runs read, don't: an update for them only holds new work until the active
 * run ends. Everything else does: the source, the prompts, the sandbox runner, the agents' config,
 * `package.json`, the patches, `factory.config.json`, `tsconfig.json`, and `scripts/vm/`.
 */
export function changesRuntime(file: string): boolean {
  if (!file.startsWith('tools/factory/')) return true;
  const path = file.slice('tools/factory/'.length);
  if (path.startsWith('test/') || path.startsWith('e2e/')) return false;
  if (path === 'vitest.config.ts' || path === 'playwright.config.ts') return false;
  if (path.toLowerCase().endsWith('.md') && !path.startsWith('prompts/')) return false;
  return true;
}

/** The updater's exit after an update: launchd starts it again, on the new code. */
export const RESTART = 75;

/** Where the updater keeps the main it couldn't update to. */
const failedPath = (config: FactoryConfig) =>
  join(expandHome(config.stateDir), 'auto-update.failed');

export interface Pending {
  /** origin/main's commit. */
  readonly sha: string;
  /** The files under FACTORY_PATHS it changes from the checkout's commit that the factory runs. */
  readonly files: readonly string[];
}

/** Fetches main into the code checkout and says what of the factory it changes. */
export async function pendingUpdate(exec: Exec, dir: string): Promise<Pending> {
  await mustGit(exec, dir, ['fetch', '--quiet', 'origin', 'main']);
  const sha = (await mustGit(exec, dir, ['rev-parse', 'origin/main'])).trim();
  const files = (
    await mustGit(exec, dir, ['diff', '--name-only', 'HEAD', 'origin/main', '--', ...FACTORY_PATHS])
  )
    .split('\n')
    .filter((file) => file !== '' && changesRuntime(file));
  return { sha, files };
}

function lastFailed(config: FactoryConfig): string {
  try {
    return readFileSync(failedPath(config), 'utf8').trim();
  } catch {
    return '';
  }
}

/**
 * One look: the update's exit code when it updated (or tried to), undefined when there was
 * nothing to do.
 */
export async function checkOnce(
  config: FactoryConfig,
  deps: UpdateDeps,
  update: typeof updateFactory = updateFactory,
): Promise<number | undefined> {
  // A factory:update Ryan started is already doing it; a daemon he stopped stays stopped.
  if (updatePending(config, deps.alive) || liveDaemon(config, deps.alive) === undefined)
    return undefined;
  const pending = await pendingUpdate(deps.exec, codeDir(config));
  if (pending.files.length === 0 || pending.sha === lastFailed(config)) return undefined;
  const shown = pending.files.slice(0, 3).join(', ');
  const more = pending.files.length > 3 ? ` and ${pending.files.length - 3} more` : '';
  deps.log(`main ${pending.sha.slice(0, 7)} changes the factory (${shown}${more}): updating.`);
  const code = await update(config, deps, { wait: true });
  if (code === 0) return RESTART;
  writeFileSync(failedPath(config), `${pending.sha}\n`);
  deps.log(`The update to ${pending.sha.slice(0, 7)} failed; the next commit on main is tried.`);
  return code;
}

/** The updater LaunchAgent's loop. */
export async function runUpdater(config: FactoryConfig, deps: UpdateDeps): Promise<number> {
  if (config.autoUpdateMinutes === 0) {
    deps.log('Automatic updates are off (autoUpdateMinutes is 0).');
    return 0;
  }
  deps.log(`Looking for factory changes on main every ${config.autoUpdateMinutes} min.`);
  for (;;) {
    try {
      const code = await checkOnce(config, deps);
      if (code !== undefined) return code === 0 ? RESTART : code;
    } catch (error) {
      deps.log(`Couldn't look at main: ${error instanceof Error ? error.message : String(error)}`);
    }
    await deps.sleep(config.autoUpdateMinutes * 60_000);
  }
}
