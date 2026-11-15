/**
 * The gate numbers only the decisions a branch added. Real git in temp repositories:
 * a bare repository stands in for GitHub, mapped to its https URL in the publish repo's own
 * config, the runs' clone is the sandbox's worktree, and the sandbox's commands run in it with
 * `sh`. Nothing planted here runs a command.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { FactoryConfig } from '../src/config.ts';
import { nodeExec } from '../src/exec.ts';
import { ensureClone, hostDeps, repoDir, type HostOptions } from '../src/host.ts';
import type { RunSandbox } from '../src/run.ts';
import { testConfig } from './helpers.ts';

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

const BRANCH = 'factory/75-fix-the-sidebar';
const INSTRUCTION = 'Number new decisions `A-NEW-1`, `A-NEW-2`, and so on.';
const AGENTS = `# Agent instructions\n\n- ${INSTRUCTION}\n`;
const DECISIONS = [
  '# Decisions',
  '',
  '| ID    | Decision               |',
  '| ----- | ---------------------- |',
  '| A1230 | The publish repo.      |',
  '| A1231 | Process-listing tests. |',
  '',
].join('\n');

function options(config: FactoryConfig): HostOptions {
  const slot = config.slots[0];
  if (!slot) throw new Error('the config has no slot');
  return {
    config,
    slot,
    runId: '75-test',
    board: { items: [] },
    gh: {} as never,
    tracker: {} as never,
    exec: nodeExec,
    secrets: {},
    pushToken: () => Promise.resolve('the-write-token'),
    sandboxToken: () => Promise.resolve('the-read-token'),
    proofStore: {} as never,
    agent: {} as never,
    log: () => undefined,
  };
}

// Real git in temp repos: a few dozen git processes per test, which a loaded Mac (W12) can stretch past vitest's 5 s default.
describe("numbering a branch's decisions", { timeout: 30_000 }, () => {
  let config: FactoryConfig;
  let clone: string;
  let reserved: string;

  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(clone, path)), { recursive: true });
    writeFileSync(join(clone, path), text);
  };
  const read = (path: string) => readFileSync(join(clone, path), 'utf8');
  const commit = async (message: string, files: Record<string, string>) => {
    for (const [path, text] of Object.entries(files)) write(path, text);
    await git(clone, 'add', '-A');
    await git(clone, 'commit', '-q', '-m', message);
  };
  /** The gate sandbox: its commands run in the worktree (here the clone itself). */
  const sandbox: () => RunSandbox = () => ({
    worktreePath: clone,
    exec: async (command) => {
      const r = await nodeExec('sh', ['-c', command], { cwd: clone, env });
      return { exitCode: r.code, stdout: r.stdout, stderr: r.stderr };
    },
    close: () => Promise.resolve(),
  });
  const numberDecisions = async () => {
    const deps = hostDeps(options(config));
    await deps.fetchMain();
    return deps.numberDecisions(sandbox(), BRANCH);
  };
  const commits = async () => Number(await git(clone, 'rev-list', '--count', 'origin/main..HEAD'));

  beforeEach(async () => {
    const root = mkdtempSync(join(tmpdir(), 'factory-numbering-'));
    config = { ...testConfig(), stateDir: join(root, 'state') };
    reserved = join(config.stateDir, 'decision-numbers');
    const github = join(root, 'github.git');
    clone = repoDir(config);
    await git(root, 'init', '-q', '--bare', '-b', 'main', github);
    const seed = join(root, 'seed');
    await git(root, 'init', '-q', '-b', 'main', seed);
    for (const [path, text] of Object.entries({
      'AGENTS.md': AGENTS,
      'docs/decisions.md': DECISIONS,
      'README.md': 'Penmoss\n',
    })) {
      mkdirSync(dirname(join(seed, path)), { recursive: true });
      writeFileSync(join(seed, path), text);
    }
    await git(seed, 'add', '-A');
    await git(seed, 'commit', '-q', '-m', 'main');
    await git(seed, 'push', '-q', `file://${github}`, 'main');
    await git(root, 'clone', '-q', `file://${github}`, clone);
    const publish = join(config.stateDir, 'publish');
    await git(root, 'init', '-q', '--bare', publish);
    await git(
      publish,
      'config',
      `url.file://${github}.insteadOf`,
      `https://github.com/${config.repo}.git`,
    );
    await ensureClone(config, nodeExec);
    await git(clone, 'checkout', '-q', '-b', BRANCH);
  });

  it("leaves AGENTS.md's own placeholders alone when the branch records no decision", async () => {
    await commit('Fix the sidebar', { 'README.md': 'Penmoss, with a sidebar\n' });
    expect(await numberDecisions()).toEqual({});
    expect(read('AGENTS.md')).toBe(AGENTS);
    expect(existsSync(reserved)).toBe(false);
    expect(await commits()).toBe(1);
    expect(await git(clone, 'status', '--porcelain')).toBe('');
  });

  it('formats the table again once the number is narrower than A-NEW-1 (PEN-70)', async () => {
    // The agent's own Prettier run padded every row to fit the placeholder.
    const widened = [
      '# Decisions',
      '',
      '| ID      | Decision               |',
      '| ------- | ---------------------- |',
      '| A1230   | The publish repo.      |',
      '| A1231   | Process-listing tests. |',
      '| A-NEW-1 | The sidebar folds.     |',
      '',
    ].join('\n');
    await commit('Record a decision', { 'docs/decisions.md': widened });
    expect(await numberDecisions()).toEqual({ 'A-NEW-1': 'A1232' });
    expect(read('docs/decisions.md')).toBe(
      DECISIONS.replace(
        '| A1231 | Process-listing tests. |\n',
        '| A1231 | Process-listing tests. |\n| A1232 | The sidebar folds.     |\n',
      ),
    );
    expect(await git(clone, 'status', '--porcelain')).toBe('');
  });

  it('numbers the row the branch added and its references, and nothing else', async () => {
    await commit('Record a decision', {
      'docs/decisions.md': DECISIONS.replace(
        '| A1231 | Process-listing tests. |\n',
        '| A1231 | Process-listing tests. |\n| A-NEW-1 | The sidebar folds. |\n',
      ),
      'README.md': 'Penmoss\n\nThe sidebar folds, per A-NEW-1 (and A-NEW-2, never defined).\n',
      'tools/factory/test/x.test.ts': "const key = 'A-NEW-1';\n",
    });
    expect(await numberDecisions()).toEqual({ 'A-NEW-1': 'A1232' });
    expect(read('docs/decisions.md')).toContain('| A1232 | The sidebar folds.     |\n');
    expect(read('docs/decisions.md')).not.toContain('A-NEW');
    expect(read('README.md')).toBe(
      'Penmoss\n\nThe sidebar folds, per A1232 (and A-NEW-2, never defined).\n',
    );
    expect(read('AGENTS.md')).toBe(AGENTS);
    expect(read('tools/factory/test/x.test.ts')).toBe("const key = 'A-NEW-1';\n");
    expect(readFileSync(reserved, 'utf8')).toBe('1232\n');
    // One more commit, with every change in it.
    expect(await commits()).toBe(2);
    expect(await git(clone, 'status', '--porcelain')).toBe('');
    expect(await git(clone, 'log', '-1', '--format=%s')).toBe(
      'Number the new decisions: A-NEW-1 is A1232',
    );
  });
});
