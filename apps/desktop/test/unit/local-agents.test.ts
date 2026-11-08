/**
 * Agents on this Mac with no account (T54, A992–A994): the `penmoss` command the app writes, and
 * agents' clones of a git notebook in the CLI's `~/.penmoss`, made with the CLI's own code. Real
 * git against `file://` bare repositories, which GitHub cannot be asked about, so they sync
 * without a check (D51).
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EXIT, memoryTokenStore } from '@penmoss/cli';
import { CliError, nodeNotebooks } from '@penmoss/cli/node';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { desktopConfig } from '../../src/config';
import type { GitNotebookEntry } from '../../src/git-notebooks';
import {
  agentCloneName,
  keptLoginPath,
  LocalAgents,
  shellWord,
  type OwnerCheck,
} from '../../src/local-agents';

const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const EXE = '/Applications/Penmoss.app/Contents/MacOS/Penmoss';

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync('git', args, {
    cwd,
    env: { ...process.env, ...GIT_ENV, GIT_TERMINAL_PROMPT: '0' },
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'penmoss-local-agents-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function bare(name: string): string {
  const path = join(dir, `${name}.git`);
  git(dir, ['init', '--bare', '--quiet', '-b', 'main', path]);
  git(path, ['config', 'uploadpack.allowFilter', 'true']);
  git(path, ['config', 'uploadpack.allowAnySHA1InWant', 'true']);
  return `file://${path}`;
}

/** The CLI's notebooks in `home`, with a token store in memory. */
function cliNotebooks(home: string, secrets = memoryTokenStore()) {
  return nodeNotebooks({
    home,
    env: {},
    platform: 'linux',
    secrets,
    gitEnv: GIT_ENV,
    terminal: () => false,
  });
}

/** A notebook in `remote`, as the app would have made it: from another machine's clone. */
async function seeded(remote: string): Promise<void> {
  await cliNotebooks(join(dir, 'elsewhere')).add({
    remote,
    branch: 'main',
    dir: '',
    name: 'notes',
  });
}

function appEntry(remote: string, extra: Partial<GitNotebookEntry> = {}): GitNotebookEntry {
  return {
    localId: '01M6AAAAAAAAAAAAAAAAAAAAAA',
    notebookId: '01M6BBBBBBBBBBBBBBBBBBBBBB',
    name: 'Notes',
    create: false,
    remote,
    branch: 'main',
    dir: '',
    pushDelayS: 60,
    pullEveryMin: 2,
    added: new Date().toISOString(),
    ...extra,
  };
}

function agents(
  options: {
    entry?: GitNotebookEntry | null;
    token?: string | null;
    owner?: OwnerCheck;
    loginPath?: string | null;
    /** The app's notebooks with their tokens (D52's automatic clones). */
    all?: () => { entry: GitNotebookEntry; token: string | null }[];
    now?: () => number;
  } = {},
) {
  const asked: string[] = [];
  const home = join(dir, 'home');
  const secrets = memoryTokenStore();
  const service = new LocalAgents({
    cli: [EXE, '--penmoss-cli'],
    home,
    shell: '/bin/zsh',
    notebooks: () => cliNotebooks(join(home, '.penmoss'), secrets),
    notebook: () =>
      Promise.resolve(
        options.entry === null || options.entry === undefined
          ? null
          : { entry: options.entry, token: options.token ?? null },
      ),
    ownerCheck: (words) => {
      asked.push(words);
      return (options.owner ?? (() => Promise.resolve({ ok: true })))(words);
    },
    loginPath: () =>
      Promise.resolve(options.loginPath === undefined ? '/usr/bin:/bin' : options.loginPath),
    ...(options.all ? { all: () => Promise.resolve(options.all!()) } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  return { service, asked, home, secrets, registry: join(home, '.penmoss', 'notebooks.json') };
}

describe('connecting an agent to a git notebook (A993, A994)', { timeout: 60_000 }, () => {
  it('makes the agent its own clone after Touch ID, with its MCP command', async () => {
    const remote = bare('notes');
    await seeded(remote);
    const { service, asked, registry } = agents({ entry: appEntry(remote) });
    const answer = await service.connect('01M6AAAAAAAAAAAAAAAAAAAAAA', '  Claude   Code ');
    if (!answer.ok) throw new Error(answer.error.message);
    expect(answer.value).toMatchObject({
      name: 'notes-claude-code',
      label: 'Claude Code',
      server: 'penmoss-notes-claude-code',
    });
    expect(answer.value.claude).toBe(
      `claude mcp add penmoss-notes-claude-code -- ${EXE} --penmoss-cli mcp --notebook notes-claude-code`,
    );
    // With the switch on (T60, A1073): the channel, and how Claude Code starts with it.
    expect(answer.value.claudeChannel).toBe(
      `claude mcp add penmoss-notes-claude-code -- ${EXE} --penmoss-cli mcp --notebook notes-claude-code --channel`,
    );
    expect(answer.value.claudeLaunch).toBe(
      'claude --dangerously-load-development-channels server:penmoss-notes-claude-code',
    );
    expect(answer.value.codex).toBe(
      [
        '[mcp_servers."penmoss-notes-claude-code"]',
        `command = "${EXE}"`,
        'args = ["--penmoss-cli", "mcp", "--notebook", "notes-claude-code"]',
      ].join('\n'),
    );
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain('let the agent “Claude Code” edit');
    // The CLI's own registry: an agent's clone, and no confirmation of any kind (D51).
    const text = readFileSync(registry, 'utf8');
    const stored = JSON.parse(text) as {
      notebooks: { name: string; writer: { kind: string; label: string } }[];
    };
    expect(stored.notebooks).toHaveLength(1);
    expect(stored.notebooks[0]).toMatchObject({
      name: 'notes-claude-code',
      writer: { kind: 'agent', label: 'Claude Code' },
    });
    expect(text).not.toMatch(/confirm/i);
    // It syncs as the agent: the CLI's code finds the notebook the app made.
    const listed = await service.list('01M6AAAAAAAAAAAAAAAAAAAAAA');
    expect(listed.ok && listed.value.map((each) => each.name)).toEqual(['notes-claude-code']);
  });

  it('refuses without Touch ID, and leaves nothing behind', async () => {
    const remote = bare('notes');
    await seeded(remote);
    const { service, registry } = agents({
      entry: appEntry(remote),
      owner: () => Promise.resolve({ ok: false, message: 'Cancelled.' }),
    });
    const answer = await service.connect('01M6AAAAAAAAAAAAAAAAAAAAAA', 'Claude Code');
    expect(answer).toEqual({ ok: false, error: { code: 'not_confirmed', message: 'Cancelled.' } });
    expect(() => readFileSync(registry)).toThrow();
  });

  it('leaves nothing behind when the add fails', async () => {
    // A repository that is not there: the CLI's add rolls back, and no agent is listed.
    const { service, registry } = agents({ entry: appEntry(`file://${join(dir, 'missing.git')}`) });
    const answer = await service.connect('01M6AAAAAAAAAAAAAAAAAAAAAA', 'Codex');
    expect(answer.ok).toBe(false);
    expect(await service.list('01M6AAAAAAAAAAAAAAAAAAAAAA')).toEqual({ ok: true, value: [] });
    expect(() => readFileSync(registry)).toThrow();
  });

  it('carries the token, signing and commit identity over to the clone', async () => {
    const remote = bare('notes');
    await seeded(remote);
    const author = { name: 'Ryan', email: 'ryan@users.noreply.github.com' };
    const { service, registry, secrets } = agents({
      entry: appEntry(remote, { sign: false, author }),
      token: 'ghp_example0token0for0tests',
    });
    const answer = await service.connect('01M6AAAAAAAAAAAAAAAAAAAAAA', 'Codex');
    if (!answer.ok) throw new Error(answer.error.message);
    const stored = JSON.parse(readFileSync(registry, 'utf8')) as {
      notebooks: { localId: string; sign?: boolean; identity?: unknown }[];
    };
    expect(stored.notebooks[0]).toMatchObject({ sign: false, identity: author });
    const saved = await secrets.get(`token:${stored.notebooks[0]!.localId}`);
    expect(saved?.token).toBe('ghp_example0token0for0tests');
  });

  it('refuses a second agent of the same name, and a name it cannot use', async () => {
    const remote = bare('notes');
    await seeded(remote);
    const { service } = agents({ entry: appEntry(remote) });
    expect((await service.connect('01M6AAAAAAAAAAAAAAAAAAAAAA', 'Claude Code')).ok).toBe(true);
    const again = await service.connect('01M6AAAAAAAAAAAAAAAAAAAAAA', 'Claude Code');
    expect(!again.ok && again.error.code).toBe('agent_exists');
    for (const bad of ['', '   ', 'x'.repeat(41), 'say "hi"']) {
      const answer = await service.connect('01M6AAAAAAAAAAAAAAAAAAAAAA', bad);
      expect(!answer.ok && answer.error.code).toBe('invalid_label');
    }
    const missing = agents({ entry: null }).service;
    expect(await missing.connect('nope', 'Codex')).toMatchObject({ ok: false });
  });

  it('disconnects an agent, never a person’s clone; losing changes asks Touch ID', async () => {
    const remote = bare('notes');
    await seeded(remote);
    const { service, asked, home } = agents({ entry: appEntry(remote) });
    const connected = await service.connect('01M6AAAAAAAAAAAAAAAAAAAAAA', 'Codex');
    if (!connected.ok) throw new Error(connected.error.message);
    // A person's own clone in the same ~/.penmoss is not the page's to remove.
    await cliNotebooks(join(home, '.penmoss')).add({
      remote,
      branch: 'main',
      dir: '',
      name: 'mine',
    });
    expect(await service.disconnect('mine', false)).toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    });
    asked.length = 0;
    expect(await service.disconnect(connected.value.name, true)).toEqual({ ok: true, value: null });
    expect(asked).toEqual(['disconnect the agent “Codex” and lose the changes it has not pushed']);
    const listed = await service.list('01M6AAAAAAAAAAAAAAAAAAAAAA');
    expect(listed).toEqual({ ok: true, value: [] });
  });
});

describe(
  'every agent on this Mac reaches every notebook in the app (D52)',
  { timeout: 60_000 },
  () => {
    it('gives each notebook an automatic agent clone, with its token, and no owner check', async () => {
      const remote = bare('notes');
      await seeded(remote);
      const entry = appEntry(remote, { name: 'Quanta' });
      let token: string | null = 'ghp_example0token0for0tests';
      const { service, asked, home, secrets } = agents({
        entry,
        all: () => [{ entry, token }],
      });
      await service.ensureAll();
      const cli = cliNotebooks(join(home, '.penmoss'), secrets);
      const listed = await cli.list();
      expect(listed).toEqual([
        expect.objectContaining({
          name: 'quanta-agent',
          writer: { kind: 'agent', label: 'Agent' },
          automatic: true,
          notebookName: 'notes',
        }),
      ]);
      expect(asked).toEqual([]);
      expect((await secrets.get(`token:${listed[0]!.localId}`))?.token).toBe(
        'ghp_example0token0for0tests',
      );
      // Once is enough: a second pass makes nothing more.
      await service.ensureAll();
      expect(await cli.list()).toHaveLength(1);
      // A token changed in the app reaches it.
      token = 'ghp_another0token0for0tests';
      await service.ensureAll();
      expect((await secrets.get(`token:${listed[0]!.localId}`))?.token).toBe(token);
      // Settings shows it as the app's own, which Disconnect leaves.
      const view = await service.list(entry.localId);
      expect(view.ok && view.value.map((each) => [each.name, each.automatic])).toEqual([
        ['quanta-agent', true],
      ]);
      expect(await service.disconnect('quanta-agent', false)).toMatchObject({
        ok: false,
        error: { code: 'agent_automatic' },
      });
    });

    it('waits for the app’s first push rather than make a notebook of its own', async () => {
      const remote = bare('new');
      const entry = appEntry(remote, { create: true });
      let now = 1_000_000;
      const { service, home } = agents({
        entry,
        all: () => [{ entry, token: null }],
        now: () => now,
      });
      await service.ensureAll();
      const cli = cliNotebooks(join(home, '.penmoss'));
      expect(await cli.list()).toEqual([]);
      expect(git(remote.replace('file://', ''), ['branch', '--list'])).toBe('');
      // The app pushes its notebook; the next try, once its wait is over, connects.
      await seeded(remote);
      await service.ensureAll();
      expect(await cli.list()).toEqual([]);
      now += 20_000;
      await service.ensureAll();
      expect((await cli.list()).map((each) => each.name)).toEqual(['notes-agent']);
    });

    it('tries again at once when the notebook’s settings change, not only after its wait', async () => {
      const remote = bare('private-email');
      await seeded(remote);
      const home = join(dir, 'home');
      const secrets = memoryTokenStore();
      const tried: (string | undefined)[] = [];
      // GitHub's GH007 for a commit from a private address: the add is refused without one.
      const notebooks = () => {
        const real = cliNotebooks(join(home, '.penmoss'), secrets);
        return {
          ...real,
          add: (input: Parameters<typeof real.add>[0]) => {
            tried.push(input.author?.email);
            return input.author
              ? real.add(input)
              : Promise.reject(
                  new CliError(
                    EXIT.ERROR,
                    'GH007: Your push would publish a private email address.',
                    'git',
                  ),
                );
          },
        };
      };
      let entry = appEntry(remote);
      const service = new LocalAgents({
        cli: [EXE, '--penmoss-cli'],
        home,
        shell: '/bin/zsh',
        notebooks,
        notebook: () => Promise.resolve({ entry, token: null }),
        all: () => Promise.resolve([{ entry, token: null }]),
        ownerCheck: () => Promise.resolve({ ok: true }),
        now: () => 1_000_000,
      });
      await service.ensureAll();
      // Nothing changed and its 5 minutes are not over: no new try.
      await service.ensureAll();
      expect(tried).toEqual([undefined]);
      // Its commit email set in the app: the next pass tries again at once, and it lands.
      const email = '1+ryan@users.noreply.github.com';
      entry = appEntry(remote, { author: { name: 'Ryan', email } });
      await service.ensureAll();
      expect(tried).toEqual([undefined, email]);
      expect((await notebooks().list()).map((each) => each.name)).toEqual(['notes-agent']);
    });

    it('leaves a notebook with an agent of its own, and removes its automatic clone with it', async () => {
      const remote = bare('notes');
      await seeded(remote);
      const other = bare('other');
      await cliNotebooks(join(dir, 'elsewhere-too')).add({
        remote: other,
        branch: 'main',
        dir: '',
        name: 'other',
      });
      const first = appEntry(remote);
      const second = appEntry(other, { localId: '01M6CCCCCCCCCCCCCCCCCCCCCC', name: 'Other' });
      let all = [first, second];
      const { service, home } = agents({
        entry: first,
        all: () => all.map((entry) => ({ entry, token: null })),
      });
      expect((await service.connect(first.localId, 'Codex')).ok).toBe(true);
      await service.ensureAll();
      const cli = cliNotebooks(join(home, '.penmoss'));
      expect((await cli.list()).map((each) => each.name).sort()).toEqual([
        'notes-codex',
        'other-agent',
      ]);
      all = [first];
      await service.ensureAll();
      expect((await cli.list()).map((each) => each.name)).toEqual(['notes-codex']);
    });
  },
);

describe('the penmoss command (A992)', () => {
  it('writes ~/.local/bin/penmoss that runs this app, and says when its folder is not on PATH', async () => {
    const { service, home } = agents();
    expect(await service.cliStatus()).toMatchObject({ state: 'missing', onPath: false });
    const installed = await service.installCli();
    if (!installed.ok) throw new Error(installed.error.message);
    expect(installed.value).toMatchObject({
      path: join(home, '.local', 'bin', 'penmoss'),
      state: 'installed',
      profile: '~/.zshrc',
      pathLine: 'export PATH="$HOME/.local/bin:$PATH"',
      direct: `${EXE} --penmoss-cli`,
    });
    const script = readFileSync(join(home, '.local', 'bin', 'penmoss'), 'utf8');
    expect(script).toContain(`exec ${EXE} --penmoss-cli "$@"`);
    expect(statSync(join(home, '.local', 'bin', 'penmoss')).mode & 0o777).toBe(0o755);
    const onPath = agents({ loginPath: `${join(home, '.local', 'bin')}:/usr/bin` }).service;
    expect((await onPath.cliStatus()).onPath).toBe(true);
    expect((await agents({ loginPath: null }).service.cliStatus()).onPath).toBe(null);
    expect(await service.removeCli()).toMatchObject({ ok: true, value: { state: 'missing' } });
  });

  it('never overwrites a penmoss it did not write, and knows its own for another copy of the app', async () => {
    const { service, home } = agents();
    mkdirSync(join(home, '.local', 'bin'), { recursive: true });
    writeFileSync(join(home, '.local', 'bin', 'penmoss'), '#!/bin/sh\necho mine\n');
    expect((await service.cliStatus()).state).toBe('other');
    expect(await service.installCli()).toMatchObject({ ok: false, error: { code: 'cli_other' } });
    expect(await service.removeCli()).toMatchObject({ ok: false, error: { code: 'cli_other' } });
    expect(readFileSync(join(home, '.local', 'bin', 'penmoss'), 'utf8')).toContain('echo mine');
    rmSync(join(home, '.local', 'bin', 'penmoss'));
    await service.installCli();
    const moved = new LocalAgents({
      cli: ['/Users/me/Apps/Penmoss.app/Contents/MacOS/Penmoss', '--penmoss-cli'],
      home,
      shell: '/bin/bash',
      notebooks: () => cliNotebooks(join(home, '.penmoss')),
      notebook: () => Promise.resolve(null),
      ownerCheck: () => Promise.resolve({ ok: true }),
      loginPath: () => Promise.resolve(null),
    });
    expect(await moved.cliStatus()).toMatchObject({ state: 'stale', profile: '~/.bash_profile' });
  });
});

describe('names and words', () => {
  it('writes the command under the suite’s home only in an unpackaged build', () => {
    const env = { PENMOSS_TEST_HOME: '/tmp/suite-home' };
    expect(desktopConfig({ env, packaged: false, appPath: '/src/desktop' }).testHome).toBe(
      '/tmp/suite-home',
    );
    expect(desktopConfig({ env, packaged: true, appPath: '/A/app.asar' }).testHome).toBe(null);
  });

  it('names a clone from the notebook and the agent, never one taken', () => {
    expect(agentCloneName('Work Notes', 'Claude Code', new Set())).toBe('work-notes-claude-code');
    expect(agentCloneName('Café', 'Codex', new Set())).toBe('cafe-codex');
    expect(agentCloneName('notes', 'Codex', new Set(['notes-codex']))).toBe('notes-codex-2');
    expect(agentCloneName('✨', '✨', new Set())).toBe('notebook-agent');
  });

  it('quotes a shell word only when it must', () => {
    expect(shellWord('/Applications/Penmoss.app/Contents/MacOS/Penmoss')).toBe(
      '/Applications/Penmoss.app/Contents/MacOS/Penmoss',
    );
    expect(shellWord('/Users/me/My Apps/Penmoss')).toBe("'/Users/me/My Apps/Penmoss'");
    expect(shellWord("it's")).toBe("'it'\\''s'");
  });
});

// Quanta feedback 2, item 5 (A1124): a slow login shell held Settings → Agents back 3–4 s.
describe('the login shell’s PATH, kept', () => {
  function shell(answers: (string | null | Error)[]) {
    const asked: number[] = [];
    let release: (() => void) | null = null;
    const ask = () => {
      asked.push(asked.length);
      const answer = answers.shift() ?? null;
      return new Promise<string | null>((resolve, reject) => {
        release = () => (answer instanceof Error ? reject(answer) : resolve(answer));
      });
    };
    return { ask, asked, answer: () => release?.() };
  }

  it('asks the shell once as the app starts, and answers from what it said after that', async () => {
    const fake = shell(['/usr/bin:/a']);
    const path = keptLoginPath(fake.ask, { now: () => 0 });
    path.warm();
    const first = path.get();
    const second = path.get();
    fake.answer();
    expect(await first).toBe('/usr/bin:/a');
    expect(await second).toBe('/usr/bin:/a');
    expect(await path.get()).toBe('/usr/bin:/a');
    expect(fake.asked).toEqual([0]);
  });

  it('answers at once with what it kept, and asks again for next time when that is old', async () => {
    let clock = 0;
    const fake = shell(['/usr/bin', '/usr/bin:/home/me/.local/bin']);
    const path = keptLoginPath(fake.ask, { fresh: 1000, now: () => clock });
    const first = path.get();
    fake.answer();
    expect(await first).toBe('/usr/bin');
    clock = 5000;
    // Old: the kept PATH now, without waiting for the shell…
    expect(await path.get()).toBe('/usr/bin');
    expect(fake.asked).toEqual([0, 1]);
    fake.answer();
    await new Promise((resolve) => setTimeout(resolve, 0));
    // …and the shell's new answer the next time.
    expect(await path.get()).toBe('/usr/bin:/home/me/.local/bin');
  });

  it('is null when the shell fails, and asks again later', async () => {
    let clock = 0;
    const fake = shell([new Error('no shell'), '/usr/bin']);
    const path = keptLoginPath(fake.ask, { fresh: 10, now: () => clock });
    const first = path.get();
    fake.answer();
    expect(await first).toBe(null);
    clock = 100;
    expect(await path.get()).toBe(null);
    expect(fake.asked).toEqual([0, 1]);
  });
});
