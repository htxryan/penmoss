/**
 * The host's git never reads what a sandbox can write (A1230). Structurally, with a fake
 * `exec`: every host git command is hardened (no global or system config, no hooks, fsmonitor or
 * credential helper of the repo's), and none runs in the runs' clone or a worktree. With real git
 * in temp repositories: settings planted in the runs' clone, directly or through a top-level
 * `commondir`, can't send a push anywhere but the intended repository, and a branch that doesn't
 * descend from the main the run was given is never pushed. Nothing planted here runs a command:
 * the plants are URL rewrites and push URLs that point at a decoy bare repository.
 */
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { codeDir, commitOf, ownCheckout, syncCode } from '../src/code.ts';
import type { FactoryConfig } from '../src/config.ts';
import { nodeExec, type Exec, type ExecOptions } from '../src/exec.ts';
import { GIT_HARDENING, TOKEN_HELPER } from '../src/git.ts';
import { ensureClone, hostDeps, repoDir, type HostOptions } from '../src/host.ts';
import { sweep } from '../src/janitor.ts';
import { prepareSnapshot, planFiles } from '../src/planning-host.ts';
import { checkMacVm, runMacProof } from '../src/proof/mac.ts';
import type { RunSandbox } from '../src/run.ts';
import { testConfig } from './helpers.ts';

const BRANCH = 'factory/42-fix-the-typo';
const MAIN_SHA = 'b'.repeat(40);
const RUN_SHA = 'c'.repeat(40);

function options(config: FactoryConfig, exec: Exec): HostOptions {
  const slot = config.slots[0];
  if (!slot) throw new Error('the config has no slot');
  return {
    config,
    slot,
    runId: '42-test',
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

interface Call {
  readonly cmd: string;
  readonly args: readonly string[];
  readonly options: ExecOptions | undefined;
}

/** git answered by subcommand, everything else with success; every call kept. */
function fakeExec() {
  const calls: Call[] = [];
  const exec: Exec = (cmd, args, opts) => {
    calls.push({ cmd, args, options: opts });
    const ok = (stdout = '') => Promise.resolve({ code: 0, stdout, stderr: '' });
    if (cmd !== 'git') return ok();
    if (args.includes('rev-parse'))
      return ok(
        `${args.some((a) => a.startsWith('refs/remotes/origin/main')) ? MAIN_SHA : RUN_SHA}\n`,
      );
    if (args.includes('diff')) return ok('docs/a.md\n');
    if (args.includes('rev-list')) return ok('1\n');
    if (args.includes('log')) return ok(`${MAIN_SHA}\tmain\n`);
    return ok();
  };
  return { exec, calls };
}

const within = (path: string, dir: string) => {
  const rel = relative(dir, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

/** Every git call hardened, and none in the runs' clone (its worktrees are inside it). */
function expectHardened(calls: readonly Call[], clone: string) {
  const git = calls.filter((c) => c.cmd === 'git');
  expect(git.length).toBeGreaterThan(0);
  for (const call of git) {
    const line = call.args.join(' ');
    expect(call.args[0], line).toBe('-C');
    expect(within(call.args[1] ?? '', clone), `git -C ${call.args[1]}: ${line}`).toBe(false);
    if (call.options?.cwd) expect(within(call.options.cwd, clone), line).toBe(false);
    expect(call.args.slice(2, 2 + GIT_HARDENING.length), line).toEqual([...GIT_HARDENING]);
    expect(call.options?.env, line).toMatchObject({
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
    });
    const rest = call.args.slice(2 + GIT_HARDENING.length);
    if (call.options?.env?.['GH_TOKEN'] !== undefined)
      expect(rest.slice(0, TOKEN_HELPER.length), line).toEqual([...TOKEN_HELPER]);
    else
      expect(
        rest.some((a) => a.startsWith('credential.helper=!')),
        line,
      ).toBe(false);
  }
}

describe("the host's git, structurally (A1230)", () => {
  let config: FactoryConfig;
  let clone: string;
  let worktree: string;

  beforeEach(() => {
    const root = mkdtempSync(join(tmpdir(), 'factory-hostgit-'));
    config = { ...testConfig(), stateDir: join(root, 'state') };
    clone = repoDir(config);
    mkdirSync(join(clone, '.git'), { recursive: true });
    writeFileSync(join(clone, '.git', 'config'), '');
    worktree = join(clone, '.sandcastle', 'worktrees', 'factory-42-fix-the-typo');
    mkdirSync(join(worktree, 'docs'), { recursive: true });
    writeFileSync(join(worktree, 'docs', 'decisions.md'), '| A-NEW-1 | A new decision. |\n');
  });

  const sandbox = (commands: string[]): RunSandbox => ({
    worktreePath: worktree,
    exec: (command) => {
      commands.push(command);
      return Promise.resolve({
        exitCode: 0,
        stdout: command.startsWith('git grep') ? 'docs/decisions.md\n' : '',
        stderr: '',
      });
    },
    close: () => Promise.resolve(),
  });

  it('runs every git command of a run hardened, in the publish repo, never in the clone or a worktree', async () => {
    const { exec, calls } = fakeExec();
    await ensureClone(config, exec, { name: 'app[bot]', email: 'app@example.com' });
    const deps = hostDeps(options(config, exec));
    const commands: string[] = [];
    await deps.fetchMain();
    await deps.diff(BRANCH);
    await deps.rebase(sandbox(commands));
    await deps.numberDecisions(sandbox(commands), BRANCH);
    await deps.behindMain(BRANCH);
    await deps.push(BRANCH);
    await deps.headSha(BRANCH);
    expectHardened(calls, clone);
    const lines = calls.map((c) => c.args.join(' '));
    // The run's branch is read from the clone by a fetch in the publish repo, and pushed from there.
    const publish = join(config.stateDir, 'publish');
    expect(lines).toContainEqual(expect.stringContaining(`-C ${publish}`));
    expect(
      lines.some((l) =>
        l.includes(
          `fetch --quiet --no-tags --no-recurse-submodules --no-write-fetch-head ${clone} +refs/heads/${BRANCH}:refs/factory/42-test`,
        ),
      ),
    ).toBe(true);
    expect(lines.some((l) => l.includes(`merge-base --is-ancestor ${MAIN_SHA} ${RUN_SHA}`))).toBe(
      true,
    );
    const push = calls.find((c) => c.args.includes('push'));
    expect(push?.options?.env?.['GH_TOKEN']).toBe('the-write-token');
    // The clone's config is written as a file, from outside it.
    expect(
      lines.some((l) =>
        l.includes(
          `config --file ${join(clone, '.git', 'config')} --replace-all remote.origin.pushurl`,
        ),
      ),
    ).toBe(true);
    // The gate sandbox fetches main into the clone itself, put at the host's base.
    expect(
      commands.some(
        (c) =>
          c.includes('fetch --quiet --no-tags origin main') &&
          c.endsWith(`update-ref refs/remotes/origin/main ${MAIN_SHA}`),
      ),
    ).toBe(true);
  });

  it('makes the planning snapshot from the publish repo, and the janitor runs no git at all', async () => {
    const { exec, calls } = fakeExec();
    await prepareSnapshot(config, planFiles(config, 42), exec);
    expectHardened(calls, clone);
    expect(calls.find((c) => c.cmd === 'git')?.args).toContain('archive');
    const before = calls.length;
    await sweep(config, exec, new Set(), () => undefined);
    expect(calls.length).toBe(before);
  });

  it("runs the code checkout's git hardened too", async () => {
    const { exec, calls } = fakeExec();
    await syncCode(config, exec, () => undefined);
    await commitOf(exec, codeDir(config));
    expectHardened(calls, clone);
  });

  it("runs the factory's own VM script, never the worktree's, naming the worktree in PENMOSS_VM_ROOT", async () => {
    const { exec, calls } = fakeExec();
    await checkMacVm(exec, config, worktree);
    await runMacProof(exec, config, worktree, ['test/e2e/a.spec.ts']);
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.args[0]).toBe(join(ownCheckout(), 'scripts', 'vm', 'desktop-test.sh'));
      expect(call.options?.cwd).toBe(ownCheckout());
      expect(call.options?.env?.['PENMOSS_VM_ROOT']).toBe(worktree);
    }
  });
});

// Real git: a bare repository stands in for GitHub, mapped to its https URL in the publish repo's
// own config, and a second bare repository is the decoy a planted setting points at.
const testEnv: Record<string, string> = {
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
  const r = await nodeExec('git', ['-C', dir, ...args], { env: testEnv });
  if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

describe("the host's publish path, with real git (A1230)", () => {
  let root: string;
  let config: FactoryConfig;
  let github: string;
  let decoy: string;
  let clone: string;
  let https: string;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'factory-publish-'));
    config = { ...testConfig(), stateDir: join(root, 'state') };
    https = `https://github.com/${config.repo}.git`;
    github = join(root, 'github.git');
    decoy = join(root, 'decoy.git');
    clone = repoDir(config);
    await git(root, 'init', '-q', '--bare', '-b', 'main', github);
    await git(root, 'init', '-q', '--bare', '-b', 'main', decoy);
    const seed = join(root, 'seed');
    await git(root, 'init', '-q', '-b', 'main', seed);
    await git(seed, 'commit', '-q', '--allow-empty', '-m', 'main');
    await git(seed, 'push', '-q', `file://${github}`, 'main');
    // The runs' clone, as ensureClone makes it, and the publish repo's stand-in for GitHub.
    await git(root, 'clone', '-q', `file://${github}`, clone);
    const publish = join(config.stateDir, 'publish');
    await git(root, 'init', '-q', '--bare', publish);
    await git(publish, 'config', `url.file://${github}.insteadOf`, https);
    await ensureClone(config, nodeExec);
    // The agent's work, committed in its sandbox.
    await git(clone, 'checkout', '-q', '-b', BRANCH);
    await git(clone, 'commit', '-q', '--allow-empty', '-m', 'the agent');
  });

  const refs = (repo: string) => git(repo, 'for-each-ref', '--format=%(refname)');

  /** Settings that would send a push from the clone to the decoy, in a git config file. */
  const plantDecoy = async (gitDir: string) => {
    const file = join(gitDir, 'config');
    await git(root, 'config', '--file', file, `url.file://${decoy}.insteadOf`, https);
    await git(root, 'config', '--file', file, 'remote.origin.pushurl', `file://${decoy}`);
  };

  const publish = async (branch: string) => {
    const deps = hostDeps(options(config, nodeExec));
    await deps.fetchMain();
    await deps.push(branch);
  };

  it("pushes to GitHub, not where the clone's own config points", async () => {
    await plantDecoy(join(clone, '.git'));
    await publish(BRANCH);
    expect(await git(github, 'rev-parse', `refs/heads/${BRANCH}`)).toBe(
      await git(clone, 'rev-parse', BRANCH),
    );
    expect(await refs(decoy)).toBe('');
  });

  it('pushes to GitHub when a commondir at the top of .git points git at a config elsewhere', async () => {
    // A copy of the clone's .git with the decoy's settings, and the clone's .git sent to it.
    const elsewhere = join(root, 'elsewhere');
    cpSync(join(clone, '.git'), elsewhere, { recursive: true });
    await plantDecoy(elsewhere);
    writeFileSync(join(clone, '.git', 'commondir'), `${elsewhere}\n`);
    await publish(BRANCH);
    expect(await git(github, 'rev-parse', `refs/heads/${BRANCH}`)).toBe(
      await git(elsewhere, 'rev-parse', BRANCH),
    );
    expect(await refs(decoy)).toBe('');
  });

  it("refuses a branch whose history doesn't descend from the main the run was given", async () => {
    await plantDecoy(join(clone, '.git'));
    const other = 'factory/43-unrelated';
    await git(clone, 'checkout', '-q', '--orphan', other);
    await git(clone, 'commit', '-q', '--allow-empty', '-m', 'history of its own');
    await expect(publish(other)).rejects.toThrow(/doesn't descend from main/);
    expect(await refs(github)).not.toContain(other);
    expect(await refs(decoy)).toBe('');
  });
});
