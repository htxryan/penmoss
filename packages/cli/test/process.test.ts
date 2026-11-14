/**
 * The built CLI as a real process (the review's reproductions): how it treats stdin it was not
 * asked to read, and what a program it starts may see. Each run is bounded, so a hang fails the
 * test instead of the suite.
 */
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest';
import type { Io } from '../src/io';
import { run } from '../src/main';
import { nodeNotebooks } from '../src/node-notebooks';
import { nodeTokenStore } from '../src/token-store';

const TOKEN = 'ghp_' + 'A'.repeat(36);
const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
/**
 * A run that takes longer than this is a hang. A hang never ends, so this is far above a slow
 * run: alone one takes under a second, but a process started on this shared Mac when it is
 * short of CPU runs up to 30 times slower (W12, PEN-60), as `node build.js` does: 0.1 s, then
 * 3–4 s at utility QoS.
 */
const HANG_MS = 20_000;
/** Each test starts git and the bundle, up to two runs of it: two hang bounds and some. */
const PROCESS_TESTS = { timeout: 60_000 };

let bundleDir: string;
let bundle: string;
let root: string;
let home: string;
let bin: string;

beforeAll(async () => {
  bundleDir = await mkdtemp(join(tmpdir(), 'penmoss-bundle-'));
  bundle = join(bundleDir, 'penmoss.js');
  // The build the package ships (build.js), into a directory of its own.
  execFileSync(process.execPath, [
    fileURLToPath(new URL('../build.js', import.meta.url)),
    bundleDir,
  ]);
});

afterAll(async () => {
  await rm(bundleDir, { recursive: true, force: true });
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'penmoss-proc-'));
  home = join(root, 'home');
  bin = join(root, 'bin');
  await mkdir(home, { recursive: true });
  await mkdir(bin, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

interface Ran {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly ms: number;
  /** Still running at HANG_MS, so killed. */
  readonly hung: boolean;
}

/** A pipe on stdin that nobody writes to or closes. */
const OPEN = { open: true } as const;

/**
 * Runs the bundle. `stdin`: a string piped in and closed, `null` for
 * /dev/null, or OPEN.
 */
async function penmoss(args: string[], stdin: string | null | typeof OPEN = null): Promise<Ran> {
  const started = Date.now();
  const child = spawn(process.execPath, [bundle, ...args], {
    env: {
      HOME: home,
      PATH: `${bin}:/usr/bin:/bin`,
      PENMOSS_HOME: join(home, '.penmoss'),
      FAKE_DIR: root,
      ...GIT_ENV,
    },
    stdio: [stdin === null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout!.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
  child.stderr!.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
  if (typeof stdin === 'string') child.stdin!.end(stdin);
  let hung = false;
  const timer = setTimeout(() => {
    hung = true;
    child.kill('SIGKILL');
  }, HANG_MS);
  const [code] = (await once(child, 'exit')) as [number | null];
  clearTimeout(timer);
  child.stdin?.destroy();
  return { code, stdout, stderr, ms: Date.now() - started, hung };
}

/**
 * A git notebook named `nb` in the bundle's PENMOSS_HOME, on a bare repository here, added as
 * Ryan would at a terminal. Its writer secret goes to the CLI's own
 * credentials file, which the bundle reads before any keychain.
 */
async function withNotebook(): Promise<void> {
  const remote = join(root, 'notes.git');
  execFileSync('git', ['init', '--bare', '--quiet', '--initial-branch=main', remote]);
  const penmossHome = join(home, '.penmoss');
  const nokeychain = join(root, 'nokeychain');
  await mkdir(nokeychain, { recursive: true });
  const notebooks = nodeNotebooks({
    terminal: () => true,
    home: penmossHome,
    env: {},
    platform: process.platform,
    secrets: nodeTokenStore({
      platform: process.platform,
      env: { PATH: nokeychain },
      service: 'penmoss-git',
      file: join(penmossHome, 'credentials.json'),
      accepts: () => true,
    }),
    gitEnv: GIT_ENV,
  });
  let stderr = '';
  const io: Io = {
    env: {},
    stdin: { isTTY: false, read: () => Promise.resolve('') },
    stdout: { isTTY: false, write: () => undefined },
    stderr: { write: (text) => void (stderr += text) },
    openUrl: () => Promise.resolve(false),
    notebooks,
  };
  const code = await run(['notebook', 'add', `file://${remote}`, '--name', 'nb'], io);
  expect(code, stderr).toBe(0);
}

/** The keychain helper the CLI runs on this platform (token-store.ts), found first on PATH. */
const KEYCHAIN_TOOL = process.platform === 'darwin' ? 'security' : 'secret-tool';

async function fakeKeychainTool(script: string) {
  const path = join(bin, KEYCHAIN_TOOL);
  await writeFile(path, `#!/bin/sh\n${script}\n`);
  await chmod(path, 0o755);
}

describe('edit --section never reads stdin it was not given (review #2)', PROCESS_TESTS, () => {
  // On the only notebook here (A1050), not synced: the refusal comes before the note is read.
  it('refuses with stdin at /dev/null instead of emptying the section', async () => {
    await withNotebook();
    const ran = await penmoss(['edit', 'Trip', '--section', 'Plans', '--no-sync']);
    expect(ran.hung).toBe(false);
    expect(ran.code).toBe(2);
    expect(ran.stderr).toMatch(/pass - to read it from stdin|--text/);
  });

  it('refuses at once with an open pipe on stdin, never waiting on it', async () => {
    await withNotebook();
    const ran = await penmoss(['edit', 'Trip', '--section', 'Plans', '--no-sync'], OPEN);
    expect(ran.hung).toBe(false);
    expect(ran.code).toBe(2);
    expect(ran.stderr).toMatch(/pass - to read it from stdin|--text/);
  });

  it('refuses empty markdown for a section unless --allow-empty', async () => {
    await withNotebook();
    const piped = await penmoss(['edit', 'Trip', '--section', 'Plans', '-', '--no-sync'], '');
    expect(piped.code).toBe(2);
    expect(piped.stderr).toMatch(/--allow-empty/);
    const inline = await penmoss([
      'edit',
      'Trip',
      '--section',
      'Plans',
      '--text',
      ' \n',
      '--no-sync',
    ]);
    expect(inline.code).toBe(2);
    expect(inline.stderr).toMatch(/--allow-empty/);
  });
});

describe('the token stays out of what the CLI starts (review #7)', PROCESS_TESTS, () => {
  it('a keychain helper never sees PENMOSS_GIT_TOKEN', async () => {
    // Saving a notebook's token asks the keychain first; nothing answers on 127.0.0.1:9, so the
    // add then fails, which is not what is checked here.
    await fakeKeychainTool('env > "$FAKE_DIR/env.log"\nexit 1');
    const child = spawn(
      process.execPath,
      [bundle, 'notebook', 'add', 'https://127.0.0.1:9/ryan/notes.git', '--token', '-'],
      {
        env: {
          HOME: home,
          PATH: `${bin}:/usr/bin:/bin`,
          PENMOSS_HOME: join(home, '.penmoss'),
          FAKE_DIR: root,
          PENMOSS_GIT_TOKEN: TOKEN,
          GIT_TERMINAL_PROMPT: '0',
          ...GIT_ENV,
        },
        stdio: ['pipe', 'ignore', 'ignore'],
      },
    );
    child.stdin.end('ghp_' + 'B'.repeat(36));
    await once(child, 'exit');
    const { readFile } = await import('node:fs/promises');
    const env = await readFile(join(root, 'env.log'), 'utf8');
    expect(env).toContain('FAKE_DIR=');
    expect(env).not.toContain(TOKEN);
    expect(env).not.toContain('PENMOSS_GIT_TOKEN');
  });
});

describe('an older Node (review nit)', PROCESS_TESTS, () => {
  it('says which Node it needs before loading code that Node could not parse', async () => {
    // The bundle is replaced by something no Node parses: the version check must come first.
    const copy = await mkdtemp(join(tmpdir(), 'penmoss-old-'));
    try {
      execFileSync('cp', [bundle, join(copy, 'penmoss.js')]);
      await writeFile(join(copy, 'penmoss-cli.js'), 'this is ( not JavaScript\n');
      const old =
        'data:text/javascript,' +
        encodeURIComponent(
          "Object.defineProperty(process.versions, 'node', { value: '18.19.0' });",
        );
      const child = spawn(
        process.execPath,
        ['--import', old, join(copy, 'penmoss.js'), '--version'],
        {
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let stderr = '';
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
      const [code] = (await once(child, 'exit')) as [number | null];
      expect(code).toBe(1);
      expect(stderr).toBe('penmoss needs Node 22 or later (this is 18.19.0).\n');
    } finally {
      await rm(copy, { recursive: true, force: true });
    }
  });

  it('runs the CLI on this Node', async () => {
    const ran = await penmoss(['--version']);
    expect(ran.code).toBe(0);
    expect(ran.stdout).toMatch(/^penmoss \d+\.\d+\.\d+\n$/);
  });
});
