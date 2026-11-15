/**
 * The built CLI (`build.js`'s bundle) on a git notebook, as a separate process with only git on
 * PATH: credentials in ~/.penmoss with no keychain, piped requests and a logged detached sync,
 * and an edit that survives a kill during the sync after it (B1 of #165). The bundle is built
 * once for the file.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { alive, bare as bareAt, GIT_ENV, git, onPath, testRoot } from './support/machine';

const root = testRoot('penmoss-nb-');
const bare = (name: string) => bareAt(root.path, name);

let bundleDir: string;
beforeAll(() => {
  bundleDir = mkdtempSync(join(tmpdir(), 'penmoss-bundle-'));
  execFileSync(process.execPath, [
    fileURLToPath(new URL('../build.js', import.meta.url)),
    bundleDir,
  ]);
}, 120_000);
afterAll(() => rmSync(bundleDir, { recursive: true, force: true }));

/** A folder holding only git (and on a Mac its tool check): no keychain tool, so the file store. */
function onlyGit(): string {
  const bin = join(root.path, 'bin');
  mkdirSync(bin);
  for (const tool of ['git', 'xcode-select']) {
    const found = spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
    if (found) onPath(found, join(bin, tool));
  }
  return bin;
}

describe('the built CLI', () => {
  it('runs a git notebook from the bundle, with credentials in ~/.penmoss and no keychain', () => {
    const bin = onlyGit();
    const remote = bare('bundle');
    const penmoss = (args: string[]) =>
      spawnSync(process.execPath, [join(bundleDir, 'penmoss.js'), ...args], {
        env: {
          PATH: bin,
          HOME: join(root.path, 'h'),
          PENMOSS_HOME: join(root.path, 'h', '.penmoss'),
          ...GIT_ENV,
        },
        encoding: 'utf8',
        timeout: 60_000,
      });
    const added = penmoss(['notebook', 'add', `file://${remote}`, '--name', 'nb']);
    // Nothing is said: nobody is asked whether the repository is private (D61).
    expect(added.stderr).toBe('');
    expect(added.status).toBe(0);
    expect(penmoss(['new', 'Bundled', '--notebook', 'nb']).status).toBe(0);
    expect(git(remote, ['ls-tree', '-r', '--name-only', 'main'])).toContain('Bundled.md');
    const credentials = join(root.path, 'h', '.penmoss', 'credentials.json');
    expect(statSync(credentials).mode & 0o777).toBe(0o600);
    expect(readFileSync(credentials, 'utf8')).toMatch(/"writer:[0-9A-Z]{26}"/);
  }, 120_000);

  it('serves requests piped in at once, and leaves the push to a logged detached sync', async () => {
    const bin = onlyGit();
    const remote = bare('piped');
    const home = join(root.path, 'h', '.penmoss');
    const penmoss = (args: string[], input?: string) =>
      spawnSync(process.execPath, [join(bundleDir, 'penmoss.js'), ...args], {
        env: { PATH: bin, HOME: join(root.path, 'h'), PENMOSS_HOME: home, ...GIT_ENV },
        encoding: 'utf8',
        timeout: 60_000,
        ...(input === undefined ? {} : { input }),
      });
    expect(penmoss(['notebook', 'add', `file://${remote}`, '--name', 'nb']).status).toBe(0);
    const requests = [
      {
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'p', version: '1' },
        },
      },
      {
        id: 2,
        method: 'tools/call',
        params: { name: 'create_note', arguments: { title: 'Piped', markdown: 'x' } },
      },
      { id: 3, method: 'tools/call', params: { name: 'constructor', arguments: {} } },
    ];
    // Everything is on stdin before the server reads it, and stdin closes at once.
    const served = penmoss(
      ['mcp', '--notebook', 'nb'],
      requests.map((each) => `${JSON.stringify({ jsonrpc: '2.0', ...each })}\n`).join(''),
    );
    expect(served.status).toBe(0);
    const replies = served.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { id: number; error?: { message: string } });
    expect(replies.map((reply) => reply.id)).toEqual([1, 2, 3]);
    expect(replies[2]!.error?.message).toBe('Unknown tool: constructor');
    expect(served.stderr).toContain('stdin closed: syncing nb in the background');
    const registry = JSON.parse(readFileSync(join(home, 'notebooks.json'), 'utf8')) as {
      notebooks: Array<{ localId: string; name: string }>;
    };
    const log = join(
      home,
      'git',
      registry.notebooks.find((each) => each.name === 'nb')!.localId,
      'detached-sync.log',
    );
    await vi.waitFor(
      () => {
        expect(readFileSync(log, 'utf8')).toMatch(/Synced nb: pushed [0-9a-f]{7}/);
      },
      { timeout: 30_000, interval: 200 },
    );
    expect(readFileSync(log, 'utf8')).toMatch(
      /^--- \d{4}-\d\d-\d\dT.* penmoss notebook sync nb --wait 120$/m,
    );
    expect(git(remote, ['ls-tree', '-r', '--name-only', 'main'])).toContain('Piped.md');
    // The detached sync has gone before its folder is removed (#172): it may still be writing.
    // By its pid from the log, since a sandbox (the factory's) can't list processes for pgrep.
    const pid = Number(/^--- pid (\d+)$/m.exec(readFileSync(log, 'utf8'))?.[1]);
    expect(pid).toBeGreaterThan(0);
    await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 30_000, interval: 200 });
  }, 120_000);

  it('keeps an edit when the command is killed during the sync after it (B1 of #165)', async () => {
    // Only git on PATH (no keychain tool, as above): the CI Macs' keychains stay untouched.
    const bin = onlyGit();
    const sleep = spawnSync('sh', ['-c', 'command -v sleep'], { encoding: 'utf8' }).stdout.trim();
    const remote = bare('killed');
    const home = join(root.path, 'h', '.penmoss');
    const environment = {
      PATH: bin,
      HOME: join(root.path, 'h'),
      PENMOSS_HOME: home,
      ...GIT_ENV,
    };
    const penmoss = (args: string[]) =>
      spawnSync(process.execPath, [join(bundleDir, 'penmoss.js'), ...args], {
        env: environment,
        encoding: 'utf8',
        timeout: 60_000,
      });
    expect(penmoss(['notebook', 'add', `file://${remote}`, '--name', 'nb']).status).toBe(0);
    const registry = JSON.parse(readFileSync(join(home, 'notebooks.json'), 'utf8')) as {
      notebooks: Array<{ localId: string; name: string }>;
    };
    const gitDir = join(
      home,
      'git',
      registry.notebooks.find((each) => each.name === 'nb')!.localId,
      'repo.git',
    );
    // The sync before the edit fetches; the fetch of the sync after it hangs, as on a network
    // that stalls.
    const gitPath = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
    const hang = join(root.path, 'hang.sh');
    const hung = join(root.path, 'hang.pid');
    const once = join(root.path, 'fetched-once');
    writeFileSync(
      hang,
      `#!/bin/sh\nif [ -e '${once}' ]; then echo $$ > '${hung}'; exec '${sleep}' 30; fi\n: > '${once}'\nexec '${gitPath}' upload-pack "$@"\n`,
      { mode: 0o755 },
    );
    git(gitDir, ['config', 'remote.origin.uploadpack', hang]);
    const child = spawn(
      process.execPath,
      [join(bundleDir, 'penmoss.js'), 'new', 'Survivor', '--notebook', 'nb'],
      {
        env: environment,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    await new Promise<void>((resolve, reject) => {
      let out = '';
      child.stdout.on('data', (chunk: Buffer) => {
        out += chunk.toString('utf8');
        if (out.includes('Created')) resolve();
      });
      child.on('exit', () => reject(new Error(`exited before the sync: ${out}`)));
    });
    // Inside the sync now (its fetch hangs): killed with no chance to clean up.
    await vi.waitFor(() => expect(statSync(hung).size).toBeGreaterThan(0), {
      timeout: 20_000,
      interval: 50,
    });
    child.kill('SIGKILL');
    await new Promise((resolve) => child.once('exit', resolve));
    try {
      process.kill(Number(readFileSync(hung, 'utf8').trim()), 'SIGKILL');
    } catch {
      // Gone already.
    }
    git(gitDir, ['config', '--unset', 'remote.origin.uploadpack']);
    const synced = penmoss(['notebook', 'sync', 'nb']);
    expect(synced.stderr).toBe('');
    expect(synced.status).toBe(0);
    expect(git(remote, ['ls-tree', '-r', '--name-only', 'main'])).toContain('Survivor.md');
  }, 120_000);
});
