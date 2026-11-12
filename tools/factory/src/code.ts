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
import { LABEL, plistPath, renderPlist, UI_LABEL, UPDATER_LABEL } from './launchd.ts';
import { formatStatus, readStatus, type Commit, type DaemonStatus } from './status.ts';
import { issueKey } from './tracker/port.ts';
import { USAGE_LIMIT_WAIT } from './limits.ts';

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
  /** Waits between launchctl's checks: bootout returns before launchd has removed the service. */
  readonly sleep: (ms: number) => Promise<void>;
}

/** The daemon and the UI: what an update stops and starts again. */
const AGENTS = [
  [LABEL, 'daemon', 'daemon.log'],
  [UI_LABEL, 'ui', 'ui.log'],
] as const;

/** The updater too: it runs the updates, so an update never stops it (updater.ts). */
const ALL_AGENTS = [...AGENTS, [UPDATER_LABEL, 'updater', 'updater.log']] as const;

/** The folders of agents configured by absolute path, so the LaunchAgents find them. */
function agentDirs(config: FactoryConfig): string[] {
  return Object.values(config.agents)
    .map((a) => a.bin)
    .filter((bin) => bin.startsWith('/'))
    .map((bin) => dirname(bin));
}

/**
 * The PATH both LaunchAgents run with, and so every run's sandbox and the host's own commands
 * (git, gh, osascript): launchd's PATH has nothing from the user's shell. `task factory:doctor`
 * checks the host's commands on this PATH, not the shell's.
 */
export function agentPath(config: FactoryConfig, home: string, node: string): string {
  return [
    dirname(node),
    // Where Claude Code's installer puts `claude` (PEN-75's first run failed without it).
    join(home, '.local', 'bin'),
    ...agentDirs(config),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ].join(':');
}

/** Writes the three plists, pointing at the code checkout. */
export function writeAgents(config: FactoryConfig, deps: AgentDeps): string[] {
  const state = expandHome(config.stateDir);
  const dir = codeDir(config);
  return ALL_AGENTS.map(([label, command, logName]) => {
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
        path: agentPath(config, deps.home, deps.node),
        log: join(state, logName),
      }),
    );
    return plist;
  });
}

const service = (deps: AgentDeps, label: string) => `gui/${deps.uid}/${label}`;

/** Whether launchd has `label` loaded (running or not). */
async function isLoaded(deps: AgentDeps, label: string): Promise<boolean> {
  return (await deps.exec('launchctl', ['print', service(deps, label)])).code === 0;
}

/** How long to wait for launchd to finish a bootout: it returns before the service is gone. */
const GONE_TRIES = 40;
const GONE_EVERY_MS = 250;

/** Waits (at most 10 s) until launchd no longer has `label`; false if it still does. */
async function untilGone(deps: AgentDeps, label: string): Promise<boolean> {
  for (let i = 0; i < GONE_TRIES; i++) {
    if (!(await isLoaded(deps, label))) return true;
    await deps.sleep(GONE_EVERY_MS);
  }
  return false;
}

/** Stops both LaunchAgents, and waits until launchd has really removed them. */
async function stopAgents(deps: AgentDeps): Promise<void> {
  for (const [label] of AGENTS) await deps.exec('launchctl', ['bootout', service(deps, label)]);
  for (const [label] of AGENTS)
    if (!(await untilGone(deps, label)))
      deps.log(`launchd still has ${label} 10 s after stopping it; starting it again anyway.`);
}

export const BOOTSTRAP_TRIES = 4;

/**
 * Loads one LaunchAgent (it starts now). `launchctl bootstrap` fails with "5: Input/output error"
 * while launchd still holds the service it booted out a moment ago (PEN-75's third update), so a
 * failure boots it out again, waits until it is gone and tries again, a few times.
 */
async function bootstrap(deps: AgentDeps, label: string): Promise<string | undefined> {
  let why = '';
  for (let attempt = 1; attempt <= BOOTSTRAP_TRIES; attempt++) {
    const r = await deps.exec('launchctl', [
      'bootstrap',
      `gui/${deps.uid}`,
      plistPath(deps.home, label),
    ]);
    if (r.code === 0) return undefined;
    why = r.stderr.trim() || `exit ${r.code}`;
    if (attempt === BOOTSTRAP_TRIES) break;
    deps.log(`launchctl bootstrap ${label} failed (${why}); trying again.`);
    await deps.exec('launchctl', ['bootout', service(deps, label)]);
    await untilGone(deps, label);
    await deps.sleep(1000 * attempt);
  }
  return `launchctl bootstrap ${label} failed ${BOOTSTRAP_TRIES} times: ${why}`;
}

/** Loads the updater when launchd doesn't have it (a factory installed before it). */
async function ensureUpdater(deps: AgentDeps): Promise<string | undefined> {
  return (await isLoaded(deps, UPDATER_LABEL)) ? undefined : bootstrap(deps, UPDATER_LABEL);
}

/** Loads both LaunchAgents again, each even when the other failed; the errors name which. */
async function startAgents(deps: AgentDeps): Promise<string[]> {
  const failed: string[] = [];
  for (const [label] of AGENTS) {
    const why = await bootstrap(deps, label);
    if (why) failed.push(why);
  }
  return failed;
}

/**
 * `factory:start`: starts both LaunchAgents, the daemon and the UI. One that `factory:stop` (or a
 * failed update) booted out is loaded again; one that is loaded but not running is kickstarted,
 * and one already running is left alone.
 */
export async function startFactory(deps: AgentDeps): Promise<number> {
  const failed: string[] = [];
  for (const [label, command] of ALL_AGENTS) {
    const name = command === 'ui' ? 'UI' : command;
    if (!existsSync(plistPath(deps.home, label))) {
      failed.push(`there is no ${plistPath(deps.home, label)}: run task factory:install`);
      continue;
    }
    if (await isLoaded(deps, label)) {
      const r = await deps.exec('launchctl', ['kickstart', service(deps, label)]);
      if (r.code !== 0) failed.push(`launchctl kickstart ${label} failed: ${r.stderr.trim()}`);
      else deps.log(`The ${name} is running.`);
      continue;
    }
    const why = await bootstrap(deps, label);
    if (why) failed.push(why);
    else deps.log(`Started the ${name}.`);
  }
  for (const why of failed) deps.log(why);
  return failed.length > 0 ? 1 : 0;
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
  const updater = await ensureUpdater(deps);
  if (updater) failed.push(updater);
  if (failed.length > 0) {
    for (const why of failed) deps.log(why);
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
  /** The daemon's status, as `status.json` holds it. */
  readonly status?: () => DaemonStatus | undefined;
}

/** The daemon's pid from its lock, if it is alive. */
export function liveDaemon(
  config: FactoryConfig,
  alive: (pid: number) => boolean,
): number | undefined {
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
    ...(status?.running ?? [])
      // A run asleep on a usage limit can wait hours; the update stops it and recovery resumes it.
      .filter((r) => !r.waitingFor?.reason.startsWith(USAGE_LIMIT_WAIT))
      .map((r) => `${issueKey(config, r.issue)} on slot ${r.slot}`),
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
    const restarted = deps.now();
    const failed = await startAgents(deps);
    const updater = await ensureUpdater(deps);
    if (updater) failed.push(updater);
    if (failed.length > 0) {
      for (const why of failed) deps.log(why);
      return 1;
    }
    deps.log('The daemon and the UI restarted.');
    return (await firstPoll(config, deps, status, restarted)) ? code : 1;
  } finally {
    rmSync(pause, { force: true });
  }
}

/**
 * Waits (bounded) for the restarted daemon's first status.json and prints it, so the update ends
 * with what is really running rather than the old daemon's last poll. False if none came: the
 * daemon exited on startup (launchd starts it again within 30 s) or hasn't polled yet.
 */
async function firstPoll(
  config: FactoryConfig,
  deps: UpdateDeps,
  status: () => DaemonStatus | undefined,
  restarted: Date,
): Promise<boolean> {
  // Its first poll reads the board and runs the janitor, so allow two intervals and a minute.
  const bound = (config.pollSeconds * 2 + 60) * 1000;
  for (;;) {
    const s = status();
    if (s && Date.parse(s.updatedAt) >= restarted.getTime() && deps.alive(s.pid)) {
      for (const line of formatStatus(s, config, codeDir(config), deps.now(), deps.alive))
        deps.log(line);
      return true;
    }
    if (deps.now().getTime() - restarted.getTime() >= bound) break;
    await deps.sleep(2000);
  }
  deps.log(
    `The new daemon hasn't reported within ${Math.round(bound / 1000)} s of its restart: see task factory:logs, and task factory:status.`,
  );
  return false;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
