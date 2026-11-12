import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  codeDir,
  installAgents,
  ownCheckout,
  pausePath,
  startFactory,
  syncCode,
  updateFactory,
  updatePending,
  writeAgents,
  type UpdateDeps,
} from '../src/code.ts';
import { USAGE_LIMIT_WAIT } from '../src/limits.ts';
import type { Exec, ExecOptions } from '../src/exec.ts';
import { GIT_HARDENING, subcommand } from '../src/git.ts';
import { formatStatus, type DaemonStatus } from '../src/status.ts';
import { testConfig } from './helpers.ts';

interface Call {
  readonly cmd: string;
  readonly args: readonly string[];
  readonly cwd?: string;
}

const OLD = { sha: 'a'.repeat(40), subject: 'Older main' };
const NEW = { sha: 'b'.repeat(40), subject: 'Newer main' };

const IO_ERROR = 'Bootstrap failed: 5: Input/output error';

/**
 * git, corepack and launchctl, faked: the checkout moves to NEW on `checkout origin/main`, and
 * launchd keeps a booted-out service for `bootoutLag` more `print`s (bootout is asynchronous),
 * refusing to bootstrap a label while it has it, and also for its first `bootstrapFails[label]`.
 */
function fakeExec(options: {
  at?: typeof OLD;
  pnpmFails?: number;
  onCall?: (c: Call) => void;
  loaded?: string[];
  bootoutLag?: number;
  bootstrapFails?: Record<string, number>;
}) {
  const calls: Call[] = [];
  let at = options.at;
  let pnpmFails = options.pnpmFails ?? 0;
  const loaded = new Map<string, number>((options.loaded ?? []).map((l) => [l, Infinity]));
  const fails = { ...options.bootstrapFails };
  const exec: Exec = (cmd, args, opts: ExecOptions = {}) => {
    const call = { cmd, args, ...(opts.cwd ? { cwd: opts.cwd } : {}) };
    calls.push(call);
    options.onCall?.(call);
    const ok = (stdout = '') => Promise.resolve({ code: 0, stdout, stderr: '' });
    if (cmd === 'launchctl') {
      const label = (args[0] === 'bootstrap' ? args[2] : args[1])
        ?.split('/')
        .at(-1)
        ?.replace(/\.plist$/, '');
      if (!label) throw new Error(`launchctl ${args.join(' ')}`);
      const left = loaded.get(label);
      if (args[0] === 'print') {
        if (left === undefined) return Promise.resolve({ code: 113, stdout: '', stderr: '' });
        if (left <= 1) loaded.delete(label);
        else loaded.set(label, left - 1);
        return ok();
      }
      if (args[0] === 'bootout') {
        const lag = options.bootoutLag ?? 0;
        if (left === undefined || lag === 0) loaded.delete(label);
        else loaded.set(label, Math.min(left, lag));
        return ok();
      }
      if (args[0] === 'bootstrap') {
        if (left !== undefined || (fails[label] ?? 0) > 0) {
          fails[label] = (fails[label] ?? 0) - 1;
          return Promise.resolve({ code: 5, stdout: '', stderr: IO_ERROR });
        }
        loaded.set(label, Infinity);
        return ok();
      }
      return ok();
    }
    if (cmd === 'git' && args.includes('log'))
      return at
        ? ok(`${at.sha}\t${at.subject}\n`)
        : Promise.resolve({ code: 128, stdout: '', stderr: 'no' });
    if (cmd === 'git' && subcommand(args) === 'clone') at = OLD;
    if (cmd === 'git' && args.includes('checkout')) {
      const target = args.at(-1);
      at = target === 'origin/main' ? NEW : target === OLD.sha ? OLD : at;
    }
    if (cmd === 'corepack' && pnpmFails > 0) {
      pnpmFails--;
      return Promise.resolve({ code: 1, stdout: '', stderr: 'ERR_PNPM_OUTDATED_LOCKFILE' });
    }
    return ok();
  };
  return { exec, calls };
}

function setup(withCheckout: boolean) {
  const root = mkdtempSync(join(tmpdir(), 'factory-code-'));
  const config = { ...testConfig(), stateDir: join(root, 'state'), pollSeconds: 60 };
  const home = join(root, 'home');
  mkdirSync(config.stateDir, { recursive: true });
  if (withCheckout) mkdirSync(join(codeDir(config), '.git'), { recursive: true });
  return { config, home, lines: [] as string[] };
}

/**
 * A call as a command line, git's hardening (git.ts, A1230) checked and left out: every git
 * command here runs with it, and none of Ryan's config.
 */
function show(c: Call): string {
  if (c.cmd !== 'git') return [c.cmd, ...c.args].join(' ');
  expect(c.args[0]).toBe('-C');
  expect(c.args.slice(2, 2 + GIT_HARDENING.length)).toEqual([...GIT_HARDENING]);
  return ['git', '-C', c.args[1], ...c.args.slice(2 + GIT_HARDENING.length)].join(' ');
}

const plistArgs = (plist: string) =>
  [...readFileSync(plist, 'utf8').matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]);

describe('factory:install (A1226)', () => {
  it("clones the factory's own code under the state folder and points both LaunchAgents at it", async () => {
    const { config, home, lines } = setup(false);
    const { exec, calls } = fakeExec({});
    const code = await installAgents(config, {
      exec,
      home,
      uid: '501',
      node: '/n/bin/node',
      log: (l) => lines.push(l),
      sleep: () => Promise.resolve(),
    });
    expect(code).toBe(0);
    const dir = join(config.stateDir, 'code');
    expect(calls.map(show)).toEqual([
      `git -C ${config.stateDir} clone --quiet https://github.com/${config.repo}.git ${dir}`,
      `git -C ${dir} remote set-url --push origin no-push://the-factory-harness-pushes`,
      `git -C ${dir} fetch --quiet origin main`,
      `git -C ${dir} checkout --quiet --force --detach origin/main`,
      'corepack pnpm install --frozen-lockfile --filter ./tools/factory...',
      `git -C ${dir} log -1 --format=%H%x09%s`,
      'launchctl bootout gui/501/app.penmoss.factory',
      'launchctl bootout gui/501/app.penmoss.factory-ui',
      // Bootout returns before launchd is done: each label must be gone before it loads again.
      'launchctl print gui/501/app.penmoss.factory',
      'launchctl print gui/501/app.penmoss.factory-ui',
      `launchctl bootstrap gui/501 ${home}/Library/LaunchAgents/app.penmoss.factory.plist`,
      `launchctl bootstrap gui/501 ${home}/Library/LaunchAgents/app.penmoss.factory-ui.plist`,
      // The updater, loaded when launchd doesn't have it: never stopped, since it runs updates.
      'launchctl print gui/501/app.penmoss.factory-updater',
      `launchctl bootstrap gui/501 ${home}/Library/LaunchAgents/app.penmoss.factory-updater.plist`,
    ]);
    expect(calls.find((c) => c.cmd === 'corepack')?.cwd).toBe(dir);
    for (const [label, command] of [
      ['app.penmoss.factory', 'daemon'],
      ['app.penmoss.factory-ui', 'ui'],
      ['app.penmoss.factory-updater', 'updater'],
    ] as const) {
      const strings = plistArgs(join(home, 'Library/LaunchAgents', `${label}.plist`));
      // ProgramArguments, then WorkingDirectory: the code checkout, never the installing one.
      expect(strings).toContain(join(dir, 'tools/factory/src/cli.ts'));
      expect(strings).toContain(command);
      expect(strings).toContain(dir);
      expect(strings.some((s) => s?.startsWith(ownCheckout()))).toBe(false);
      // launchd starts with no shell PATH: `claude` (in ~/.local/bin) must be on the agent's own.
      const path = strings.find((s) => s?.includes('/usr/bin:'));
      expect(path?.split(':')).toContain(join(home, '.local', 'bin'));
      // One that exits on an error (lost a lock, couldn't reach GitHub) comes back by itself,
      // at most every 30 s; one stopped cleanly (SIGTERM, exit 0) stays stopped.
      const xml = readFileSync(join(home, 'Library/LaunchAgents', `${label}.plist`), 'utf8');
      expect(xml.replaceAll(/\s+/g, '')).toContain(
        '<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict><key>ThrottleInterval</key><integer>30</integer>',
      );
    }
    expect(lines.join('\n')).toContain(`at ${NEW.sha.slice(0, 7)} (${NEW.subject})`);
  });

  it('leaves an existing code checkout where it is (factory:update moves it)', async () => {
    const { config, home, lines } = setup(true);
    const { exec, calls } = fakeExec({ at: OLD });
    expect(
      await installAgents(config, {
        exec,
        home,
        uid: '501',
        node: '/n/node',
        log: (l) => lines.push(l),
        sleep: () => Promise.resolve(),
      }),
    ).toBe(0);
    expect(calls.filter((c) => c.cmd === 'git').map((c) => subcommand(c.args))).toEqual(['log']);
    expect(calls.some((c) => c.cmd === 'corepack')).toBe(false);
    expect(lines[0]).toContain(`stays at ${OLD.sha.slice(0, 7)}`);
  });
});

describe('syncCode', () => {
  it('goes back to the commit it was at when the install fails, and says so', async () => {
    const { config, lines } = setup(true);
    const { exec, calls } = fakeExec({ at: OLD, pnpmFails: 1 });
    await expect(syncCode(config, exec, (l) => lines.push(l))).rejects.toThrow(
      /corepack pnpm failed: ERR_PNPM_OUTDATED_LOCKFILE/,
    );
    const checkouts = calls.filter((c) => c.args.includes('checkout')).map((c) => c.args.at(-1));
    expect(checkouts).toEqual(['origin/main', OLD.sha]);
    expect(calls.filter((c) => c.cmd === 'corepack')).toHaveLength(2);
    expect(lines).toContain(`The install failed; going back to ${OLD.sha.slice(0, 7)}`);
  });
});

describe('factory:update (A1226)', () => {
  const T0 = new Date('2026-11-08T12:00:00Z');

  function deps(
    config: ReturnType<typeof setup>['config'],
    home: string,
    lines: string[],
    exec: Exec,
    statuses: (DaemonStatus | undefined)[],
    daemonAlive = true,
    newDaemonReports = true,
  ): UpdateDeps & { slept: number[] } {
    writeFileSync(join(config.stateDir, 'daemon.lock'), '4242');
    let now = T0.getTime();
    const slept: number[] = [];
    let restarted = false;
    return {
      exec: (cmd, args, opts) => {
        if (cmd === 'launchctl' && args[0] === 'bootstrap') restarted = true;
        return exec(cmd, args, opts);
      },
      home,
      uid: '501',
      node: '/n/node',
      log: (l) => lines.push(l),
      pid: 9999,
      alive: (pid) => pid === 9999 || pid === 5151 || (pid === 4242 && daemonAlive),
      now: () => new Date(now),
      sleep: (ms) => {
        slept.push(ms);
        now += ms;
        return Promise.resolve();
      },
      // Once the LaunchAgents are loaded again, the new daemon (5151) writes its first poll.
      status: () =>
        restarted && newDaemonReports
          ? status({
              at: now - T0.getTime(),
              pid: 5151,
              paused: false,
              code: { dir: '', commit: NEW },
            })
          : statuses.length > 1
            ? statuses.shift()
            : statuses[0],
      slept,
    };
  }

  const status = (over: Partial<DaemonStatus> & { at: number }): DaemonStatus => ({
    updatedAt: new Date(T0.getTime() + over.at).toISOString(),
    pid: 4242,
    running: [],
    merging: [],
    waiting: [],
    skipped: [],
    paused: true,
    ...over,
  });
  const busy = (at: number) =>
    status({ at, paused: false, running: [{ issue: 36, slot: 1, startedAt: '', why: 'picked' }] });

  it('refuses while a run is active, without stopping anything or keeping new work held', async () => {
    const { config, home, lines } = setup(true);
    const { exec, calls } = fakeExec({ at: OLD });
    const d = deps(config, home, lines, exec, [busy(-30_000)]);
    expect(await updateFactory(config, d, { wait: false })).toBe(1);
    expect(calls).toEqual([]);
    expect(lines.join('\n')).toMatch(/Not updating: the daemon is busy \(#36 on slot 1\)/);
    expect(existsSync(pausePath(config))).toBe(false);
  });

  it('with --wait, holds new work, waits for the runs, then stops, updates and restarts', async () => {
    const { config, home, lines } = setup(true);
    let pauseAtBootstrap: boolean | undefined;
    const { exec, calls } = fakeExec({
      at: OLD,
      onCall: (c) => {
        if (c.args[0] === 'bootstrap') pauseAtBootstrap ??= existsSync(pausePath(config));
      },
    });
    const pauseSeen: boolean[] = [];
    const statuses = [busy(-30_000), busy(5_000), status({ at: 10_000 })];
    const d = deps(config, home, lines, exec, statuses);
    const read = d.status!;
    const code = await updateFactory(
      config,
      {
        ...d,
        status: () => {
          // Until it restarts the LaunchAgents; then it reads the new daemon's first poll.
          if (!calls.some((c) => c.args[0] === 'bootstrap'))
            pauseSeen.push(updatePending(config, d.alive));
          return read();
        },
      },
      { wait: true },
    );
    expect(code).toBe(0);
    // The daemon was told to hold new work for as long as the update waited.
    expect(pauseSeen.every(Boolean)).toBe(true);
    expect(d.slept.length).toBeGreaterThanOrEqual(2);
    const steps = calls.map(
      (c) =>
        `${c.cmd} ${c.args.find((a, i) => i > 0 && !a.startsWith('-') && c.args[i - 1] !== '-C' && c.args[i - 1] !== '-c') ?? c.args[0]}`,
    );
    const first = (s: string) => steps.indexOf(s);
    expect(first('launchctl gui/501/app.penmoss.factory')).toBeLessThan(first('git fetch'));
    expect(first('git checkout')).toBeLessThan(first('corepack install'));
    expect(steps.lastIndexOf('launchctl gui/501')).toBeGreaterThan(first('corepack install'));
    // The new daemon must not start held.
    expect(pauseAtBootstrap).toBe(false);
    expect(lines).toContain(
      `Updated ${OLD.sha.slice(0, 7)} to ${NEW.sha.slice(0, 7)} (${NEW.subject}).`,
    );
    expect(lines.filter((l) => l.startsWith('Waiting for'))).toHaveLength(1);
  });

  it("doesn't wait for a run asleep on a usage limit, which can take hours (PEN-117)", async () => {
    const { config, home, lines } = setup(true);
    const { exec, calls } = fakeExec({ at: OLD });
    const asleep = status({
      at: 5_000,
      running: [
        {
          issue: 117,
          slot: 1,
          startedAt: '',
          why: 'picked',
          waitingFor: { reason: `${USAGE_LIMIT_WAIT} at 2026-11-12T06:18:00.000Z`, since: '' },
        },
      ],
    });
    const d = deps(config, home, lines, exec, [asleep]);
    expect(await updateFactory(config, d, { wait: false })).toBe(0);
    expect(calls.some((c) => c.args.includes('fetch'))).toBe(true);
  });

  it("waits for a poll that saw the hold: an idle status from before it isn't enough", async () => {
    const { config, home, lines } = setup(true);
    const { exec, calls } = fakeExec({ at: OLD });
    // Idle, but written before the update began; then a poll that hadn't seen the pause yet.
    const d = deps(config, home, lines, exec, [
      status({ at: -20_000, paused: false }),
      status({ at: 2_000, paused: false }),
      status({ at: 7_000 }),
    ]);
    expect(await updateFactory(config, d, { wait: false })).toBe(0);
    expect(d.slept).toHaveLength(2);
    expect(calls.some((c) => c.args.includes('fetch'))).toBe(true);
  });

  it("refuses when the daemon doesn't poll within three intervals", async () => {
    const { config, home, lines } = setup(true);
    const { exec, calls } = fakeExec({ at: OLD });
    const d = deps(config, home, lines, exec, [status({ at: -20_000, paused: false })]);
    expect(await updateFactory(config, d, { wait: false })).toBe(1);
    expect(calls).toEqual([]);
    expect(lines.join('\n')).toContain('has not polled since');
  });

  it('goes straight ahead when the daemon is stopped', async () => {
    const { config, home, lines } = setup(true);
    const { exec } = fakeExec({ at: OLD });
    const d = deps(config, home, lines, exec, [busy(-600_000)], false);
    expect(await updateFactory(config, d, { wait: false })).toBe(0);
    expect(d.slept).toEqual([]);
  });

  it('restarts on the code it had when the update fails', async () => {
    const { config, home, lines } = setup(true);
    const { exec, calls } = fakeExec({ at: OLD, pnpmFails: 1 });
    const d = deps(config, home, lines, exec, [], false);
    expect(await updateFactory(config, d, { wait: false })).toBe(1);
    // The daemon, the UI, and the updater, which this factory didn't have loaded yet.
    expect(calls.filter((c) => c.args[0] === 'bootstrap')).toHaveLength(3);
    expect(lines.join('\n')).toContain('Restarting on the code it had');
  });

  it("waits out launchd's bootout and retries a bootstrap that fails with I/O error 5", async () => {
    const { config, home, lines } = setup(true);
    // launchd still has both for three checks after bootout, and refuses the daemon twice more.
    const { exec, calls } = fakeExec({
      at: OLD,
      loaded: ['app.penmoss.factory', 'app.penmoss.factory-ui'],
      bootoutLag: 3,
      bootstrapFails: { 'app.penmoss.factory': 2 },
    });
    const d = deps(config, home, lines, exec, [], false);
    expect(await updateFactory(config, d, { wait: false })).toBe(0);
    // No bootstrap before launchd let go of the old services: three "still there", then gone.
    const before = calls.slice(
      0,
      calls.findIndex((c) => c.args[0] === 'bootstrap'),
    );
    for (const label of ['app.penmoss.factory', 'app.penmoss.factory-ui'])
      expect(
        before.filter((c) => c.args[0] === 'print' && c.args[1] === `gui/501/${label}`),
      ).toHaveLength(4);
    expect(calls.filter((c) => c.args[0] === 'bootstrap').map((c) => c.args[2])).toEqual([
      `${home}/Library/LaunchAgents/app.penmoss.factory.plist`,
      `${home}/Library/LaunchAgents/app.penmoss.factory.plist`,
      `${home}/Library/LaunchAgents/app.penmoss.factory.plist`,
      `${home}/Library/LaunchAgents/app.penmoss.factory-ui.plist`,
      `${home}/Library/LaunchAgents/app.penmoss.factory-updater.plist`,
    ]);
    expect(lines.filter((l) => l.includes('trying again'))).toHaveLength(2);
    // It ends with the new daemon's own first poll, not the old one's status.
    expect(lines).toContain('The daemon and the UI restarted.');
    expect(lines.join('\n')).toContain(`Daemon 5151 at ${NEW.sha.slice(0, 7)} (${NEW.subject})`);
  });

  it("starts the UI even when the daemon's bootstrap keeps failing, and names the one that did", async () => {
    const { config, home, lines } = setup(true);
    const { exec, calls } = fakeExec({ at: OLD, bootstrapFails: { 'app.penmoss.factory': 99 } });
    const d = deps(config, home, lines, exec, [], false);
    expect(await updateFactory(config, d, { wait: false })).toBe(1);
    const tried = calls.filter((c) => c.args[0] === 'bootstrap').map((c) => c.args[2]);
    expect(tried.filter((p) => p?.endsWith('factory.plist'))).toHaveLength(4);
    expect(tried.at(-2)).toBe(`${home}/Library/LaunchAgents/app.penmoss.factory-ui.plist`);
    expect(lines).toContain(`launchctl bootstrap app.penmoss.factory failed 4 times: ${IO_ERROR}`);
  });

  it("says so, and fails, when the new daemon doesn't report within its bound", async () => {
    const { config, home, lines } = setup(true);
    const { exec } = fakeExec({ at: OLD });
    const d = deps(config, home, lines, exec, [busy(-600_000)], false, false);
    expect(await updateFactory(config, d, { wait: false })).toBe(1);
    // Two intervals and a minute: 180 s for a 60 s poll, in 2 s steps.
    expect(d.slept.reduce((a, b) => a + b, 0)).toBe(180_000);
    expect(lines.at(-1)).toBe(
      "The new daemon hasn't reported within 180 s of its restart: see task factory:logs, and task factory:status.",
    );
  });

  it('leaves a loaded updater alone: it is the one running the update', async () => {
    const { config, home, lines } = setup(true);
    const { exec, calls } = fakeExec({ at: OLD, loaded: ['app.penmoss.factory-updater'] });
    expect(
      await updateFactory(config, deps(config, home, lines, exec, [], false), { wait: false }),
    ).toBe(0);
    expect(
      calls.some((c) => c.args.at(-1)?.includes('factory-updater') && c.args[0] !== 'print'),
    ).toBe(false);
  });

  it('needs factory:install first', async () => {
    const { config, home, lines } = setup(false);
    const { exec, calls } = fakeExec({});
    expect(await updateFactory(config, deps(config, home, lines, exec, []), { wait: true })).toBe(
      1,
    );
    expect(calls).toEqual([]);
    expect(lines[0]).toContain('task factory:install first');
  });
});

describe('factory:start', () => {
  it('loads the booted-out daemon, kickstarts the loaded UI, and handles both', async () => {
    const { config, home, lines } = setup(true);
    const agents = { exec: fakeExec({}).exec, home, uid: '501', node: '/n/node' };
    writeAgents(config, { ...agents, log: () => {}, sleep: () => Promise.resolve() });
    const { exec, calls } = fakeExec({
      loaded: ['app.penmoss.factory-ui'],
      bootstrapFails: { 'app.penmoss.factory': 1 },
    });
    const code = await startFactory({
      ...agents,
      exec,
      log: (l) => lines.push(l),
      sleep: () => Promise.resolve(),
    });
    expect(code).toBe(0);
    expect(calls.map((c) => `${c.args[0]} ${c.args.at(-1)?.split('/').at(-1)}`)).toEqual([
      'print app.penmoss.factory',
      'bootstrap app.penmoss.factory.plist',
      'bootout app.penmoss.factory',
      'print app.penmoss.factory',
      'bootstrap app.penmoss.factory.plist',
      'print app.penmoss.factory-ui',
      // Without -k: a running UI is left alone, a loaded one that isn't running starts.
      'kickstart app.penmoss.factory-ui',
      'print app.penmoss.factory-updater',
      'bootstrap app.penmoss.factory-updater.plist',
    ]);
    expect(lines).toContain('Started the daemon.');
    expect(lines).toContain('The UI is running.');
    expect(lines).toContain('Started the updater.');
  });

  it('says to install when there is no plist', async () => {
    const { home, lines } = setup(true);
    const { exec, calls } = fakeExec({});
    const code = await startFactory({
      exec,
      home,
      uid: '501',
      node: '/n/node',
      log: (l) => lines.push(l),
      sleep: () => Promise.resolve(),
    });
    expect(code).toBe(1);
    expect(calls).toEqual([]);
    expect(lines.join('\n')).toContain('run task factory:install');
  });
});

describe('updatePending', () => {
  it('holds the daemon only while the update that asked is alive', () => {
    const { config } = setup(true);
    expect(updatePending(config, () => true)).toBe(false);
    writeFileSync(pausePath(config), JSON.stringify({ pid: 77, at: '' }));
    expect(updatePending(config, (pid) => pid === 77)).toBe(true);
    // A crashed update's pause never holds the daemon for good.
    expect(updatePending(config, () => false)).toBe(false);
  });
});

describe('formatStatus', () => {
  const config = testConfig();
  const base: DaemonStatus = {
    updatedAt: '2026-11-08T12:00:00Z',
    pid: 4242,
    running: [],
    waiting: [],
    skipped: [],
  };
  const now = new Date('2026-11-08T12:00:10Z');

  it('names the commit the daemon runs', () => {
    const lines = formatStatus(
      { ...base, code: { dir: '/s/code', commit: NEW } },
      config,
      '/s/code',
      now,
    );
    expect(lines[0]).toBe(`Daemon 4242 at bbbbbbb (Newer main), last poll 10 s ago.`);
    expect(lines.join('\n')).not.toContain('factory:install');
  });

  it("says when the daemon runs from somewhere other than the factory's own checkout", () => {
    const lines = formatStatus(
      { ...base, paused: true, code: { dir: '/Users/r/src/penmoss', commit: OLD } },
      config,
      '/s/code',
      now,
    ).join('\n');
    expect(lines).toContain(
      "runs from /Users/r/src/penmoss, not the factory's own checkout /s/code",
    );
    expect(lines).toContain('paused: task factory:update is waiting');
  });

  it("says when the status is that of a daemon that isn't running any more", () => {
    // Right after factory:update, or a crash, status.json is still the old daemon's last poll.
    const lines = formatStatus(
      { ...base, paused: true, code: { dir: '/s/code', commit: OLD } },
      config,
      '/s/code',
      now,
      (pid) => pid !== 4242,
    );
    expect(lines[0]).toBe(
      'Daemon 4242 at aaaaaaa (Older main) is not running: below is its last status, from 10 s ago. task factory:start starts it; task factory:logs says why it stopped.',
    );
    expect(formatStatus(base, config, '/s/code', now, () => true)[0]).not.toContain('not running');
  });

  it("says a daemon from before this change doesn't report its commit", () => {
    expect(formatStatus(base, config, '/s/code', now)[0]).toContain('commit unknown');
  });
});
