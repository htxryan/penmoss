import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  codeDir,
  installAgents,
  ownCheckout,
  pausePath,
  syncCode,
  updateFactory,
  updatePending,
  type UpdateDeps,
} from '../src/code.ts';
import type { Exec, ExecOptions } from '../src/exec.ts';
import { formatStatus, type DaemonStatus } from '../src/status.ts';
import { testConfig } from './helpers.ts';

interface Call {
  readonly cmd: string;
  readonly args: readonly string[];
  readonly cwd?: string;
}

const OLD = { sha: 'a'.repeat(40), subject: 'Older main' };
const NEW = { sha: 'b'.repeat(40), subject: 'Newer main' };

/** git, corepack and launchctl, faked: the checkout moves to NEW on `checkout origin/main`. */
function fakeExec(options: { at?: typeof OLD; pnpmFails?: number; onCall?: (c: Call) => void }) {
  const calls: Call[] = [];
  let at = options.at;
  let pnpmFails = options.pnpmFails ?? 0;
  const exec: Exec = (cmd, args, opts: ExecOptions = {}) => {
    const call = { cmd, args, ...(opts.cwd ? { cwd: opts.cwd } : {}) };
    calls.push(call);
    options.onCall?.(call);
    const ok = (stdout = '') => Promise.resolve({ code: 0, stdout, stderr: '' });
    if (cmd === 'git' && args.includes('log'))
      return at
        ? ok(`${at.sha}\t${at.subject}\n`)
        : Promise.resolve({ code: 128, stdout: '', stderr: 'no' });
    if (cmd === 'git' && args[0] === 'clone') at = OLD;
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
    });
    expect(code).toBe(0);
    const dir = join(config.stateDir, 'code');
    expect(calls.map((c) => [c.cmd, ...c.args].join(' '))).toEqual([
      `git clone --quiet https://github.com/${config.repo}.git ${dir}`,
      `git -C ${dir} remote set-url --push origin no-push://the-factory-harness-pushes`,
      `git -C ${dir} fetch --quiet origin main`,
      `git -C ${dir} checkout --quiet --force --detach origin/main`,
      'corepack pnpm install --frozen-lockfile --filter ./tools/factory...',
      `git -C ${dir} log -1 --format=%H%x09%s`,
      'launchctl bootout gui/501/app.penmoss.factory',
      'launchctl bootout gui/501/app.penmoss.factory-ui',
      `launchctl bootstrap gui/501 ${home}/Library/LaunchAgents/app.penmoss.factory.plist`,
      `launchctl bootstrap gui/501 ${home}/Library/LaunchAgents/app.penmoss.factory-ui.plist`,
    ]);
    expect(calls.find((c) => c.cmd === 'corepack')?.cwd).toBe(dir);
    for (const [label, command] of [
      ['app.penmoss.factory', 'daemon'],
      ['app.penmoss.factory-ui', 'ui'],
    ] as const) {
      const strings = plistArgs(join(home, 'Library/LaunchAgents', `${label}.plist`));
      // ProgramArguments, then WorkingDirectory: the code checkout, never the installing one.
      expect(strings).toContain(join(dir, 'tools/factory/src/cli.ts'));
      expect(strings).toContain(command);
      expect(strings).toContain(dir);
      expect(strings.some((s) => s?.startsWith(ownCheckout()))).toBe(false);
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
      }),
    ).toBe(0);
    expect(calls.filter((c) => c.cmd === 'git').map((c) => c.args[2])).toEqual(['log']);
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
  ): UpdateDeps & { slept: number[] } {
    writeFileSync(join(config.stateDir, 'daemon.lock'), '4242');
    let now = T0.getTime();
    const slept: number[] = [];
    return {
      exec,
      home,
      uid: '501',
      node: '/n/node',
      log: (l) => lines.push(l),
      pid: 9999,
      alive: (pid) => pid === 9999 || (pid === 4242 && daemonAlive),
      now: () => new Date(now),
      sleep: (ms) => {
        slept.push(ms);
        now += ms;
        return Promise.resolve();
      },
      status: () => (statuses.length > 1 ? statuses.shift() : statuses[0]),
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
        `${c.cmd} ${c.args.find((a, i) => i > 0 && !a.startsWith('-') && c.args[i - 1] !== '-C') ?? c.args[0]}`,
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
    expect(calls.filter((c) => c.args[0] === 'bootstrap')).toHaveLength(2);
    expect(lines.join('\n')).toContain('Restarting on the code it had');
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

  it("says a daemon from before this change doesn't report its commit", () => {
    expect(formatStatus(base, config, '/s/code', now)[0]).toContain('commit unknown');
  });
});
