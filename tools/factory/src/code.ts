/**
 * The factory's own code (A1226): the LaunchAgents run `cli.ts` from a clone of `main` under the
 * state folder (`<stateDir>/code`), never from Ryan's checkout. So the daemon, and the prompts it
 * reads on every run, follow `main` only when `factory:update` moves them, and no branch Ryan
 * checks out, nor a worktree deleted from under it, changes what runs.
 *
 * It is a clone of its own, not a worktree of the runs' clone (`<stateDir>/repo`): Sandcastle
 * mounts that clone's `.git` into every sandbox, so its refs, and through a planted `commondir` its
 * config, are an agent's to write. Nothing a sandbox sees is in this one. Its git goes through
 * git.ts, so nothing of Ryan's git config applies either.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expandHome, type FactoryConfig } from './config.ts';
import type { Exec } from './exec.ts';
import { hostGit, mustGit } from './git.ts';
import { DEAD_END_PUSH_URL } from './host.ts';
import { githubUrl } from './publish.ts';
import { LABEL, plistPath, renderPlist, UI_LABEL } from './launchd.ts';
import { readStatus, type Commit, type DaemonStatus } from './status.ts';
import { issueKey } from './tracker/port.ts';

export function codeDir(config: FactoryConfig): string {
  return join(expandHome(config.stateDir), 'code');
}

export function codeCli(dir: string): string {
  return join(dir, 'tools/factory/src/cli.ts');
}

/** The checkout this module runs from (Ryan's for `task factory:*`, the code checkout for the daemon). */
export function ownCheckout(): string {
  return fileURLToPath(new URL('../../..', import.meta.url)).replace(/\/$/, '');
}

export async function commitOf(exec: Exec, dir: string): Promise<Commit | undefined> {
  const r = await hostGit(exec, dir, ['log', '-1', '--format=%H%x09%s']);
  if (r.code !== 0) return undefined;
  const [sha = '', ...subject] = r.stdout.trim().split('\t');
  return sha ? { sha, subject: subject.join('\t') } : undefined;
}

async function must(
  exec: Exec,
  cmd: string,
  args: readonly string[],
  options: { cwd?: string; env?: Record<string, string> } = {},
): Promise<void> {
  const r = await exec(cmd, args, options);
  if (r.code !== 0) {
    const why = r.stderr.trim().split('\n').slice(-3).join(' / ');
    const sub = args.find((a, i) => !a.startsWith('-') && args[i - 1] !== '-C');
    throw new Error(`${cmd} ${sub ?? ''} failed: ${why}`);
  }
}

/** The factory's dependencies only: it runs under Node directly, and nothing else is built here. */
export const PNPM_INSTALL = [
  'pnpm',
  'install',
  '--frozen-lockfile',
  '--filter',
  './tools/factory...',
] as const;

async function pnpmInstall(exec: Exec, dir: string): Promise<void> {
  await must(exec, 'corepack', PNPM_INSTALL, {
    cwd: dir,
    env: {
      ...(Object.fromEntries(
        Object.entries(process.env).filter(([, v]) => v !== undefined),
      ) as Record<string, string>),
      COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
    },
  });
}

/**
 * Clones the code checkout if it isn't there, then moves it to `origin/main` (detached) and
 * installs the factory's dependencies. When the install fails, it goes back to the commit it was
 * at, so the LaunchAgents still have code that runs, and throws.
 */
export async function syncCode(
  config: FactoryConfig,
  exec: Exec,
  log: (line: string) => void,
): Promise<{ from?: Commit; to: Commit }> {
  const dir = codeDir(config);
  const fresh = !existsSync(join(dir, '.git'));
  if (fresh) {
    mkdirSync(dirname(dir), { recursive: true });
    log(`Cloning ${config.repo} into ${dir}`);
    await mustGit(exec, dirname(dir), ['clone', '--quiet', githubUrl(config), dir]);
  }
  const from = fresh ? undefined : await commitOf(exec, dir);
  // Nothing is ever pushed from here.
  await mustGit(exec, dir, ['remote', 'set-url', '--push', 'origin', DEAD_END_PUSH_URL]);
  await mustGit(exec, dir, ['fetch', '--quiet', 'origin', 'main']);
  await mustGit(exec, dir, ['checkout', '--quiet', '--force', '--detach', 'origin/main']);
  try {
    await pnpmInstall(exec, dir);
  } catch (error) {
    if (from) {
      log(`The install failed; going back to ${from.sha.slice(0, 7)}`);
      await mustGit(exec, dir, ['checkout', '--quiet', '--force', '--detach', from.sha]);
      await pnpmInstall(exec, dir);
    }
    throw error;
  }
  const to = await commitOf(exec, dir);
  if (!to) throw new Error(`can't read the commit of ${dir}`);
  return { ...(from ? { from } : {}), to };
}

export interface AgentDeps {
  readonly exec: Exec;
  readonly home: string;
  readonly uid: string;
  /** The Node that runs the LaunchAgents: the one running this command. */
  readonly node: string;
  readonly log: (line: string) => void;
}

const AGENTS = [
  [LABEL, 'daemon', 'daemon.log'],
  [UI_LABEL, 'ui', 'ui.log'],
] as const;

/** The folders of agents configured by absolute path, so the LaunchAgents find them. */
function agentDirs(config: FactoryConfig): string[] {
  return Object.values(config.agents)
    .map((a) => a.bin)
    .filter((bin) => bin.startsWith('/'))
    .map((bin) => dirname(bin));
}

/** Writes both plists, pointing at the code checkout. */
export function writeAgents(config: FactoryConfig, deps: AgentDeps): string[] {
  const state = expandHome(config.stateDir);
  const dir = codeDir(config);
  return AGENTS.map(([label, command, logName]) => {
    const plist = plistPath(deps.home, label);
    mkdirSync(dirname(plist), { recursive: true });
    writeFileSync(
      plist,
      renderPlist({
        label,
        command,
        node: deps.node,
        cli: codeCli(dir),
        repo: dir,
        path: [
          dirname(deps.node),
          // Where Claude Code's installer puts `claude`: launchd's PATH has nothing from the
          // user's shell, and each run's sandbox gets this PATH (PEN-75's first run failed on it).
          join(deps.home, '.local', 'bin'),
          ...agentDirs(config),
          '/opt/homebrew/bin',
          '/usr/local/bin',
          '/usr/bin',
          '/bin',
          '/usr/sbin',
          '/sbin',
        ].join(':'),
        log: join(state, logName),
      }),
    );
    return plist;
  });
}

async function stopAgents(deps: AgentDeps): Promise<void> {
  for (const [label] of AGENTS)
    await deps.exec('launchctl', ['bootout', `gui/${deps.uid}/${label}`]);
}

/** Loads both LaunchAgents again (they start now); an error names the one that failed. */
async function startAgents(deps: AgentDeps): Promise<string | undefined> {
  for (const [label] of AGENTS) {
    const loaded = await deps.exec('launchctl', [
      'bootstrap',
      `gui/${deps.uid}`,
      plistPath(deps.home, label),
    ]);
    if (loaded.code !== 0) return `launchctl bootstrap ${label} failed: ${loaded.stderr.trim()}`;
  }
  return undefined;
}

/**
 * `factory:install`: makes the code checkout if there is none (an existing one stays where it is:
 * `factory:update` moves it), writes the LaunchAgents to run from it, and (re)starts them.
 */
export async function installAgents(config: FactoryConfig, deps: AgentDeps): Promise<number> {
  mkdirSync(expandHome(config.stateDir), { recursive: true });
  const dir = codeDir(config);
  if (existsSync(join(dir, '.git'))) {
    const at = await commitOf(deps.exec, dir);
    deps.log(
      `The factory's code stays at ${at ? `${at.sha.slice(0, 7)} (${at.subject})` : dir}; task factory:update moves it to origin/main.`,
    );
  } else {
    try {
      const { to } = await syncCode(config, deps.exec, deps.log);
      deps.log(`The factory's code: ${dir} at ${to.sha.slice(0, 7)} (${to.subject})`);
    } catch (error) {
      deps.log(`Can't set up the factory's code: ${message(error)}`);
      return 1;
    }
  }
  const plists = writeAgents(config, deps);
  await stopAgents(deps);
  const failed = await startAgents(deps);
  if (failed) {
    deps.log(failed);
    return 1;
  }
  for (const plist of plists) deps.log(`Installed ${plist}`);
  deps.log(
    'The daemon and the UI start now and at every login. Logs: task factory:logs; the UI: task factory:ui:open',
  );
  return 0;
}

/** Set while `factory:update` waits: the daemon starts no new work (A1226). */
export function pausePath(config: FactoryConfig): string {
  return join(expandHome(config.stateDir), 'update.pause');
}

/** Whether a live `factory:update` holds the daemon; a pause left by a crashed one doesn't. */
export function updatePending(config: FactoryConfig, alive: (pid: number) => boolean): boolean {
  try {
    const { pid } = JSON.parse(readFileSync(pausePath(config), 'utf8')) as { pid?: unknown };
    return typeof pid === 'number' && alive(pid);
  } catch {
    return false;
  }
}

export interface UpdateDeps extends AgentDeps {
  readonly pid: number;
  readonly alive: (pid: number) => boolean;
  readonly now: () => Date;
  readonly sleep: (ms: number) => Promise<void>;
  /** The daemon's status, as `status.json` holds it. */
  readonly status?: () => DaemonStatus | undefined;
}

/** The daemon's pid from its lock, if it is alive. */
function liveDaemon(config: FactoryConfig, alive: (pid: number) => boolean): number | undefined {
  try {
    const pid = Number(
      readFileSync(join(expandHome(config.stateDir), 'daemon.lock'), 'utf8').trim(),
    );
    return Number.isInteger(pid) && pid > 0 && alive(pid) ? pid : undefined;
  } catch {
    return undefined;
  }
}

type Readiness = { kind: 'idle' } | { kind: 'busy'; what: string } | { kind: 'unseen' };

function readiness(
  config: FactoryConfig,
  deps: UpdateDeps,
  since: Date,
  status: DaemonStatus | undefined,
): Readiness {
  if (liveDaemon(config, deps.alive) === undefined) return { kind: 'idle' };
  const busy = [
    ...(status?.running ?? []).map((r) => `${issueKey(config, r.issue)} on slot ${r.slot}`),
    ...(status?.merging ?? []).map((n) => `${issueKey(config, n)} merging`),
  ];
  if (busy.length > 0) return { kind: 'busy', what: busy.join(', ') };
  // Idle only by a poll that saw the pause: one before it could still have started a run.
  // A daemon from before factory:update writes no `paused`; its fresh poll is the best there is.
  if (status && Date.parse(status.updatedAt) >= since.getTime() && status.paused !== false)
    return { kind: 'idle' };
  return { kind: 'unseen' };
}

/**
 * `factory:update`: holds the daemon's new work, waits until no run or merge is active (or, without
 * `wait`, refuses), stops both LaunchAgents, moves the code checkout to `origin/main` with a fresh
 * install, rewrites the plists and starts them again.
 */
export async function updateFactory(
  config: FactoryConfig,
  deps: UpdateDeps,
  options: { readonly wait: boolean },
): Promise<number> {
  const dir = codeDir(config);
  if (!existsSync(join(dir, '.git'))) {
    deps.log(`There is no code checkout at ${dir} yet: run task factory:install first.`);
    return 1;
  }
  const status = deps.status ?? (() => readStatus(config));
  const pause = pausePath(config);
  const since = deps.now();
  writeFileSync(pause, JSON.stringify({ pid: deps.pid, at: since.toISOString() }));
  try {
    // A daemon that polls at all writes status.json within a poll; three is a hung one.
    const deadline = since.getTime() + config.pollSeconds * 3 * 1000;
    let said = '';
    for (;;) {
      const ready = readiness(config, deps, since, status());
      if (ready.kind === 'idle') break;
      if (ready.kind === 'busy') {
        if (!options.wait) {
          deps.log(
            `Not updating: the daemon is busy (${ready.what}). Try again when it is idle, or task factory:update -- --wait.`,
          );
          return 1;
        }
        if (said !== ready.what) deps.log(`Waiting for ${ready.what}; new work is held.`);
        said = ready.what;
      } else if (deps.now().getTime() > deadline) {
        const hung = 'the daemon has not polled since the update asked it to hold new work';
        if (!options.wait) {
          deps.log(`Not updating: ${hung}. See task factory:logs.`);
          return 1;
        }
        if (said !== hung) deps.log(`Still waiting: ${hung}. See task factory:logs.`);
        said = hung;
      }
      await deps.sleep(5000);
    }

    await stopAgents(deps);
    let code = 0;
    try {
      const { from, to } = await syncCode(config, deps.exec, deps.log);
      deps.log(
        from?.sha === to.sha
          ? `Already at ${to.sha.slice(0, 7)} (${to.subject}).`
          : `Updated ${from ? from.sha.slice(0, 7) : dir} to ${to.sha.slice(0, 7)} (${to.subject}).`,
      );
    } catch (error) {
      deps.log(`Update failed: ${message(error)}. Restarting on the code it had.`);
      code = 1;
    }
    writeAgents(config, deps);
    rmSync(pause, { force: true });
    const failed = await startAgents(deps);
    if (failed) {
      deps.log(failed);
      return 1;
    }
    deps.log('The daemon and the UI restarted.');
    return code;
  } finally {
    rmSync(pause, { force: true });
  }
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
