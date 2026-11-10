/**
 * A run's sandbox starts from the main the host just fetched into the publish repo, not from
 * wherever the last gate left the runs' clone (A1232). With a fake Sandcastle: the first
 * command in a sandbox the host opens fetches main and puts the branch on that base. With real
 * git: that command moves a new branch made from a stale main onto the base, rebases a branch
 * with commits of its own onto it when that goes cleanly, and otherwise leaves it where it is.
 * Nothing planted here runs a command.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FactoryConfig } from '../src/config.ts';
import { nodeExec, type Exec } from '../src/exec.ts';
import {
  AGENT_STREAM,
  AgentNotInstalled,
  agentMissing,
  hostDeps,
  repoDir,
  execPastRefLocks,
  sandboxStartCommand,
  type HostOptions,
} from '../src/host.ts';
import { stoppedText } from '../src/start.ts';
import { testConfig } from './helpers.ts';

const MAIN_SHA = 'b'.repeat(40);
const RUN_SHA = 'c'.repeat(40);
const BRANCH = 'factory/75-fix-the-sidebar';

const sandcastle = vi.hoisted(() => ({
  commands: [] as string[],
  exitCode: 0,
  closed: 0,
  created: [] as Record<string, unknown>[],
  /** The sandbox's worktree: a real folder for the tests that read files from it. */
  worktree: '/state/repo/.sandcastle/worktrees/factory-75-fix-the-sidebar',
  /** What a command in the sandbox does besides being recorded (writes the files it makes). */
  onExec: function onExec(command: string): void {
    void command;
  },
  /** What the agent's run does: it gets Sandcastle's options (the log file, the stream hook). */
  run: (opts: SandcastleRun): Promise<unknown> => Promise.resolve({ log: opts.logging.path }),
}));

interface SandcastleRun {
  readonly logging: {
    readonly path: string;
    readonly onAgentStreamEvent?: (e: { type: string; line?: string }) => void;
  };
}

vi.mock('@ai-hero/sandcastle', () => ({
  createSandbox: (opts: Record<string, unknown>) => {
    sandcastle.created.push(opts);
    return Promise.resolve({
      worktreePath: sandcastle.worktree,
      exec: (command: string) => {
        sandcastle.commands.push(command);
        sandcastle.onExec(command);
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
      run: (opts: SandcastleRun) => sandcastle.run(opts),
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

  it('goes again when the other slot held the ref lock, and not for other failures (A1267)', async () => {
    const lock = {
      exitCode: 1,
      stdout: '',
      stderr: "error: cannot lock ref 'refs/remotes/origin/main': is at a but expected b",
    };
    const ok = { exitCode: 0, stdout: '', stderr: '' };
    const queue = [lock, lock, ok];
    const calls: string[] = [];
    const handle = {
      exec: (c: string) => {
        calls.push(c);
        return Promise.resolve(queue.shift() ?? ok);
      },
    };
    expect(await execPastRefLocks(handle, 'start', () => Promise.resolve())).toEqual(ok);
    expect(calls).toHaveLength(3);
    const other = { exitCode: 128, stdout: '', stderr: 'fatal: could not read from remote' };
    const once = { exec: () => Promise.resolve(other) };
    expect(await execPastRefLocks(once, 'start', () => Promise.resolve())).toEqual(other);
    const always = { exec: () => Promise.resolve(lock) };
    expect((await execPastRefLocks(always, 'start', () => Promise.resolve())).exitCode).toBe(1);
  });

  it('refuses a base that is not a commit', () => {
    expect(() => sandboxStartCommand('main; touch x')).toThrow(/not a commit/);
  });
});

describe("the agent's round in its sandbox", () => {
  let config: FactoryConfig;
  const runDir = () => join(config.stateDir, 'runs', '75-test');
  const INIT = '{"type":"system","subtype":"init","mcp_servers":[],"tools":["Bash"]}';

  beforeEach(() => {
    sandcastle.exitCode = 0;
    config = { ...testConfig(), stateDir: mkdtempSync(join(tmpdir(), 'factory-agent-')) };
  });

  it("keeps the agent's raw stream, init event first, beside Sandcastle's log", async () => {
    // PEN-38 asks that the init event lists no MCP servers; agent.log has no init event.
    sandcastle.run = (opts) => {
      for (const line of [INIT, '{"type":"result","result":"done"}'])
        opts.logging.onAgentStreamEvent?.({ type: 'raw', line });
      opts.logging.onAgentStreamEvent?.({ type: 'text', line: 'ignored' });
      writeFileSync(
        opts.logging.path,
        'Agent started\nRun complete: reached 1 iteration(s) without completion signal.\n',
      );
      return Promise.resolve({});
    };
    const deps = hostDeps(options(config, fakeExec().exec));
    await deps.runAgent(await deps.openSandbox(BRANCH), 'p');
    expect(readFileSync(join(runDir(), AGENT_STREAM), 'utf8')).toBe(
      `${INIT}\n{"type":"result","result":"done"}\n`,
    );
    // Sandcastle's closing line is explained where it is read.
    expect(readFileSync(join(runDir(), 'agent.log'), 'utf8')).toMatch(
      /without completion signal\.\n\(The factory: that is expected\. .*result\.json/,
    );
  });

  it("stops with an installation problem, naming the command and PATH, when the agent isn't found", async () => {
    // PEN-75's first run: the LaunchAgent's PATH had no ~/.local/bin.
    sandcastle.run = () =>
      Promise.reject(
        new Error('claude-code exited with code 127:\n/bin/sh: claude: command not found'),
      );
    const deps = hostDeps(options(config, fakeExec().exec));
    const ran = deps.runAgent(await deps.openSandbox(BRANCH), 'p');
    await expect(ran).rejects.toBeInstanceOf(AgentNotInstalled);
    await expect(ran).rejects.toThrow(
      `the factory can't find \`claude\` on its PATH (${process.env['PATH'] ?? ''})`,
    );
  });

  it('keeps the result the agent wrote in the run folder, for a run restarted after it', async () => {
    const worktree = mkdtempSync(join(tmpdir(), 'factory-wt-'));
    mkdirSync(join(worktree, '.factory'));
    const text = JSON.stringify({ status: 'done', summary: 'Linked the footer' });
    writeFileSync(join(worktree, '.factory', 'result.json'), text);
    const deps = hostDeps(options(config, fakeExec().exec));
    const handle = {
      worktreePath: worktree,
      exec: () => Promise.reject(new Error('no commands here')),
      close: () => Promise.resolve(),
    };
    expect((await deps.readResult(handle)).ok).toBe(true);
    expect(readFileSync(join(runDir(), 'result.json'), 'utf8')).toBe(text);
  });

  it("reads only this session's part of agent.log, which every session of the run appends to", async () => {
    // A retry after a usage limit that wrote little would otherwise find the first session's
    // limit message in the log's tail, and wait for the reset again.
    const deps = hostDeps(options(config, fakeExec().exec));
    const sandbox = await deps.openSandbox(BRANCH);
    sandcastle.run = (opts) => {
      appendFileSync(opts.logging.path, 'Claude AI usage limit reached|1794067200\n');
      return Promise.reject(new Error('claude-code exited with code 1'));
    };
    expect((await deps.runAgent(sandbox, 'p'))?.output).toMatch(/usage limit reached/);
    sandcastle.run = (opts) => {
      appendFileSync(opts.logging.path, 'Wrote .factory/result.json\n');
      return Promise.resolve({});
    };
    const output = (await deps.runAgent(sandbox, 'p'))?.output ?? '';
    expect(output).toContain('Wrote .factory/result.json');
    expect(output).not.toMatch(/usage limit reached/);
    expect(readFileSync(join(runDir(), 'agent.log'), 'utf8')).toMatch(/usage limit reached/);
  });

  it("takes Claude Code's result event, not the agent's prose, as the word on a usage limit", async () => {
    // PEN-93: the agent quoted "Claude AI usage limit reached|<epoch>" in its summary of a
    // finished round, and the run waited 30 minutes for a limit it never hit.
    const deps = hostDeps(options(config, fakeExec().exec));
    const sandbox = await deps.openSandbox(BRANCH);
    const session = (result: object, prose: string) => (opts: SandcastleRun) => {
      appendFileSync(opts.logging.path, `${prose}\n`);
      opts.logging.onAgentStreamEvent?.({ type: 'raw', line: JSON.stringify(result) });
      return Promise.resolve({});
    };
    sandcastle.run = session(
      { type: 'result', subtype: 'success', is_error: false, result: 'Done.' },
      'I did not print a fake `Claude AI usage limit reached|<epoch>` line; rate limited work.',
    );
    expect((await deps.runAgent(sandbox, 'p'))?.output).toBe('');
    sandcastle.run = session(
      { type: 'result', is_error: true, result: 'Claude AI usage limit reached|1794067200' },
      'Working on it',
    );
    expect((await deps.runAgent(sandbox, 'p'))?.output).toBe(
      'Claude AI usage limit reached|1794067200',
    );
  });

  it('leaves any other agent failure as it is', async () => {
    sandcastle.run = () => Promise.reject(new Error('claude-code exited with code 1:\nboom'));
    const deps = hostDeps(options(config, fakeExec().exec));
    const ran = deps.runAgent(await deps.openSandbox(BRANCH), 'p');
    await expect(ran).rejects.toThrow('boom');
    await expect(ran).rejects.not.toBeInstanceOf(AgentNotInstalled);
  });
});

describe("validation's walkthroughs on the host (PEN-94)", () => {
  let config: FactoryConfig;
  let worktree: string;
  const runDir = () => join(config.stateDir, 'runs', '75-test');
  const shot = (dir: string, name: string) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), 'png');
  };
  /** Host commands: the emulator is down, the VM script exits with `vm`. */
  const hostExec = (vm = 0): { exec: Exec; ran: string[] } => {
    const ran: string[] = [];
    const exec: Exec = (cmd, args) => {
      ran.push([cmd, ...args].join(' '));
      if (cmd === 'git') return fakeExec().exec(cmd, args);
      if (cmd === 'sh') return Promise.resolve({ code: vm, stdout: 'walk output', stderr: '' });
      return Promise.resolve({ code: 1, stdout: '', stderr: '' });
    };
    return { exec, ran };
  };

  beforeEach(() => {
    sandcastle.exitCode = 0;
    sandcastle.commands.length = 0;
    config = { ...testConfig(), stateDir: mkdtempSync(join(tmpdir(), 'factory-walk-')) };
    worktree = mkdtempSync(join(tmpdir(), 'factory-walk-tree-'));
    sandcastle.worktree = worktree;
    // The slot's AVD is made, so nothing runs avdmanager.
    mkdirSync(join(config.stateDir, 'avd'), { recursive: true });
    writeFileSync(join(config.stateDir, 'avd', `${config.slots[0]!.avd}.ini`), '');
  });

  it('says so, and runs nothing, when the session wrote no walkthrough', async () => {
    const host = hostExec();
    const deps = hostDeps(options(config, host.exec));
    const sandbox = await deps.openSandbox(BRANCH);
    sandcastle.commands.length = 0;
    for (const platform of ['mac', 'android'] as const) {
      const out = await deps.walk(sandbox, platform);
      expect(out.captures).toEqual([]);
      expect(out.problem).toMatch(/^The validating session wrote no walkthrough/);
    }
    expect(sandcastle.commands).toEqual([]);
    expect(host.ran.filter((c) => c.startsWith('sh '))).toEqual([]);
  });

  it("runs the Android walkthrough on the slot's emulator and brings its screenshots back", async () => {
    shot(
      join(worktree, 'apps/android/app/src/androidTest/java/app/penmoss/walk'),
      'FactoryWalkInstrumentedTest.kt',
    );
    sandcastle.onExec = (command) => {
      if (!command.includes('task proof:android')) return;
      const out = join(worktree, 'apps/android/build/proof');
      shot(join(out, 'walk'), 'ac2-android.png');
      shot(join(out, 'walk'), 'not a shot.txt');
      writeFileSync(join(out, 'report.json'), '[{"title":"walk","status":"passed"}]');
    };
    const deps = hostDeps(options(config, hostExec().exec));
    const sandbox = await deps.openSandbox(BRANCH);
    const out = await deps.walk(sandbox, 'android');
    expect(sandcastle.commands.at(-1)).toContain(
      'task proof:android -- app.penmoss.walk.FactoryWalkInstrumentedTest',
    );
    expect(out).toEqual({ platform: 'android', captures: ['ac2-android.png'] });
    expect(existsSync(join(worktree, '.factory/validation/ac2-android.png'))).toBe(true);
    expect(existsSync(join(runDir(), 'walk-android.log'))).toBe(true);
    sandcastle.onExec = () => undefined;
  });

  it('runs the Mac walkthrough in the test VM, without recording, and says when it failed', async () => {
    shot(join(worktree, 'apps/desktop/test/e2e'), 'factory-walk.spec.ts');
    shot(join(worktree, 'test-results/vm/test-results/walk'), 'ac3-mac.png');
    const host = hostExec(1);
    const deps = hostDeps(options(config, host.exec));
    const sandbox = await deps.openSandbox(BRANCH);
    const out = await deps.walk(sandbox, 'mac');
    const vm = host.ran.filter((c) => c.startsWith('sh '));
    expect(vm).toHaveLength(1);
    expect(vm[0]).toMatch(/scripts\/vm\/desktop-test\.sh test\/e2e\/factory-walk\.spec\.ts$/);
    expect(out.captures).toEqual(['ac3-mac.png']);
    expect(out.problem).toContain('The walkthrough failed.');
    expect(out.problem).toContain('walk output');
    expect(readFileSync(join(worktree, '.factory/validation/ac3-mac.png'), 'utf8')).toBe('png');
  });
});

describe('agentMissing', () => {
  it.each([
    ['claude-code exited with code 127:\n/bin/sh: claude: command not found', 'claude'],
    ['opencode exited with code 1: zsh: command not found: opencode', 'opencode'],
    ['claude-code exited with code 127:\nsh: 1: claude: not found', 'claude'],
    ['claude-code exited with code 127:\n', "the agent's command"],
    ['claude-code exited with code 1:\nError: not found', undefined],
    ['claude-code exited with code 2: ENOENT', undefined],
  ])('reads %j as %j', (message, command) => {
    expect(agentMissing(message)).toBe(command);
  });

  it("says on the card that it is the factory's installation, not the card", () => {
    const error = new AgentNotInstalled('claude', '/usr/bin:/bin');
    expect(stoppedText(error, error.message)).toMatch(
      /^The run couldn't start the agent: the factory can't find `claude` on its PATH \(\/usr\/bin:\/bin\)\. .*Nothing is wrong with this card/,
    );
    expect(stoppedText(new Error('x'), 'x')).toBe('The run stopped on an error: x');
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

  /** A restarted run's branch (R12): Sandcastle's worktree of it, on the stale main, with work. */
  const restarted = async (file = 'site/footer.md', text = 'The footer link.\n') => {
    await git(clone, 'worktree', 'add', '-q', '-b', BRANCH, worktree, 'origin/main');
    mkdirSync(join(worktree, dirname(file)), { recursive: true });
    writeFileSync(join(worktree, file), text);
    await git(worktree, 'add', '-A');
    await git(worktree, 'commit', '-q', '-m', "the agent's work");
    return git(worktree, 'rev-parse', 'HEAD');
  };

  it("rebases a restarted run's branch onto the base, keeping its commits (R12)", async () => {
    // PEN-75's restarted agent judged a base main had already fixed, and re-reported it.
    await restarted();
    await start(sandboxStartCommand(base));
    expect(await git(worktree, 'log', '--format=%s', `${base}..HEAD`)).toBe("the agent's work");
    expect(await git(worktree, 'merge-base', '--is-ancestor', base, 'HEAD')).toBe('');
    expect(readFileSync(join(worktree, 'docs', 'fix.md'), 'utf8')).toBe('The fix.\n');
    expect(await git(worktree, 'status', '--porcelain')).toBe('');
    // main is put at the base too, for the gate's rebase.
    expect(await git(clone, 'rev-parse', 'origin/main')).toBe(base);
  });

  it('leaves the branch where it is when the rebase conflicts, for the gate', async () => {
    const work = await restarted('docs/fix.md', 'Not the fix.\n');
    await start(sandboxStartCommand(base));
    expect(await git(worktree, 'rev-parse', 'HEAD')).toBe(work);
    expect(await git(worktree, 'status', '--porcelain')).toBe('');
    expect(existsSync(join(clone, '.git', 'worktrees', basename(worktree), 'rebase-merge'))).toBe(
      false,
    );
    expect(await git(clone, 'rev-parse', 'origin/main')).toBe(base);
  });

  it('leaves the branch where it is when its tracked files have changes', async () => {
    const work = await restarted();
    writeFileSync(join(worktree, 'site', 'footer.md'), 'Half-done.\n');
    await start(sandboxStartCommand(base));
    expect(await git(worktree, 'rev-parse', 'HEAD')).toBe(work);
    expect(readFileSync(join(worktree, 'site', 'footer.md'), 'utf8')).toBe('Half-done.\n');
  });
});
