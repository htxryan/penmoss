/**
 * A run's sandbox starts from the main the host just fetched into the publish repo, not from
 * wherever the last gate left the runs' clone (A1232). With a fake Sandcastle: the first
 * command in a sandbox the host opens fetches main and puts the branch on that base. With real
 * git: that command moves a new branch made from a stale main onto the base, and leaves a branch
 * with commits of its own where it is. Nothing planted here runs a command.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FactoryConfig } from '../src/config.ts';
import { nodeExec, type Exec } from '../src/exec.ts';
import { hostDeps, repoDir, sandboxStartCommand, type HostOptions } from '../src/host.ts';
import { testConfig } from './helpers.ts';

const MAIN_SHA = 'b'.repeat(40);
const RUN_SHA = 'c'.repeat(40);
const BRANCH = 'factory/75-fix-the-sidebar';

const sandcastle = vi.hoisted(() => ({
  commands: [] as string[],
  exitCode: 0,
  closed: 0,
  created: [] as Record<string, unknown>[],
}));

vi.mock('@ai-hero/sandcastle', () => ({
  createSandbox: (opts: Record<string, unknown>) => {
    sandcastle.created.push(opts);
    return Promise.resolve({
      worktreePath: '/state/repo/.sandcastle/worktrees/factory-75-fix-the-sidebar',
      exec: (command: string) => {
        sandcastle.commands.push(command);
        return Promise.resolve({
          exitCode: sandcastle.exitCode,
          stdout: '',
          stderr: sandcastle.exitCode ? 'fatal: could not read from remote' : '',
        });
      },
      close: () => {
        sandcastle.closed++;
        return Promise.resolve();
      },
    });
  },
}));

vi.mock('../src/sandbox.ts', async (original) => ({
  ...(await original<typeof import('../src/sandbox.ts')>()),
  sandboxSpec: () => ({ env: {}, mounts: [], ownDirs: [] }),
  seatbeltProvider: () => Promise.resolve({}),
}));

function options(config: FactoryConfig, exec: Exec): HostOptions {
  const slot = config.slots[0];
  if (!slot) throw new Error('the config has no slot');
  return {
    config,
    slot,
    runId: '75-test',
    board: { items: [] },
    gh: {} as never,
    tracker: {} as never,
    exec,
    secrets: {},
    pushToken: () => Promise.resolve('the-write-token'),
    sandboxToken: () => Promise.resolve('the-read-token'),
    proofStore: {} as never,
    agent: {} as never,
    log: () => undefined,
  };
}

/** Host git answered with main's commit for main and the run's for anything else. */
function fakeExec(): { exec: Exec; git: string[] } {
  const git: string[] = [];
  const exec: Exec = (cmd, args) => {
    if (cmd === 'git') git.push(args.join(' '));
    const main = args.some((a) => a.startsWith('refs/remotes/origin/main'));
    return Promise.resolve({ code: 0, stdout: `${main ? MAIN_SHA : RUN_SHA}\n`, stderr: '' });
  };
  return { exec, git };
}

describe("a run's sandbox starts from the host's main (A1232)", () => {
  let config: FactoryConfig;

  beforeEach(() => {
    sandcastle.commands.length = 0;
    sandcastle.created.length = 0;
    sandcastle.exitCode = 0;
    sandcastle.closed = 0;
    config = { ...testConfig(), stateDir: mkdtempSync(join(tmpdir(), 'factory-work-')) };
  });

  it('first fetches main and puts a new branch on the base the host fetched into the publish repo', async () => {
    const { exec, git } = fakeExec();
    const deps = hostDeps(options(config, exec));
    const work = await deps.openSandbox(BRANCH);
    // The host fetched main into the publish repo, never into the clone.
    const publish = join(config.stateDir, 'publish');
    expect(git.some((l) => l.includes(`-C ${publish}`) && l.includes('fetch'))).toBe(true);
    expect(git.some((l) => l.includes(`-C ${repoDir(config)}`))).toBe(false);
    expect(sandcastle.commands[0]).toBe(sandboxStartCommand(MAIN_SHA));
    expect(sandcastle.commands[0]).toContain('fetch --quiet --no-tags origin main');
    expect(sandcastle.commands[0]).toContain(`update-ref refs/remotes/origin/main ${MAIN_SHA}`);
    expect(sandcastle.commands[0]).toContain(`merge --ff-only --quiet ${MAIN_SHA}`);
    expect(sandcastle.created[0]).toMatchObject({ branch: BRANCH, cwd: repoDir(config) });
    await work.exec('git status');
    expect(sandcastle.commands).toEqual([sandboxStartCommand(MAIN_SHA), 'git status']);
  });

  it('starts from the main the run last fetched, as the gate does', async () => {
    const { exec } = fakeExec();
    const deps = hostDeps(options(config, exec));
    await deps.fetchMain();
    await deps.openSandbox(BRANCH);
    await deps.openSandbox(BRANCH);
    expect(sandcastle.commands).toEqual([
      sandboxStartCommand(MAIN_SHA),
      sandboxStartCommand(MAIN_SHA),
    ]);
  });

  it("closes the sandbox and stops when it can't fetch main", async () => {
    const { exec } = fakeExec();
    sandcastle.exitCode = 128;
    const deps = hostDeps(options(config, exec));
    await expect(deps.openSandbox(BRANCH)).rejects.toThrow(
      /couldn't start from main's bbbbbbbbbb: fatal: could not read from remote/,
    );
    expect(sandcastle.closed).toBe(1);
  });

  it('refuses a base that is not a commit', () => {
    expect(() => sandboxStartCommand('main; touch x')).toThrow(/not a commit/);
  });
});

// Real git: a bare repository stands in for GitHub; the runs' clone is cloned from it and then
// falls behind, as it does between gates.
const env: Record<string, string> = {
  PATH: process.env['PATH'] ?? '/usr/bin:/bin',
  HOME: tmpdir(),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'factory',
  GIT_AUTHOR_EMAIL: 'factory@example.com',
  GIT_COMMITTER_NAME: 'factory',
  GIT_COMMITTER_EMAIL: 'factory@example.com',
};

async function git(dir: string, ...args: string[]): Promise<string> {
  const r = await nodeExec('git', ['-C', dir, ...args], { env });
  if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

// Real git in temp repos, which a loaded Mac (W12) can stretch past vitest's 5 s default.
describe('the start command, with real git (A1232)', { timeout: 30_000 }, () => {
  let root: string;
  let clone: string;
  let worktree: string;
  let stale: string;
  let base: string;

  /** Runs the command in the worktree, as the sandbox does, with the read-only token. */
  const start = async (command: string) => {
    const r = await nodeExec('sh', ['-c', command], {
      cwd: worktree,
      env: { ...env, GH_TOKEN: 'the-read-token' },
    });
    if (r.code !== 0) throw new Error(`${command}: ${r.stderr}`);
  };

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'factory-start-'));
    const github = join(root, 'github.git');
    const seed = join(root, 'seed');
    clone = join(root, 'repo');
    worktree = join(clone, '.sandcastle', 'worktrees', 'factory-75-fix-the-sidebar');
    await git(root, 'init', '-q', '--bare', '-b', 'main', github);
    await git(root, 'init', '-q', '-b', 'main', seed);
    await git(seed, 'commit', '-q', '--allow-empty', '-m', 'main, as the last gate left it');
    await git(seed, 'push', '-q', `file://${github}`, 'main');
    await git(root, 'clone', '-q', `file://${github}`, clone);
    stale = await git(clone, 'rev-parse', 'origin/main');
    // A fix merges before the run starts; the host fetches it into the publish repo.
    mkdirSync(join(seed, 'docs'), { recursive: true });
    writeFileSync(join(seed, 'docs', 'fix.md'), 'The fix.\n');
    await git(seed, 'add', '-A');
    await git(seed, 'commit', '-q', '-m', 'the fix');
    await git(seed, 'push', '-q', `file://${github}`, 'main');
    base = await git(seed, 'rev-parse', 'HEAD');
  });

  it("moves a new branch Sandcastle made from the clone's stale main onto the base", async () => {
    // What Sandcastle does for a branch that doesn't exist yet.
    await git(clone, 'worktree', 'add', '-q', '-b', BRANCH, worktree, 'origin/main');
    expect(await git(worktree, 'rev-parse', 'HEAD')).toBe(stale);
    await start(sandboxStartCommand(base));
    expect(await git(worktree, 'rev-parse', 'HEAD')).toBe(base);
    expect(await git(clone, 'rev-parse', BRANCH)).toBe(base);
    expect(await git(clone, 'rev-parse', 'origin/main')).toBe(base);
    expect(await git(worktree, 'status', '--porcelain')).toBe('');
  });

  it("keeps a restarted run's branch commits where they are (R12)", async () => {
    await git(clone, 'worktree', 'add', '-q', '-b', BRANCH, worktree, 'origin/main');
    await git(worktree, 'commit', '-q', '--allow-empty', '-m', "the agent's work");
    const work = await git(worktree, 'rev-parse', 'HEAD');
    await start(sandboxStartCommand(base));
    expect(await git(worktree, 'rev-parse', 'HEAD')).toBe(work);
    expect(await git(worktree, 'log', '-1', '--format=%s')).toBe("the agent's work");
    // main is still put at the base, for the gate's rebase.
    expect(await git(clone, 'rev-parse', 'origin/main')).toBe(base);
  });
});
