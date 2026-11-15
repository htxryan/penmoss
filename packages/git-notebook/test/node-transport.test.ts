/**
 * The system-git transport against real repositories (T50 G2, #150): local bare repos over
 * `file://`, refusals from a server hook, one clone under many calls, reads beside a sync, and
 * FileStorage. Over HTTP, git's own configuration and the engine end to end are
 * `node-sync.test.ts`.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  GitNotebookEngine,
  GitTransportError,
  MemoryRemote,
  MemorySecrets,
  MemoryTransport,
  NotebookOps,
} from '../src';
import { classify, gitError, hostMessage, preflight } from '../src/node/git';
import { FileStorage } from '../src/node/storage';
import { NodeGitTransport } from '../src/node/transport';
import { allowPushes, git, ISOLATED, refusePushes } from './support/git';
import { box, NOTEBOOK, transport } from './support/node-clone';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe('NodeGitTransport', () => {
  it('commits on the head, pushes fast-forward only, and reads only what it is asked for', async () => {
    const sb = box();
    const remote = sb.bare('notes');
    const colleague = sb.colleague(remote.url);
    colleague.commit({ 'README.md': '# Code\n', 'src/big.bin': 'x'.repeat(50_000) });
    const a = await transport(sb.dir, remote.url, { name: 'a' });
    const head = await a.fetch();
    expect(head).toMatch(/^[0-9a-f]{40}$/);
    const files = await a.list(head!);
    expect([...files.keys()].sort()).toEqual(['README.md', 'src/big.bin']);
    // A partial clone: no blob is here until something reads it.
    const read = await a.read(head!, ['README.md']);
    expect(decoder.decode(read.get('README.md'))).toBe('# Code\n');
    const missing = git(join(sb.dir, 'clone-a.git'), [
      'rev-list',
      '--objects',
      '--missing=print',
      head!,
    ]);
    expect(missing).toContain(`?${files.get('src/big.bin')}`);
    expect(missing).not.toContain(`?${files.get('README.md')}`);

    const commit = await a.commit(
      head,
      new Map([['notes/a.md', encoder.encode('a\n')]]),
      'Penmoss: 1 note [skip ci]',
    );
    expect(commit).not.toBeNull();
    expect(
      await a.commit(commit, new Map([['notes/a.md', encoder.encode('a\n')]]), 'same'),
    ).toBeNull();
    expect(await a.push(commit!)).toBe('pushed');
    expect(colleague.read('notes/a.md')).toBe('a\n');
    expect(colleague.read('src/big.bin')).toBe('x'.repeat(50_000));
    expect(colleague.log()[0]).toBe('Penmoss a|Penmoss: 1 note [skip ci]');

    // Someone pushes first: the next push from the old head is rejected, not merged.
    colleague.commit({ 'README.md': '# Code 2\n' });
    const stale = await a.commit(commit, new Map([['notes/b.md', encoder.encode('b\n')]]), 'b');
    expect(await a.push(stale!)).toBe('rejected');
    const next = await a.fetch();
    expect(await a.changed(commit!, next!)).toEqual(['README.md']);
    const rebuilt = await a.commit(next, new Map([['notes/b.md', encoder.encode('b\n')]]), 'b');
    expect(await a.push(rebuilt!)).toBe('pushed');
    expect(colleague.files().sort()).toEqual([
      'README.md',
      'notes/a.md',
      'notes/b.md',
      'src/big.bin',
    ]);

    const log = await a.log({ paths: ['notes/'] });
    expect(log.map((c) => c.message)).toEqual(['b', 'Penmoss: 1 note [skip ci]']);
    expect(decoder.decode((await a.readAt(commit!, 'notes/a.md'))!)).toBe('a\n');
    expect(await a.readAt(commit!, 'notes/none.md')).toBeNull();
    await a.maintain();
  });

  it('asks the remote for its head with ls-remote, without fetching (T60, A1067)', async () => {
    const sb = box();
    const remote = sb.bare('heads');
    const a = await transport(sb.dir, remote.url, { name: 'a' });
    expect(await a.remoteHead()).toBeNull();
    const colleague = sb.colleague(remote.url);
    colleague.commit({ 'README.md': '# Code\n' });
    const pushed = await a.remoteHead();
    expect(pushed).toMatch(/^[0-9a-f]{40}$/);
    // Nothing was fetched: the clone's own ref is still unset.
    expect(await a.head()).toBeNull();
    expect(await a.fetch()).toBe(pushed);
    colleague.commit({ 'README.md': '# Code 2\n' });
    const moved = await a.remoteHead();
    expect(moved).not.toBe(pushed);
    expect(await a.head()).toBe(pushed);
    // Another branch's head is not this one's.
    const other = await transport(sb.dir, remote.url, { name: 'b', branch: 'elsewhere' });
    expect(await other.remoteHead()).toBeNull();
  });

  it('starts a notebook on an empty repository or a new branch', async () => {
    const sb = box();
    const remote = sb.bare('empty');
    const a = await transport(sb.dir, remote.url, { branch: 'notes' });
    expect(await a.fetch()).toBeNull();
    const first = await a.commit(null, new Map([['x.md', encoder.encode('x')]]), 'first');
    expect(await a.push(first!)).toBe('pushed');
    expect(await a.fetch()).toBe(first);
  });

  it('refuses to write outside its directory', async () => {
    const sb = box();
    const remote = sb.bare('dir');
    const a = await transport(sb.dir, remote.url, { root: 'docs/notes/' });
    await expect(
      a.commit(null, new Map([['README.md', encoder.encode('x')]]), 'x'),
    ).rejects.toThrow(/outside docs\/notes/);
    await expect(
      a.commit(null, new Map([['docs/notes/../../x.md', encoder.encode('x')]]), 'x'),
    ).rejects.toThrow(/outside/);
  });

  it("maps a refused push to a typed error that keeps the host's message", async () => {
    const sb = box();
    const remote = sb.bare('protected');
    const a = await transport(sb.dir, remote.url);
    const first = await a.commit(null, new Map([['x.md', encoder.encode('x')]]), 'first');
    expect(await a.push(first!)).toBe('pushed');
    refusePushes(remote.path, 'GH006: Protected branch update failed for refs/heads/main.');
    const second = await a.commit(first, new Map([['y.md', encoder.encode('y')]]), 'second');
    const error = await a.push(second!).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitTransportError);
    expect((error as GitTransportError).code).toBe('protected');
    expect((error as GitTransportError).hostMessage).toContain(
      'GH006: Protected branch update failed',
    );
    refusePushes(remote.path, 'Policy: pushes to this repository are closed.');
    const hooked = await a.push(second!).catch((e: unknown) => e);
    expect((hooked as GitTransportError).code).toBe('refused');
    expect((hooked as GitTransportError).hostMessage).toContain(
      'pushes to this repository are closed',
    );
    allowPushes(remote.path);
    expect(await a.push(second!)).toBe('pushed');
  });

  it('says why a repository cannot be reached', async () => {
    const sb = box();
    const a = await transport(sb.dir, `file://${join(sb.dir, 'nowhere.git')}`);
    const error = await a.fetch().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitTransportError);
    expect((error as GitTransportError).code).toBe('not_found');
  });

  it('classifies what hosts print', () => {
    expect(
      classify('remote: error: GH013: Repository rule violations found for refs/heads/main.'),
    ).toBe('rules');
    expect(classify('remote: Push cannot contain secrets\n remote: GH009')).toBe('rules');
    expect(classify("fatal: Authentication failed for 'https://github.com/x/y.git/'")).toBe('auth');
    expect(
      classify(
        "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
      ),
    ).toBe('auth');
    expect(classify('git@github.com: Permission denied (publickey).')).toBe('auth');
    expect(
      classify(
        "remote: Repository not found.\nfatal: repository 'https://github.com/x/y.git/' not found",
      ),
    ).toBe('not_found');
    expect(
      classify(
        "fatal: unable to access 'https://github.com/x/y.git/': Could not resolve host: github.com",
      ),
    ).toBe('network');
    expect(classify('! [remote rejected] main -> main (pre-receive hook declined)')).toBe(
      'refused',
    );
    // Where git went is no reason (PEN-117): a remote or folder named tls, ssl or GH006.
    for (const remote of [
      'file:///tmp/penmoss-nb-xSsLq1/gh007.git',
      'https://github.com/tls-team/hassle.git',
      'git@github.com:gh006/notes.git',
      'ssh://git@tls.example.com/notes.git',
      // A plain path remote: git prints it bare after "To", and quoted in "failed to push".
      '/tmp/penmoss-nb-xTlS9a/gh007.git',
    ]) {
      expect(
        classify(
          `remote: error: GH007: Your push would publish a private email address.\nerror: failed to push some refs to '${remote}'\nTo ${remote}\n!\trefs/heads/main:refs/heads/main\t[remote rejected] (pre-receive hook declined)`,
        ),
        remote,
      ).toBe('refused');
    }
    expect(classify("fatal: Unable to create '/tmp/ssl/clone.git/index.lock': File exists.")).toBe(
      'git',
    );
    expect(
      classify("fatal: unable to access 'https://tls.example.com/x.git/': SSL certificate problem"),
    ).toBe('network');
    expect(hostMessage('remote: \u001b[1mone\u001b[0m\nremote:\nlocal\nremote: two')).toBe(
      'one\ntwo',
    );
    // SSH: a host key or a key's passphrase, not "could not reach the host".
    expect(
      classify('Host key verification failed.\nfatal: Could not read from remote repository.'),
    ).toBe('host_key');
    expect(
      classify(
        'sign_and_send_pubkey: signing failed for ED25519 "/k" from agent: agent refused operation\ngit@github.com: Permission denied (publickey).',
      ),
    ).toBe('auth');
    expect(classify("error: Couldn't load public key /k: No such file or directory?")).toBe(
      'signing',
    );
    expect(
      classify('error: gpg failed to sign the data:\ngpg: signing failed: No secret key'),
    ).toBe('signing');
    const failed = gitError(['fetch'], {
      code: 128,
      stdout: Buffer.from(''),
      stderr:
        "remote: denied for https://me:ghp_secret1@git.example.com/x.git\nfatal: Authentication failed for 'https://me:ghp_secret1@git.example.com/x.git/'",
    });
    expect(`${failed.message} ${failed.hostMessage ?? ''}`).not.toContain('ghp_secret1');
  });

  it('allows only https, ssh and file (and http for an http remote)', async () => {
    const sb = box();
    const remote = sb.bare('protocols');
    await transport(sb.dir, remote.url);
    const config = git(join(sb.dir, 'clone-a.git'), ['config', '--list']);
    expect(config).toContain('protocol.allow=never');
    for (const allowed of ['https', 'ssh', 'file']) {
      expect(config).toContain(`protocol.${allowed}.allow=always`);
    }
    expect(config).toContain('protocol.http.allow=never');
    expect(config).not.toMatch(/protocol\.ext\.allow=always/);
  });

  it("signs commits as the person's git config says, and never with sign: false", async () => {
    const sb = box();
    const key = join(sb.dir, 'signing');
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'test', '-f', key]);
    const signing = {
      GIT_CONFIG_COUNT: '3',
      GIT_CONFIG_KEY_0: 'commit.gpgSign',
      GIT_CONFIG_VALUE_0: 'true',
      GIT_CONFIG_KEY_1: 'gpg.format',
      GIT_CONFIG_VALUE_1: 'ssh',
      GIT_CONFIG_KEY_2: 'user.signingKey',
      GIT_CONFIG_VALUE_2: key,
    };
    const remote = sb.bare('signed');
    const signed = await transport(sb.dir, remote.url, { env: signing });
    const first = (await signed.commit(null, new Map([['x.md', encoder.encode('x')]]), 'first'))!;
    expect(git(join(sb.dir, 'clone-a.git'), ['cat-file', 'commit', first])).toContain(
      'gpgsig -----BEGIN SSH SIGNATURE',
    );
    await signed.push(first);
    const unsigned = await transport(sb.dir, remote.url, {
      env: signing,
      sign: false,
      name: 'b',
    });
    await unsigned.fetch();
    const second = (await unsigned.commit(
      first,
      new Map([['y.md', encoder.encode('y')]]),
      'second',
    ))!;
    expect(git(join(sb.dir, 'clone-b.git'), ['cat-file', 'commit', second])).not.toContain(
      'gpgsig',
    );
  });
});

describe('one clone, many calls (#170 F2: the config.lock race)', () => {
  it('writes its config once, and calls that overlap never collide on config.lock', async () => {
    const sb = box();
    const remote = sb.bare('notes');
    sb.colleague(remote.url).commit({ 'README.md': '# Notes\n' });
    // A git that logs each call, so the test sees which ones write the clone's config.
    const calls = join(sb.dir, 'calls.log');
    const wrapper = join(sb.dir, 'git-logging');
    const real = execFileSync('sh', ['-c', 'command -v git']).toString('utf8').trim();
    writeFileSync(wrapper, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\nexec '${real}' "$@"\n`);
    chmodSync(wrapper, 0o755);
    const make = () =>
      new NodeGitTransport({
        gitDir: join(sb.dir, 'clone.git'),
        remote: remote.url,
        branch: 'main',
        root: '',
        author: { name: 'Penmoss', email: 'penmoss@example.invalid' },
        gitPath: wrapper,
        env: ISOLATED,
      });
    const a = make();
    await a.init();
    const head = await a.fetch();
    const writes = () =>
      readFileSync(calls, 'utf8')
        .split('\n')
        .filter((line) =>
          /^--literal-pathspecs config (?!--get|--type=bool --get|--local)/.test(line),
        );
    const first = writes().length;
    expect(first).toBeGreaterThan(0);
    // The Mac calls init before every call (A853), and History reads while a sync runs.
    const rounds = await Promise.allSettled(
      Array.from({ length: 12 }, (_, i) =>
        i % 3 === 0 ? a.init() : i % 3 === 1 ? a.log({}) : a.fetch(),
      ),
    );
    expect(rounds.filter((round) => round.status === 'rejected')).toEqual([]);
    // Another transport on the same clone (a relaunch) writes nothing when nothing changed.
    const b = make();
    await Promise.all([b.init(), a.init(), b.log({}), a.read(head!, ['README.md'])]);
    expect(writes()).toHaveLength(first);
  });
});

describe('reads beside a sync (#174 review)', () => {
  /**
   * A git whose fetch waits while `hold` exists, having made `held`: History and Status must not
   * wait for it. Without `hold`, a fetch runs at once.
   */
  function heldFetchGit(dir: string) {
    const wrapper = join(dir, 'git-held-fetch');
    const hold = join(dir, 'hold');
    const held = join(dir, 'held');
    const real = execFileSync('sh', ['-c', 'command -v git']).toString('utf8').trim();
    writeFileSync(
      wrapper,
      `#!/bin/sh\ncase " $* " in *" fetch "*) if [ -e '${hold}' ]; then : > '${held}'; while [ -e '${hold}' ]; do sleep 0.02; done; fi ;; esac\nexec '${real}' "$@"\n`,
    );
    chmodSync(wrapper, 0o755);
    return { gitPath: wrapper, hold, held };
  }

  it('History and Status read while a fetch runs: log, readAt, head and storeBytes never queue', async () => {
    const sb = box();
    const remote = sb.bare('notes');
    sb.colleague(remote.url).commit({ 'README.md': '# Notes\n' });
    const slow = heldFetchGit(sb.dir);
    const t = new NodeGitTransport({
      gitDir: join(sb.dir, 'clone.git'),
      remote: remote.url,
      branch: 'main',
      root: '',
      author: { name: 'Penmoss', email: 'penmoss@example.invalid' },
      gitPath: slow.gitPath,
      env: ISOLATED,
    });
    await t.init();
    const head = (await t.fetch())!;
    await t.read(head, ['README.md']);
    // The next fetch is held inside git until the reads are done.
    writeFileSync(slow.hold, '');
    let fetched = false;
    const fetching = t.fetch().then(() => (fetched = true));
    await vi.waitFor(() => expect(existsSync(slow.held)).toBe(true), { interval: 10 });
    const started = Date.now();
    const [log, at, now, bytes] = await Promise.all([
      t.log({}),
      t.readAt(head, 'README.md'),
      t.head(),
      t.storeBytes(),
    ]);
    expect(Date.now() - started).toBeLessThan(1500);
    expect(fetched).toBe(false);
    expect(log.map((commit) => commit.id)).toEqual([head]);
    expect(new TextDecoder().decode(at!)).toBe('# Notes\n');
    expect(now).toBe(head);
    expect(bytes).toBeGreaterThan(0);
    rmSync(slow.hold);
    await fetching;
    expect(fetched).toBe(true);
  });

  it('puts back the protections someone changed by hand before the next fetch or push', async () => {
    const sb = box();
    const remote = sb.bare('notes');
    sb.colleague(remote.url).commit({ 'README.md': '# Notes\n' });
    const t = await transport(sb.dir, remote.url);
    await t.init();
    await t.fetch();
    const clone = join(sb.dir, 'clone-a.git');
    git(clone, ['config', '--local', 'core.hooksPath', join(sb.dir, 'hooks')]);
    git(clone, ['config', '--local', 'protocol.allow', 'always']);
    await t.fetch();
    expect(git(clone, ['config', '--local', 'core.hooksPath'])).toBe('/dev/null');
    expect(git(clone, ['config', '--local', 'protocol.allow'])).toBe('never');
  });
});

describe('FileStorage', () => {
  it('keeps the docs and bookkeeping between runs, and a crash between writes loses no mark', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'penmoss-storage-'));
    try {
      const storage = new FileStorage(dir);
      const engine = await GitNotebookEngine.open({
        transport: new MemoryTransport({ remote: new MemoryRemote(), branch: 'main', root: '' }),
        storage,
        secrets: new MemorySecrets(),
        writer: { kind: 'device', label: 'a' },
        create: NOTEBOOK,
      });
      const ops = new NotebookOps(engine);
      const id = ops.createNote({ title: 'Kept', markdown: 'kept' });
      await engine.save();
      const loaded = await new FileStorage(dir).load();
      expect([...loaded!.notes.keys()]).toEqual([id]);
      expect(Object.keys(loaded!.meta.dirty)).toEqual([id]);
      expect(await new FileStorage(dir).generation()).toBeGreaterThan(0);
      await storage.writeAttachment(`${'a'.repeat(64)}.png`, encoder.encode('png'));
      expect(decoder.decode((await storage.readAttachment(`${'a'.repeat(64)}.png`))!)).toBe('png');
      expect(await storage.readAttachment('../meta.json')).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the macOS preflight', () => {
  it('asks xcode-select before any git on a Mac, so git never opens the install dialog', async () => {
    const bin = mkdtempSync(join(tmpdir(), 'penmoss-xcode-'));
    const path = process.env['PATH'];
    try {
      process.env['PATH'] = bin;
      // No xcode-select (or no tools): a readable error, not git's dialog.
      await expect(preflight('darwin')).rejects.toMatchObject({
        code: 'git_missing',
        message: expect.stringContaining('xcode-select --install') as string,
      });
      writeFileSync(join(bin, 'xcode-select'), '#!/bin/sh\nexit 2\n');
      chmodSync(join(bin, 'xcode-select'), 0o755);
      await expect(preflight('darwin')).rejects.toMatchObject({ code: 'git_missing' });
      writeFileSync(join(bin, 'xcode-select'), '#!/bin/sh\nexit 0\n');
      await expect(preflight('darwin')).resolves.toBeUndefined();
      // Elsewhere, and for a git the user named, nothing is asked.
      rmSync(join(bin, 'xcode-select'));
      await expect(preflight('linux')).resolves.toBeUndefined();
      await expect(preflight('darwin', '/opt/homebrew/bin/git')).resolves.toBeUndefined();
    } finally {
      process.env['PATH'] = path;
      rmSync(bin, { recursive: true, force: true });
    }
  });

  it('reports a signer that waits for a person as a signing failure, quickly where asked', async () => {
    const sb = box();
    const key = join(sb.dir, 'signing');
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'test', '-f', key]);
    // A signer stuck on a prompt nobody answers (pinentry, Touch ID, 1Password).
    const signer = join(sb.dir, 'signer.sh');
    writeFileSync(signer, '#!/bin/sh\nexec sleep 30\n');
    chmodSync(signer, 0o755);
    const remote = sb.bare('waits');
    const waiting = await transport(sb.dir, remote.url, {
      signTimeoutMs: 1_000,
      env: {
        GIT_CONFIG_COUNT: '4',
        GIT_CONFIG_KEY_0: 'commit.gpgSign',
        GIT_CONFIG_VALUE_0: 'true',
        GIT_CONFIG_KEY_1: 'gpg.format',
        GIT_CONFIG_VALUE_1: 'ssh',
        GIT_CONFIG_KEY_2: 'user.signingKey',
        GIT_CONFIG_VALUE_2: key,
        GIT_CONFIG_KEY_3: 'gpg.ssh.program',
        GIT_CONFIG_VALUE_3: signer,
      },
    });
    const started = Date.now();
    const error = await waiting
      .commit(null, new Map([['x.md', encoder.encode('x')]]), 'first')
      .catch((e: unknown) => e);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(error).toBeInstanceOf(GitTransportError);
    expect((error as GitTransportError).code).toBe('signing');
    expect((error as Error).message).toContain('--no-sign');
  });
});
