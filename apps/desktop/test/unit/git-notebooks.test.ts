/**
 * Git notebooks in the Mac app's main process (T50 G3, G5; A853–A857): the list, tokens that
 * never come back, and the transport calls the page's engine makes. No privacy check (D61) and no
 * refusal of git's own rewrites (D62). Real git against `file://` bare repositories.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkWords,
  commitAuthor,
  fitWords,
  cleanDir,
  noteWords,
  GitNotebooks,
  repositoryName,
  withCadence,
  type GitNotebookEntry,
  type GitNotebooksOptions,
  type OwnerCheck,
} from '../../src/git-notebooks';
import { GitProcessFile, isGitCommand, probeProcess } from '../../src/git-processes';
import {
  GitNotebookEngine,
  isPurged,
  MemorySecrets,
  Layout,
  markRecoveredFrom,
  MemoryStorage,
  NotebookOps,
  unmarkPurged,
} from '@penmoss/git-notebook';
import type { DesktopGit } from '../../../web/src/desktop/bridge';
import { IpcGitTransport } from '../../../web/src/sources/ipc-transport';

const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };

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
  dir = mkdtempSync(join(tmpdir(), 'penmoss-desktop-git-'));
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

/** A sealed value: reversible only by `unseal`, and never the plain text. */
const seal = (plain: string) => Promise.resolve(`sealed:${Buffer.from(plain).toString('base64')}`);
const unseal = (sealed: string) =>
  Promise.resolve(
    sealed.startsWith('sealed:') ? Buffer.from(sealed.slice(7), 'base64').toString() : null,
  );

function service(
  overrides: Partial<GitNotebooksOptions> & { owner?: OwnerCheck } = {},
): GitNotebooks & { asked: string[] } {
  const asked: string[] = [];
  const owner: OwnerCheck = overrides.owner ?? (() => Promise.resolve({ ok: true }));
  const notebooks = new GitNotebooks({
    dir: join(dir, 'userData'),
    seal,
    unseal,
    ownerCheck: (words) => {
      asked.push(words);
      return owner(words);
    },
    platform: 'linux',
    gitEnv: GIT_ENV,
    ...overrides,
  });
  return Object.assign(notebooks, { asked });
}

describe('adding a git notebook (A856)', { timeout: 30_000 }, () => {
  it('asks for a name when the target holds none, then makes the notebook there', async () => {
    const remote = bare('notes');
    const notebooks = service();
    // Nobody is asked about the repository, and nor is GitHub (D61).
    const first = await notebooks.add({ remote, branch: 'main', dir: '' });
    expect(first).toEqual({ ok: true, value: { kind: 'needs-name' } });
    expect(notebooks.asked).toEqual([]);
    // Nothing is kept for a notebook that was not added.
    expect(await notebooks.list()).toEqual([]);
    const added = await notebooks.add({
      remote,
      branch: 'main',
      dir: '',
      name: 'Home',
    });
    expect(added.ok && added.value.kind).toBe('added');
    if (!added.ok || added.value.kind !== 'added') return;
    expect(added.value.created).toBe(true);
    expect(added.value.notebook).toMatchObject({
      name: 'Home',
      create: true,
      branch: 'main',
      dir: '',
      // A1013: pushed 12 s after edits settle, pulled every minute while the app is in front.
      pushDelayS: 12,
      pullEveryMin: 1,
      hasToken: false,
    });
    expect(added.value.notebook.notebookId).toMatch(/^[0-9A-Z]{26}$/);
    expect(existsSync(join(notebooks.cloneDir(added.value.notebook.localId), 'repo.git'))).toBe(
      true,
    );
    // The same target again is refused.
    const again = await notebooks.add({
      remote,
      branch: 'main',
      dir: '',
      name: 'Again',
    });
    expect(again).toMatchObject({ ok: false, error: { code: 'notebook_exists' } });
  });

  it('joins the notebook the target holds, under its own id and name', async () => {
    const remote = bare('shared');
    const work = join(dir, 'work');
    git(dir, ['clone', '--quiet', remote, work]);
    git(work, ['checkout', '-q', '-b', 'main']);
    const id = '01JBNOTEBOOK00000000000042';
    writeFileSync(join(dir, 'nb.json'), JSON.stringify({ id, name: 'Team notes' }));
    spawnSync('mkdir', ['-p', join(work, 'docs/notes/.penmoss')]);
    writeFileSync(
      join(work, 'docs/notes/.penmoss/notebook.json'),
      JSON.stringify({ format: 1, id, name: 'Team notes' }),
    );
    git(work, ['add', '.']);
    git(work, ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'nb']);
    git(work, ['push', '-q', 'origin', 'main']);
    const notebooks = service();
    const added = await notebooks.add({
      remote,
      branch: 'main',
      dir: '/docs/notes/',
    });
    expect(added).toMatchObject({
      ok: true,
      value: {
        kind: 'added',
        created: false,
        notebook: { notebookId: id, name: 'Team notes', dir: 'docs/notes' },
      },
    });
  });

  it('refuses a remote with credentials in it, a bad branch or a directory outside', async () => {
    const notebooks = service();
    await expect(
      notebooks.add({
        remote: 'https://me:secret@github.com/me/notes.git',
        branch: 'main',
        dir: '',
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'remote_credentials' } });
    await expect(
      notebooks.add({ remote: 'not a remote', branch: 'main', dir: '' }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'invalid_remote' } });
    await expect(
      notebooks.add({ remote: bare('b'), branch: '--upload-pack=evil', dir: '' }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'invalid_branch' } });
    await expect(
      notebooks.add({ remote: bare('c'), branch: 'main', dir: '../up' }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'invalid_dir' } });
  });
});

describe(
  'no privacy check: any repository syncs, and GitHub is never asked (D61)',
  { timeout: 30_000 },
  () => {
    it('adds and fetches any repository without a request to GitHub', async () => {
      const remote = bare('anything');
      const fetch = vi.fn(() => Promise.reject(new Error('no network in tests')));
      vi.stubGlobal('fetch', fetch);
      try {
        const notebooks = service();
        const added = await notebooks.add({ remote, branch: 'main', dir: '', name: 'Work' });
        expect(added).toMatchObject({ ok: true, value: { kind: 'added' } });
        if (!added.ok || added.value.kind !== 'added') return;
        expect(added.value.notebook).not.toHaveProperty('privacy');
        await expect(notebooks.op(added.value.notebook.localId, 'fetch', [])).resolves.toEqual({
          ok: true,
          value: null,
        });
        expect(fetch).not.toHaveBeenCalled();
        expect(notebooks.asked).toEqual([]);
        const registry = readFileSync(join(dir, 'userData', 'git-notebooks.json'), 'utf8');
        expect(registry).not.toContain('"confirmed"');
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('an old registry with a stored confirmation still loads, and the next write drops it', async () => {
      const remote = bare('old');
      const notebooks = service();
      const added = await notebooks.add({ remote, branch: 'main', dir: '', name: 'Old' });
      if (!added.ok || added.value.kind !== 'added') throw new Error('not added');
      const id = added.value.notebook.localId;
      const path = join(dir, 'userData', 'git-notebooks.json');
      const registry = JSON.parse(readFileSync(path, 'utf8')) as {
        notebooks: Array<Record<string, unknown>>;
      };
      // As a Mac before D51 kept it: sealed, bound to the notebook and its remote.
      registry.notebooks[0]!['confirmed'] = await seal(
        JSON.stringify({ localId: id, remote, at: 1_700_000_000_000 }),
      );
      writeFileSync(path, JSON.stringify(registry));
      const fresh = service();
      const listed = await fresh.list();
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({ localId: id, name: 'Old' });
      expect(JSON.stringify(listed)).not.toContain('confirmed');
      await expect(fresh.op(id, 'fetch', [])).resolves.toMatchObject({ ok: true });
      await expect(fresh.update(id, { pullEveryMin: 5 })).resolves.toMatchObject({ ok: true });
      const written = readFileSync(path, 'utf8');
      expect(written).not.toContain('"confirmed"');
      expect(written).toContain('"pullEveryMin": 5');
      expect(fresh.asked).toEqual([]);
    });
  },
);

describe('tokens, removing, and the engine’s calls', { timeout: 30_000 }, () => {
  async function added(notebooks: GitNotebooks, name = 'Home') {
    const result = await notebooks.add({
      remote: bare(name.toLowerCase()),
      branch: 'main',
      dir: '',
      name,
    });
    if (!result.ok || result.value.kind !== 'added') throw new Error('not added');
    return result.value.notebook;
  }

  it('keeps a token sealed and never gives it back', async () => {
    const notebooks = service();
    const notebook = await added(notebooks);
    await expect(notebooks.setToken(notebook.localId, 'ghp_secretsecret123')).resolves.toEqual({
      ok: true,
      value: null,
    });
    const listed = await notebooks.list();
    expect(listed[0]!.hasToken).toBe(true);
    expect(JSON.stringify(listed)).not.toContain('ghp_secretsecret123');
    const secrets = readFileSync(join(dir, 'userData', 'git-secrets.json'), 'utf8');
    expect(secrets).not.toContain('ghp_secretsecret123');
    await expect(notebooks.setToken(notebook.localId, 'no')).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid_token' },
    });
    await notebooks.setToken(notebook.localId, null);
    expect((await notebooks.list())[0]!.hasToken).toBe(false);
  });

  it('a notebook added with Penmoss’s GitHub sign-in has its token from the start (T82, A1171)', async () => {
    const notebooks = service();
    const remote = bare('signed-in');
    const token = 'gho_signedin0token0000000000000000000';
    // The target holds no notebook yet: nothing is kept for one that was not added.
    const first = await notebooks.add({ remote, branch: 'main', dir: '', token });
    expect(first).toEqual({ ok: true, value: { kind: 'needs-name' } });
    const secretsFile = join(dir, 'userData', 'git-secrets.json');
    const kept = () => (existsSync(secretsFile) ? readFileSync(secretsFile, 'utf8') : '');
    expect(kept()).not.toContain('token:');
    const added = await notebooks.add({ remote, branch: 'main', dir: '', name: 'Home', token });
    expect(added.ok && added.value.kind === 'added' && added.value.notebook.hasToken).toBe(true);
    expect((await notebooks.list())[0]!.hasToken).toBe(true);
    expect(kept()).not.toContain(token);
    // One that is not a token is not kept, and the notebook is added without one.
    const plain = await notebooks.add({
      remote: bare('plain'),
      branch: 'main',
      dir: '',
      name: 'Plain',
      token: 'not a token',
    });
    expect(plain.ok && plain.value.kind === 'added' && plain.value.notebook.hasToken).toBe(false);
  });

  it('keeps nothing when the Keychain cannot seal', async () => {
    // The Keychain is there at add, then is gone.
    let keychain = true;
    const notebooks = service({
      seal: (plain) => (keychain ? seal(plain) : Promise.resolve(null)),
    });
    const notebook = await added(notebooks);
    keychain = false;
    await expect(
      notebooks.setToken(notebook.localId, 'ghp_secretsecret123'),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'no_keychain' },
    });
  });

  it('removes only after the owner check, and then forgets the clone and its secrets', async () => {
    let yes = true;
    const notebooks = service({
      owner: () =>
        Promise.resolve(
          yes
            ? { ok: true }
            : { ok: false, message: 'Not done: this Mac did not confirm it was you.' },
        ),
    });
    const notebook = await added(notebooks, 'Diary');
    yes = false;
    await notebooks.setToken(notebook.localId, 'ghp_secretsecret123');
    await expect(notebooks.remove(notebook.localId)).resolves.toMatchObject({
      ok: false,
      error: { code: 'not_confirmed' },
    });
    expect(await notebooks.list()).toHaveLength(1);
    // Main's own words, naming the repository (a notebook's name is the repository's to set).
    expect(notebooks.asked.at(-1)).toBe(
      `remove the git notebook at ${join(dir, 'diary.git')} on this Mac from this Mac`,
    );
    yes = true;
    await expect(notebooks.remove(notebook.localId)).resolves.toEqual({
      ok: true,
      value: { notebookId: notebook.notebookId },
    });
    expect(await notebooks.list()).toEqual([]);
    expect(existsSync(notebooks.cloneDir(notebook.localId))).toBe(false);
    expect(readFileSync(join(dir, 'userData', 'git-secrets.json'), 'utf8')).not.toContain('token:');
  });

  it('runs the engine’s calls: commit, push, list, read and log', async () => {
    const notebooks = service();
    const notebook = await added(notebooks);
    const id = notebook.localId;
    const bytes = new TextEncoder().encode('{"format":1}');
    const commit = await notebooks.op(id, 'commit', [
      null,
      [['.penmoss/notebook.json', bytes]],
      'Penmoss: first',
    ]);
    expect(commit.ok).toBe(true);
    const sha = commit.ok ? (commit.value as string) : '';
    await expect(notebooks.op(id, 'push', [sha])).resolves.toEqual({ ok: true, value: 'pushed' });
    await expect(notebooks.op(id, 'fetch', [])).resolves.toEqual({ ok: true, value: sha });
    const listed = await notebooks.op(id, 'list', [sha]);
    expect(listed.ok && (listed.value as Array<[string, string]>).map(([path]) => path)).toEqual([
      '.penmoss/notebook.json',
    ]);
    const read = await notebooks.op(id, 'read', [sha, ['.penmoss/notebook.json']]);
    expect(
      read.ok && new TextDecoder().decode((read.value as Array<[string, Uint8Array]>)[0]![1]),
    ).toBe('{"format":1}');
    const log = await notebooks.op(id, 'log', [{ limit: 5 }]);
    expect(log.ok && (log.value as Array<{ message: string }>)[0]!.message).toBe('Penmoss: first');
  });

  it('refuses calls it does not know and arguments that are not what git takes', async () => {
    const notebooks = service();
    const notebook = await added(notebooks);
    await expect(notebooks.op(notebook.localId, 'gc', [])).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid_request' },
    });
    await expect(
      notebooks.op(notebook.localId, 'list', ['--output=/etc/passwd']),
    ).resolves.toMatchObject({ ok: false, error: { code: 'git' } });
    await expect(notebooks.op('../../etc', 'fetch', [])).resolves.toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    });
    await expect(
      notebooks.op(notebook.localId, 'commit', [null, [['../outside', new Uint8Array(1)]], 'x']),
    ).resolves.toMatchObject({ ok: false, error: { code: 'git' } });
  });

  it('moves a notebook still on the old defaults to the new cadence once (A1013)', async () => {
    const notebooks = service();
    const notebook = await added(notebooks);
    // A registry from before T57: the old defaults, and one set by hand.
    const path = join(dir, 'userData', 'git-notebooks.json');
    const registry = JSON.parse(readFileSync(path, 'utf8')) as { notebooks: GitNotebookEntry[] };
    const old = { ...registry.notebooks[0]!, pushDelayS: 60, pullEveryMin: 2 };
    delete (old as { cadence?: 2 }).cadence;
    writeFileSync(path, JSON.stringify({ version: 1, notebooks: [old] }));
    expect((await notebooks.list())[0]).toMatchObject({ pushDelayS: 12, pullEveryMin: 1 });
    // Once moved, 60 s and 2 min set again are kept.
    await notebooks.update(notebook.localId, { pushDelayS: 60, pullEveryMin: 2 });
    expect((await notebooks.list())[0]).toMatchObject({ pushDelayS: 60, pullEveryMin: 2 });
    // One set to something else before T57 keeps it.
    const own = { ...old, pushDelayS: 30, pullEveryMin: 2 };
    expect(withCadence(own)).toMatchObject({ pushDelayS: 30, pullEveryMin: 2, cadence: 2 });
  });

  it('keeps the cadence in range', async () => {
    const notebooks = service();
    const notebook = await added(notebooks);
    await expect(
      notebooks.update(notebook.localId, { pushDelayS: 30, pullEveryMin: 5, sign: false }),
    ).resolves.toMatchObject({ ok: true, value: { pushDelayS: 30, pullEveryMin: 5, sign: false } });
    await expect(notebooks.update(notebook.localId, { pushDelayS: 1 })).resolves.toMatchObject({
      ok: false,
    });
    await expect(notebooks.update(notebook.localId, { pullEveryMin: 0 })).resolves.toMatchObject({
      ok: false,
    });
  });
});

describe(
  'Delete for good only for a note the owner confirmed (A828, A855)',
  { timeout: 30_000 },
  () => {
    /** The page's engine over main's calls, as the IPC transport makes them. */
    async function pageEngine(notebooks: GitNotebooks, localId: string, create?: string) {
      const bridge = {
        op: (id: string, op: string, args: readonly unknown[]) => notebooks.op(id, op, args),
      } as unknown as DesktopGit;
      const storage = new MemoryStorage();
      const engine = await GitNotebookEngine.open({
        transport: new IpcGitTransport(bridge, localId, ''),
        storage,
        secrets: new MemorySecrets(),
        writer: { kind: 'device', label: 'Penmoss for Mac' },
        ...(create ? { create: { id: create, name: 'Home' } } : {}),
      });
      return { engine, storage, ops: new NotebookOps(engine) };
    }

    it('a commit that adds a copy of a note deleted for good is refused (A886)', async () => {
      const notebooks = service();
      const result = await notebooks.add({
        remote: bare('raced'),
        branch: 'main',
        dir: '',
        name: 'Home',
      });
      if (!result.ok || result.value.kind !== 'added') throw new Error('not added');
      const { localId, notebookId } = result.value.notebook;
      const { engine, storage, ops } = await pageEngine(notebooks, localId, notebookId);
      const secret = ops.createNote({ title: 'Passwords', markdown: 'hunter2' });
      await engine.sync();
      ops.purge(secret);
      await notebooks.purgeCheck(localId, secret);
      await engine.sync();
      // A page script brings it back as a copy, linked to the original, and commits it itself.
      const copy = ops.createNote({ title: 'Passwords (recovered)', markdown: 'hunter2' });
      markRecoveredFrom(engine.replica.workspace, copy, secret);
      const head = await notebooks.op(localId, 'fetch', []);
      if (!head.ok) throw new Error('no head');
      const layout = new Layout('');
      const writer = engine.writer!.id;
      await engine.save();
      const saved = storage.snapshot!;
      await expect(
        notebooks.op(localId, 'commit', [
          head.value,
          [
            [layout.workspace(writer), saved.workspace!],
            [layout.note(copy, writer), new Map(saved.notes).get(copy)!],
          ],
          'A copy of a secret',
        ]),
      ).resolves.toMatchObject({ ok: false, error: { code: 'purge_raced' } });
      // The engine itself never sends one: it withholds the copy, kept in its own store on this
      // Mac, and nothing of it reaches the branch.
      await engine.sync();
      expect(engine.replica.note(copy)).toBeUndefined();
      expect(engine.withheld()[copy]).toMatchObject({
        origin: secret,
        title: 'Passwords (recovered)',
      });
      const remote = join(dir, 'raced.git');
      expect(git(remote, ['ls-tree', '-r', '--name-only', 'main'])).not.toContain('Passwords');
      // Nothing at head holds its text (git grep finds nothing: status 1).
      expect(spawnSync('git', ['grep', '-q', 'hunter2', 'main'], { cwd: remote }).status).toBe(1);
    }, 30_000);

    it('a commit that takes back a Delete for good that landed is refused', async () => {
      const notebooks = service();
      const result = await notebooks.add({
        remote: bare('reverse'),
        branch: 'main',
        dir: '',
        name: 'Home',
      });
      if (!result.ok || result.value.kind !== 'added') throw new Error('not added');
      const { localId, notebookId } = result.value.notebook;
      const { engine, storage, ops } = await pageEngine(notebooks, localId, notebookId);
      const secret = ops.createNote({ title: 'Secret', markdown: 'deleted words' });
      await engine.sync();
      ops.purge(secret);
      await notebooks.purgeCheck(localId, secret);
      await engine.sync();
      const remote = join(dir, 'reverse.git');
      expect(git(remote, ['ls-tree', '-r', '--name-only', 'main'])).not.toContain('Secret.md');
      // A page script takes the mark back and commits its own workspace log without it.
      unmarkPurged(engine.replica.workspace, secret);
      const head = await notebooks.op(localId, 'fetch', []);
      if (!head.ok) throw new Error('no head');
      const path = `.penmoss/workspace/${engine.writer!.id}.yjs`;
      await engine.save();
      const bytes = storage.snapshot!.workspace!;
      await expect(
        notebooks.op(localId, 'commit', [head.value, [[path, bytes]], 'Keep a secret']),
      ).resolves.toMatchObject({ ok: false, error: { code: 'purge_reversed' } });
      // The engine itself never sends one: it marks the note again, and the note stays gone.
      await engine.sync();
      expect(isPurged(engine.replica.workspace, secret)).toBe(true);
      expect(git(remote, ['ls-tree', '-r', '--name-only', 'main'])).not.toContain('Secret.md');
    }, 30_000);

    it('History’s restore and revert ask the owner, naming the note from the branch, as Android does (A901)', async () => {
      let answer = true;
      const notebooks = service({
        owner: () => Promise.resolve(answer ? { ok: true } : { ok: false, message: 'Not done.' }),
      });
      const result = await notebooks.add({
        remote: bare('restore'),
        branch: 'main',
        dir: '',
        name: 'Home',
      });
      if (!result.ok || result.value.kind !== 'added') throw new Error('not added');
      const { localId, notebookId } = result.value.notebook;
      const { engine, ops } = await pageEngine(notebooks, localId, notebookId);
      const plan = ops.createNote({ title: 'Plan', markdown: 'first' });
      await engine.sync();
      const remote = join(dir, 'restore.git');
      await expect(notebooks.restoreCheck(localId, plan, false)).resolves.toEqual({
        ok: true,
        value: null,
      });
      expect(notebooks.asked.at(-1)).toBe(
        fitWords(
          'restore an earlier version (the note as it is now is saved as a version first) in the git notebook at ',
          `${remote} on this Mac`,
          ': [\u2068Plan\u2069]',
        ),
      );
      await notebooks.restoreCheck(localId, plan, true);
      expect(notebooks.asked.at(-1)).toContain('undo an earlier change');
      answer = false;
      await expect(notebooks.restoreCheck(localId, plan, false)).resolves.toMatchObject({
        ok: false,
        error: { code: 'not_confirmed' },
      });
      await expect(notebooks.restoreCheck(localId, 'not an id', false)).resolves.toMatchObject({
        ok: false,
        error: { code: 'invalid_request' },
      });
    });

    it('a sync that deletes a note for good is refused until Touch ID confirmed that note', async () => {
      const notebooks = service();
      const result = await notebooks.add({
        remote: bare('purge'),
        branch: 'main',
        dir: '',
        name: 'Home',
      });
      if (!result.ok || result.value.kind !== 'added') throw new Error('not added');
      const { localId, notebookId } = result.value.notebook;
      const { engine, ops } = await pageEngine(notebooks, localId, notebookId);
      const keep = ops.createNote({ title: 'Keep', markdown: 'kept' });
      const gone = ops.createNote({ title: 'Gone', markdown: 'secret' });
      await engine.sync();
      // A script in the page marks a note purged and syncs, as Delete for good would: refused.
      ops.purge(gone);
      await expect(engine.sync()).rejects.toMatchObject({ code: 'purge_unconfirmed' });
      const remote = join(dir, 'purge.git');
      expect(git(remote, ['ls-tree', '-r', '--name-only', 'main'])).toContain('Gone.md');
      // A page script asks for another note's id: Touch ID names that note, as the branch has it.
      await expect(notebooks.purgeCheck(localId, keep)).resolves.toEqual({ ok: true, value: null });
      expect(notebooks.asked.at(-1)).toBe(
        fitWords(
          'delete 1 note for good (git history keeps it) in the git notebook at ',
          `${remote} on this Mac`,
          ': [\u2068Keep\u2069]',
        ),
      );
      // Confirmed for another note: still refused.
      await expect(engine.sync()).rejects.toMatchObject({ code: 'purge_unconfirmed' });
      // Confirmed for this one, in main's own words: it lands, and the confirmation is spent.
      await expect(notebooks.purgeCheck(localId, gone)).resolves.toEqual({ ok: true, value: null });
      expect(notebooks.asked.at(-1)).toBe(
        fitWords(
          'delete 1 note for good (git history keeps it) in the git notebook at ',
          `${remote} on this Mac`,
          ': [\u2068Gone\u2069]',
        ),
      );
      await engine.sync();
      expect(git(remote, ['ls-tree', '-r', '--name-only', 'main'])).not.toContain('Gone.md');
      const registry = JSON.parse(
        readFileSync(join(dir, 'userData', 'git-notebooks.json'), 'utf8'),
      ) as { notebooks: Array<{ purges?: Array<{ id: string }> }> };
      expect(registry.notebooks[0]!.purges?.map((one) => one.id)).toEqual([keep]);
      // A note not on the branch has no title main can read: never one the page gives.
      const unsynced = ops.createNote({ title: 'Only in the page', markdown: 'x' });
      await notebooks.purgeCheck(localId, unsynced);
      expect(notebooks.asked.at(-1)).toContain(
        `on this Mac: an untitled note (…${unsynced.slice(-6)})`,
      );
      // A refused owner check confirms nothing.
      const refusing = service({
        owner: () => Promise.resolve({ ok: false, message: 'Not done.' }),
      });
      await expect(refusing.purgeCheck(localId, keep)).resolves.toMatchObject({
        ok: false,
        error: { code: 'not_confirmed' },
      });
      await expect(notebooks.purgeCheck(localId, '../x')).resolves.toMatchObject({
        ok: false,
        error: { code: 'invalid_request' },
      });
    }, 30_000);
  },
);

describe('the note an owner check names (A855)', () => {
  const id = '01JBN000000000000000ABCDEF';
  const named = (title: string) => `[\u2068${title}\u2069]`;

  it('brackets and isolates the title, without control, bidi, bracket or quote look-alikes', () => {
    expect(noteWords(id, 'Plan')).toBe(named('Plan'));
    expect(noteWords(id, "Ryan's plan")).toBe(named("Ryan's plan"));
    expect(noteWords(id, 'a\u202Eevil\u200B "x"\nline')).toBe(named('a evil x line'));
    expect(noteWords(id, 'x'.repeat(80))).toBe(named(`${'x'.repeat(59)}…`));
    expect(noteWords(id, '  \u200B ')).toBe('an untitled note (…ABCDEF)');
    expect(noteWords(id, undefined)).toBe('an untitled note (…ABCDEF)');
  });

  it('a title made to look like the words around it stays inside its brackets', () => {
    const spoof =
      'x＂❞〞″] (git history keeps it), in the git notebook at github.com/me/public [ שלום';
    const words = noteWords(id, spoof);
    const clean = 'x (git history keeps it), in the git notebook at github.com/me/public שלום';
    expect(words).toBe(named(`${clean.slice(0, 59)}…`));
    expect(words.slice(2, -2)).not.toMatch(/["“”＂❞〞″[\]\u2066-\u2069\u202A-\u202E]/u);
    // The real path comes before the title: a long title is what the 200-character cut trims.
    const full = checkWords(
      `delete 1 note for good (git history keeps it) in the git notebook at github.com/htxryan/notes: ${noteWords(id, 'y'.repeat(60) + spoof)}`,
    );
    expect(full).toMatch(
      /^delete 1 note for good \(git history keeps it\) in the git notebook at github\.com\/htxryan\/notes: \[\u2068y/u,
    );
    expect(full.length).toBeLessThanOrEqual(200);
  });

  it('a long path is shortened in its middle, so the note is always named whole', () => {
    const path = `/Users/ryan/${'deep/'.repeat(40)}notes.git on this Mac`;
    const title = noteWords(id, 'z'.repeat(70));
    const words = fitWords(
      'delete 1 note for good (git history keeps it) in the git notebook at ',
      path,
      `: ${title}`,
    );
    expect(words.length).toBeLessThanOrEqual(200);
    expect(words.endsWith(`: ${title}`)).toBe(true);
    expect(words).toMatch(
      /^delete 1 note for good \(git history keeps it\) in the git notebook at \/Users\/ryan\/deep\/.*….*notes\.git on this Mac: /u,
    );
    // Short enough: nothing is cut.
    expect(fitWords('remove ', 'github.com/htxryan/notes', ' from this Mac')).toBe(
      'remove github.com/htxryan/notes from this Mac',
    );
  });

  it('a cut never lands inside an isolated title, nor inside a character', () => {
    const title = noteWords(id, 'Plan');
    const words = checkWords(`${'w'.repeat(195)} ${title}`);
    expect(words).toBe(`${'w'.repeat(195)}…`);
    expect(words).not.toMatch(/[\u2068\u2069[]/u);
    const emoji = checkWords(`${'e'.repeat(196)}😀😀😀😀`);
    expect(emoji).toBe(`${'e'.repeat(196)}…`);
  });
});

describe('a Delete for good confirmation runs out (A855)', { timeout: 30_000 }, () => {
  it('after 10 minutes a sync is refused; confirming again, for what has not landed, lets it go', async () => {
    let now = Date.parse('2026-10-29T12:00:00Z');
    const notebooks = service({ now: () => now });
    const result = await notebooks.add({
      remote: bare('ttl'),
      branch: 'main',
      dir: '',
      name: 'Home',
    });
    if (!result.ok || result.value.kind !== 'added') throw new Error('not added');
    const { localId, notebookId } = result.value.notebook;
    const bridge = {
      op: (id: string, op: string, args: readonly unknown[]) => notebooks.op(id, op, args),
    } as unknown as DesktopGit;
    const engine = await GitNotebookEngine.open({
      transport: new IpcGitTransport(bridge, localId, ''),
      storage: new MemoryStorage(),
      secrets: new MemorySecrets(),
      writer: { kind: 'device', label: 'Penmoss for Mac' },
      create: { id: notebookId, name: 'Home' },
    });
    const ops = new NotebookOps(engine);
    const old = ops.createNote({ title: 'Old', markdown: 'gone before' });
    const gone = ops.createNote({ title: 'Gone', markdown: 'secret' });
    await engine.sync();
    ops.purge(old);
    await notebooks.purgeCheck(localId, old);
    await engine.sync();
    // Confirmed, then the sync waits past the limit (offline for a while).
    await notebooks.purgeCheck(localId, gone);
    ops.purge(gone);
    now += 11 * 60_000;
    await expect(engine.sync()).rejects.toMatchObject({ code: 'purge_unconfirmed' });
    // Settings names it from the branch, as confirmed once already.
    await expect(notebooks.purgesToConfirm(localId)).resolves.toEqual({
      ok: true,
      value: [{ id: gone, title: 'Gone', confirmedBefore: true }],
    });
    const asked = notebooks.asked.length;
    // A list with a note never confirmed here is refused whole, and nobody is asked.
    const never = ops.createNote({ title: 'Never', markdown: 'kept' });
    await expect(notebooks.purgeCheck(localId, [gone, never])).resolves.toMatchObject({
      ok: false,
      error: { code: 'never_confirmed' },
    });
    expect(notebooks.asked.length).toBe(asked);
    // Confirming again asks once, for the note not deleted yet, not for one that landed.
    await expect(notebooks.purgeCheck(localId, [old, gone])).resolves.toEqual({
      ok: true,
      value: null,
    });
    // At most 200 characters: a long path is cut in its middle, never the count (A885).
    const again = notebooks.asked.slice(asked);
    expect(again).toEqual([
      fitWords(
        'delete 1 note for good, confirmed once already on this Mac (git history keeps it), in the git notebook at ',
        `${join(dir, 'ttl.git')} on this Mac`,
        '',
      ),
    ]);
    expect(again[0]!.length).toBeLessThanOrEqual(200);
    expect(again[0]).toMatch(
      /^delete 1 note for good, confirmed once already on this Mac .*ttl\.git on this Mac$/u,
    );
    // Still within its new 10 minutes: nothing to ask again.
    await expect(notebooks.purgeCheck(localId, [gone])).resolves.toEqual({ ok: true, value: null });
    expect(notebooks.asked.length).toBe(asked + 1);
    await engine.sync();
    expect(git(join(dir, 'ttl.git'), ['ls-tree', '-r', '--name-only', 'main'])).not.toContain(
      'Gone.md',
    );
  }, 30_000);

  it('a page that empties another writer’s log is refused', async () => {
    const notebooks = service();
    const result = await notebooks.add({
      remote: bare('wipe'),
      branch: 'main',
      dir: '',
      name: 'Home',
    });
    if (!result.ok || result.value.kind !== 'added') throw new Error('not added');
    const { localId, notebookId } = result.value.notebook;
    const bridge = {
      op: (id: string, op: string, args: readonly unknown[]) => notebooks.op(id, op, args),
    } as unknown as DesktopGit;
    const engine = await GitNotebookEngine.open({
      transport: new IpcGitTransport(bridge, localId, ''),
      storage: new MemoryStorage(),
      secrets: new MemorySecrets(),
      writer: { kind: 'device', label: 'Penmoss for Mac' },
      create: { id: notebookId, name: 'Home' },
    });
    const id = new NotebookOps(engine).createNote({ title: 'Kept', markdown: 'kept' });
    await engine.sync();
    const head = (await notebooks.op(localId, 'fetch', [])) as { ok: true; value: string };
    const listed = (await notebooks.op(localId, 'list', [head.value])) as {
      ok: true;
      value: Array<[string, string]>;
    };
    const log = listed.value.map(([path]) => path).find((path) => path.includes(`/notes/${id}/`))!;
    const empty = new Uint8Array([0, 0]);
    await expect(
      notebooks.op(localId, 'commit', [head.value, [[log, empty]], 'Penmoss: wipe']),
    ).resolves.toMatchObject({ ok: false, error: { code: 'log_shrunk' } });
  }, 30_000);
});

describe('an agent writer never marks a change undone (#174 delta review)', () => {
  it('main refuses an agent’s commit that adds an undo mark; a person’s goes through', async () => {
    const notebooks = service();
    const result = await notebooks.add({
      remote: bare('marks'),
      branch: 'main',
      dir: '',
      name: 'Home',
    });
    if (!result.ok || result.value.kind !== 'added') throw new Error('not added');
    const { localId, notebookId } = result.value.notebook;
    const bridge = {
      op: (id: string, op: string, args: readonly unknown[]) => notebooks.op(id, op, args),
    } as unknown as DesktopGit;
    const mac = await GitNotebookEngine.open({
      transport: new IpcGitTransport(bridge, localId, ''),
      storage: new MemoryStorage(),
      secrets: new MemorySecrets(),
      writer: { kind: 'device', label: 'Penmoss for Mac' },
      create: { id: notebookId, name: 'Home' },
    });
    new NotebookOps(mac).createFolder({ name: 'Projects', parentId: null });
    await mac.sync();
    const fetchHead = async () =>
      ((await notebooks.op(localId, 'fetch', [])) as { ok: true; value: string }).value;
    const made = await fetchHead();
    // The person's own writer marks one as Undo does: through.
    mac.replica.workspace.get('agentUndone').setAttr(made, { at: 2, by: 'Ryan' });
    await mac.sync();
    const marked = await fetchHead();
    expect(marked).not.toBe(made);
    // The same files under an agent writer's trailer (an agent's clone commits through the CLI,
    // whose engine refuses this first; main checks again): refused.
    const files = async (head: string) =>
      new Map(
        ((await notebooks.op(localId, 'list', [head])) as { value: Array<[string, string]> }).value,
      );
    const [was, now] = [await files(made), await files(marked)];
    const paths = [...now.keys()].filter((path) => now.get(path) !== was.get(path));
    const read = (await notebooks.op(localId, 'read', [marked, paths])) as {
      value: Array<[string, Uint8Array]>;
    };
    const writer = (kind: string) =>
      `Penmoss: 0 notes [skip ci]\n\nPenmoss-Writer: 01JBN0000000000000000000W1 (${kind} "Claude Code")\n`;
    await expect(
      notebooks.op(localId, 'commit', [made, read.value, writer('agent')]),
    ).resolves.toMatchObject({ ok: false, error: { code: 'agent_undone' } });
    await expect(
      notebooks.op(localId, 'commit', [made, read.value, writer('device')]),
    ).resolves.toMatchObject({ ok: true });
  }, 30_000);
});

describe('Remove says what would be lost (A856)', { timeout: 30_000 }, () => {
  it('names the changes never pushed, or that it cannot tell, in the owner check', async () => {
    const answers: string[] = [];
    const notebooks = service({
      owner: (words) => {
        answers.push(words);
        return Promise.resolve(
          words.startsWith('remove') ? { ok: false, message: 'Not done.' } : { ok: true },
        );
      },
    });
    const result = await notebooks.add({
      remote: bare('lose'),
      branch: 'main',
      dir: '',
      name: 'Lose',
    });
    if (!result.ok || result.value.kind !== 'added') throw new Error('not added');
    const { localId } = result.value.notebook;
    const where = `${join(dir, 'lose.git')} on this Mac`;
    await notebooks.remove(localId, 0);
    await notebooks.remove(localId, 3);
    await notebooks.remove(localId, 1);
    await notebooks.remove(localId, null);
    expect(answers.slice(-4)).toEqual([
      fitWords('remove the git notebook at ', where, ' from this Mac'),
      fitWords(
        'remove the git notebook at ',
        where,
        ' from this Mac and lose 3 changes never pushed',
      ),
      fitWords(
        'remove the git notebook at ',
        where,
        ' from this Mac and lose 1 change never pushed',
      ),
      fitWords(
        'remove the git notebook at ',
        where,
        ' from this Mac and lose any changes not pushed yet',
      ),
    ]);
  }, 30_000);
});

describe('git follows its own configuration, rewrites included (D62)', { timeout: 30_000 }, () => {
  it('adds and pushes where git’s configuration sends the pushes (pushInsteadOf)', async () => {
    const elsewhere = bare('elsewhere');
    const notebooks = service({
      gitEnv: {
        ...GIT_ENV,
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: `url.${elsewhere}.pushInsteadOf`,
        GIT_CONFIG_VALUE_0: bare('mine'),
      },
    });
    const result = await notebooks.add({
      remote: `file://${join(dir, 'mine.git')}`,
      branch: 'main',
      dir: '',
      name: 'Mine',
    });
    // Once refused as `redirected`; now added like any other.
    expect(result).toMatchObject({ ok: true, value: { kind: 'added', created: true } });
    expect(notebooks.asked).toEqual([]);
  }, 30_000);

  it('adds a notebook whose remote git rewrites to another address (insteadOf)', async () => {
    const real = bare('real');
    const notebooks = service({
      gitEnv: {
        ...GIT_ENV,
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: `url.${real}.insteadOf`,
        GIT_CONFIG_VALUE_0: 'https://git.example.com/me/notes.git',
      },
    });
    const added = await notebooks.add({
      remote: 'https://git.example.com/me/notes.git',
      branch: 'main',
      dir: '',
      name: 'Notes',
    });
    expect(added).toMatchObject({ ok: true, value: { kind: 'added' } });
    if (!added.ok || added.value.kind !== 'added') return;
    // The notebook keeps the address it was given; git rewrites it on every call, so the fetch
    // reaches the bare repository and not git.example.com.
    expect(added.value.notebook.remote).toBe('https://git.example.com/me/notes.git');
    await expect(notebooks.op(added.value.notebook.localId, 'fetch', [])).resolves.toEqual({
      ok: true,
      value: null,
    });
  }, 30_000);
});

describe('a commit identity is plain text (#174 review)', () => {
  it('refuses NUL, control, bidi and other format characters in the name and the email', () => {
    expect(commitAuthor({ name: 'Ryan', email: '1234+ryan@users.noreply.github.com' })).toEqual({
      name: 'Ryan',
      email: '1234+ryan@users.noreply.github.com',
    });
    for (const [name, email] of [
      ['Ry\u0000an', 'a@b.c'],
      ['Ry\u202ean', 'a@b.c'],
      ['Ry\u200ban', 'a@b.c'],
      ['Ryan', 'a\u0000@b.c'],
      ['Ryan', 'a\u202e@b.c'],
      ['Ryan', 'a@b\u2066.c'],
      ['Ryan', 'a\u0007@b.c'],
    ] as const) {
      expect(commitAuthor({ name, email }), `${name} <${email}>`).toBeUndefined();
    }
  });
});

describe('who commits (#170 F3, F6)', { timeout: 30_000 }, () => {
  it('reads git’s identity again for each commit, and a notebook’s own name and email win', async () => {
    const global = join(dir, 'gitconfig');
    const identity = (name: string, email: string) =>
      writeFileSync(global, `[user]\n\tname = ${name}\n\temail = ${email}\n`);
    identity('Ryan', 'ryan@example.invalid');
    const notebooks = service({
      gitEnv: { GIT_CONFIG_GLOBAL: global, GIT_CONFIG_NOSYSTEM: '1' },
    });
    const added = await notebooks.add({
      remote: bare('who'),
      branch: 'main',
      dir: '',
      name: 'Who',
    });
    if (!added.ok || added.value.kind !== 'added') throw new Error('not added');
    const id = added.value.notebook.localId;
    expect(added.value.notebook.author).toBeNull();
    const authorOf = async (head: string | null, file: string) => {
      const made = await notebooks.op(id, 'commit', [
        head,
        [[file, new TextEncoder().encode(file)]],
        'Penmoss: a note',
      ]);
      if (!made.ok) throw new Error(made.error.message);
      const log = await notebooks.op(id, 'push', [made.value]);
      expect(log).toEqual({ ok: true, value: 'pushed' });
      const listed = await notebooks.op(id, 'log', [{ limit: 1 }]);
      const [last] = (listed.ok ? listed.value : []) as Array<{
        author: { name: string; email: string };
      }>;
      return { head: made.value as string, author: last!.author };
    };
    const one = await authorOf(null, 'one.md');
    expect(one.author).toEqual({ name: 'Ryan', email: 'ryan@example.invalid' });
    // git config --global user.email changes while the app runs: the next commit has it.
    identity('Ryan', '1234+ryan@users.noreply.github.com');
    expect(await notebooks.identity()).toEqual({
      name: 'Ryan',
      email: '1234+ryan@users.noreply.github.com',
    });
    const two = await authorOf(one.head, 'two.md');
    expect(two.author.email).toBe('1234+ryan@users.noreply.github.com');
    // This notebook's own identity, over git's, for it alone.
    const set = await notebooks.update(id, {
      author: { name: ' Ryan H ', email: '99+rh@users.noreply.github.com' },
    });
    expect(set).toMatchObject({
      ok: true,
      value: { author: { name: 'Ryan H', email: '99+rh@users.noreply.github.com' } },
    });
    const three = await authorOf(two.head, 'three.md');
    expect(three.author).toEqual({ name: 'Ryan H', email: '99+rh@users.noreply.github.com' });
    for (const bad of [{ name: 'x', email: 'no-at' }, { name: 'a\nb', email: 'a@b.c' }, 'me']) {
      await expect(notebooks.update(id, { author: bad })).resolves.toMatchObject({
        ok: false,
        error: { code: 'invalid_request' },
      });
    }
    await notebooks.update(id, { author: null });
    expect((await notebooks.list())[0]!.author).toBeNull();
    const four = await authorOf(three.head, 'four.md');
    expect(four.author.email).toBe('1234+ryan@users.noreply.github.com');
  });
});

describe('helpers', () => {
  it('cleans directories and the owner check’s words', () => {
    expect(cleanDir('/docs/notes/')).toBe('docs/notes');
    expect(cleanDir('')).toBe('');
    expect(cleanDir('a/../b')).toBeNull();
    expect(cleanDir('.git/hooks')).toBeNull();
    expect(checkWords('remove\nthe notebook')).toBe('remove the notebook');
    expect(checkWords('x'.repeat(300))).toHaveLength(198);
    expect(repositoryName('git@github.com:htxryan/notes.git')).toBe('github.com/htxryan/notes');
  });
});

describe('no git outlives the app (A853)', () => {
  it('kills only what is still a git process group a crashed run left', () => {
    const path = join(dir, 'git-processes.json');
    const at = Date.parse('2026-10-29T09:00:00Z');
    writeFileSync(
      path,
      JSON.stringify([
        { pid: 101, at },
        { pid: 202, at },
        { pid: 303, at },
        // The pid now leads a git that started long after the one recorded: someone else's.
        { pid: 404, at },
        // Recorded with no start time: never killed.
        505,
        { pid: 'x', at },
        { pid: -1, at },
      ]),
    );
    const kill = vi.fn();
    const started = at + 400; // ps shows whole seconds.
    const file = new GitProcessFile(path, {
      kill,
      probe: (pid) =>
        pid === 101
          ? { pgid: 101, command: 'git', started }
          : pid === 202
            ? { pgid: 202, command: '/Applications/Safari.app/Contents/MacOS/Safari', started }
            : pid === 303
              ? { pgid: 1, command: 'git', started }
              : pid === 404
                ? { pgid: 404, command: 'git', started: at + 60_000 }
                : pid === 505
                  ? { pgid: 505, command: 'git', started }
                  : null,
    });
    expect(file.cleanUp()).toEqual([101]);
    expect(kill).toHaveBeenCalledTimes(1);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual([]);
    file.started(7);
    file.started(8);
    file.ended(7);
    const live = JSON.parse(readFileSync(path, 'utf8')) as Array<{ pid: number; at: number }>;
    expect(live.map((entry) => entry.pid)).toEqual([8]);
    expect(Math.abs(live[0]!.at - Date.now())).toBeLessThan(5_000);
  });

  // probeProcess reads ps, which the software factory's sandbox refuses (A1231): there the
  // test can't run, and the host and CI run it. Whether ps lists this process (prints its pid),
  // not its exit code: an agent's shell inside the sandbox fails ps another way.
  it.skipIf(
    (
      spawnSync('ps', ['-p', String(process.pid), '-o', 'pid='], { encoding: 'utf8' }).stdout ?? ''
    ).trim() !== String(process.pid),
  )('reads a process’s group, start and command from ps', () => {
    const found = probeProcess(process.pid);
    expect(found?.pgid).toBeGreaterThan(0);
    expect(Math.abs(found!.started - (Date.now() - process.uptime() * 1000))).toBeLessThan(3_000);
    expect(probeProcess(2 ** 22 + 12_345)).toBeNull();
  });

  it('knows git and its helpers by name', () => {
    expect(isGitCommand('git')).toBe(true);
    expect(isGitCommand('/usr/lib/git-core/git-remote-https')).toBe(true);
    expect(isGitCommand('ssh')).toBe(true);
    expect(isGitCommand('gitk-evil')).toBe(false);
    expect(isGitCommand('Safari')).toBe(false);
  });
});
