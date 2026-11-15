// What every package's vitest config starts from (A1513): the timeouts, the worker count, the
// wall-clock budgets switch (A1244) and, on a Mac, real git first on PATH. Each
// `vitest.config.ts` spreads `sharedTest(...)` into its `test` block and adds only its own
// environment, setup files and the like.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { delimiter, dirname, join } from 'node:path';

/** `pnpm budgets` (`task budgets`) sets this: run only the *.budget.test.* files, one at a time. */
export const budgets = process.env.PENMOSS_BUDGETS === '1';

/**
 * How many test files run at once. `PENMOSS_VITEST_WORKERS` decides when set. CI's hosted
 * runners have 4 vCPUs, so 4 there. Here, a quarter of the cores (at least 2): this Mac's 18 give
 * 4, and two heavy jobs (W12's slots, A1175) then use under half of it.
 *
 * @param {Readonly<Record<string, string | undefined>>} [env]
 * @param {number} [cpus]
 * @returns {number}
 */
export function workers(env = process.env, cpus = availableParallelism()) {
  const asked = Number(env['PENMOSS_VITEST_WORKERS']);
  if (Number.isInteger(asked) && asked > 0) return asked;
  if (env['CI']) return 4;
  return Math.max(2, Math.floor(cpus / 4));
}

/**
 * The folder of the git that Apple's `/usr/bin/git` runs, or null where `git` is not that shim.
 * The shim goes through xcrun on every call, about 6 ms each (tests.md §5.2): a suite that runs
 * thousands of git commands spends half its time there. `xcode-select -p` never opens the
 * install dialog the shim can (A824), so a Mac without the tools just keeps the shim.
 *
 * @param {NodeJS.Platform} [platform]
 * @param {Readonly<Record<string, string | undefined>>} [env]
 * @returns {string | null}
 */
export function realGitDir(platform = process.platform, env = process.env) {
  if (platform !== 'darwin') return null;
  const found = spawnSync('/bin/sh', ['-c', 'command -v git'], { env, encoding: 'utf8' });
  if (found.stdout?.trim() !== '/usr/bin/git') return null;
  const tools = spawnSync('/usr/bin/xcode-select', ['-p'], { env, encoding: 'utf8' });
  if (tools.status !== 0 || !tools.stdout) return null;
  const git = join(tools.stdout.trim(), 'usr', 'bin', 'git');
  return existsSync(git) ? dirname(git) : null;
}

/**
 * PATH with the real git's folder first on a Mac (see realGitDir), unchanged elsewhere.
 *
 * @param {Readonly<Record<string, string | undefined>>} [env]
 * @param {NodeJS.Platform} [platform]
 * @returns {string}
 */
export function testPath(env = process.env, platform = process.platform) {
  const path = env['PATH'] ?? '';
  const dir = realGitDir(platform, env);
  return dir ? `${dir}${delimiter}${path}` : path;
}

/** Resolved once per run: the config is loaded once, and the workers inherit it. */
const PATH = testPath();
// The main process too, so a globalSetup and the workers it forks see the same git.
process.env['PATH'] = PATH;

/**
 * @param {string} glob
 * @returns {string}
 */
const budgetOf = (glob) => glob.replace(/\.test\./, '.budget.test.');

/**
 * The shared `test` block. `include` names the unit test files (`test/**\/*.test.ts`); in
 * `budgets` the same globs as `*.budget.test.*` are run instead, one file at a time, and the unit
 * run leaves them out. `exclude` adds a package's own exclusions.
 *
 * @param {{ include: readonly string[], exclude?: readonly string[], env?: boolean }} files
 */
export function sharedTest({ include, exclude = [], env = true }) {
  return {
    // A timeout is for a hang, not a slow machine: on this shared Mac (W12) a run starved of
    // CPU, as a throttled background job is, runs 10–30× slower than alone, well past vitest's
    // 5 s and 10 s. Wall-clock budgets live in *.budget.test.ts (A1244).
    testTimeout: 30_000,
    hookTimeout: 30_000,
    include: budgets ? include.map(budgetOf) : [...include],
    exclude: [...exclude, ...(budgets ? [] : include.map(budgetOf))],
    maxWorkers: budgets ? 1 : workers(),
    ...(env ? { env: { PATH } } : {}),
  };
}
