import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { codeDir, pausePath, type UpdateDeps } from '../src/code.ts';
import { nodeExec } from '../src/exec.ts';
import { checkOnce, pendingUpdate, RESTART, runUpdater } from '../src/updater.ts';
import { testConfig } from './helpers.ts';

const git = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    encoding: 'utf8',
  });

function commit(dir: string, files: Record<string, string>, message: string) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', message);
  git(dir, 'push', '-q', 'origin', 'HEAD:main');
}

/** main on a bare origin, the factory's code checkout cloned from it, and a clone to push from. */
function repos() {
  const root = mkdtempSync(join(tmpdir(), 'factory-updater-'));
  const config = { ...testConfig(), stateDir: join(root, 'state'), autoUpdateMinutes: 5 };
  const origin = join(root, 'origin.git');
  const work = join(root, 'work');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', '-q', origin, work]);
  commit(work, { 'tools/factory/src/a.ts': '1\n', 'apps/web/x.ts': '1\n' }, 'start');
  mkdirSync(config.stateDir, { recursive: true });
  // The daemon is running (deps' alive says pid 4242 is).
  writeFileSync(join(config.stateDir, 'daemon.lock'), '4242');
  execFileSync('git', ['clone', '-q', origin, codeDir(config)]);
  return { config, work };
}

function deps(lines: string[]): UpdateDeps {
  return {
    exec: nodeExec,
    home: '/h',
    uid: '501',
    node: '/n/node',
    log: (l) => lines.push(l),
    sleep: () => Promise.resolve(),
    pid: 9999,
    alive: (pid) => pid === 9999 || pid === 4242,
    now: () => new Date(),
  };
}

describe('the updater (A1293)', { timeout: 30_000 }, () => {
  it("names only main's changes to what the factory runs", async () => {
    const { config, work } = repos();
    commit(work, { 'apps/web/x.ts': '2\n' }, 'the app');
    expect((await pendingUpdate(nodeExec, codeDir(config))).files).toEqual([]);
    commit(work, { 'tools/factory/src/a.ts': '2\n', 'scripts/vm/desktop-test.sh': 'x\n' }, 'f');
    expect((await pendingUpdate(nodeExec, codeDir(config))).files).toEqual([
      'scripts/vm/desktop-test.sh',
      'tools/factory/src/a.ts',
    ]);
  });

  it('updates when main changes the factory, then exits for launchd to restart it', async () => {
    const { config, work } = repos();
    const lines: string[] = [];
    const updates: boolean[] = [];
    const update = (_c: unknown, _d: unknown, options: { wait: boolean }) => {
      updates.push(options.wait);
      return Promise.resolve(0);
    };
    expect(await checkOnce(config, deps(lines), update)).toBeUndefined();
    commit(work, { 'tools/factory/src/a.ts': '2\n' }, 'factory change');
    expect(await checkOnce(config, deps(lines), update)).toBe(RESTART);
    // It waits for the active run, as factory:update -- --wait does.
    expect(updates).toEqual([true]);
    expect(lines[0]).toContain('changes the factory (tools/factory/src/a.ts): updating.');
  });

  it("doesn't retry a main whose update failed, and tries the next one", async () => {
    const { config, work } = repos();
    const lines: string[] = [];
    let tries = 0;
    const update = () => {
      tries++;
      return Promise.resolve(1);
    };
    commit(work, { 'tools/factory/src/a.ts': '2\n' }, 'bad');
    expect(await checkOnce(config, deps(lines), update)).toBe(1);
    expect(await checkOnce(config, deps(lines), update)).toBeUndefined();
    expect(tries).toBe(1);
    expect(readFileSync(join(config.stateDir, 'auto-update.failed'), 'utf8').trim()).toBe(
      git(work, 'rev-parse', 'HEAD').trim(),
    );
    commit(work, { 'tools/factory/src/a.ts': '3\n' }, 'fixed');
    expect(await checkOnce(config, deps(lines), update)).toBe(1);
    expect(tries).toBe(2);
  });

  it('leaves it to a factory:update that is already running', async () => {
    const { config, work } = repos();
    commit(work, { 'tools/factory/src/a.ts': '2\n' }, 'factory change');
    writeFileSync(pausePath(config), JSON.stringify({ pid: 9999, at: '' }));
    const update = () => Promise.reject(new Error('should not update'));
    expect(await checkOnce(config, deps([]), update)).toBeUndefined();
  });

  it('leaves a stopped daemon stopped: an update would start it', async () => {
    const { config, work } = repos();
    commit(work, { 'tools/factory/src/a.ts': '2\n' }, 'factory change');
    writeFileSync(join(config.stateDir, 'daemon.lock'), '1');
    const update = () => Promise.reject(new Error('should not update'));
    expect(await checkOnce(config, deps([]), update)).toBeUndefined();
  });

  it('is off with autoUpdateMinutes 0, and exits cleanly so launchd leaves it stopped', async () => {
    const lines: string[] = [];
    expect(await runUpdater({ ...testConfig(), autoUpdateMinutes: 0 }, deps(lines))).toBe(0);
    expect(lines).toEqual(['Automatic updates are off (autoUpdateMinutes is 0).']);
  });
});
