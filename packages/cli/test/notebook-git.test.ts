/**
 * Git notebooks from the CLI over system git (T50 G2, #150), against bare repositories on this
 * machine: what git itself decides. Two machines converge with no merges, a directory of a code
 * repository, a host's refusals and their messages (GH006, GH007), tokens over HTTP, SSH, a
 * rewrite in git's configuration (D62), the commit identity, and a fetch that hangs. The CLI's
 * own logic runs over an in-memory host in `notebook-commands.test.ts`. The CLI's `Io` has no
 * network of its own: git talks to the notebook's host, and nothing else is reached.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { bareRepository, httpHost } from '../../git-notebook/test/support/git';
import { bare as bareAt, git, machine as machineAt, testRoot } from './support/machine';

// Each test runs many git processes; the Mac CI runners take over 5 s for the longest
// (as packages/git-notebook's config allows).
vi.setConfig({ testTimeout: 60_000 });

const root = testRoot('penmoss-nb-');
const machine = (name: string, extra?: Parameters<typeof machineAt>[2]) =>
  machineAt(root.path, name, extra);
const bare = (name: string) => bareAt(root.path, name);

describe('penmoss notebook over system git', () => {
  it('adds a notebook, edits it from two machines offline, and they converge with no merges', async () => {
    const remote = bare('notes');
    const laptop = machine('laptop');
    const added = await laptop(['notebook', 'add', `file://${remote}`, '--name', 'work', '--json']);
    // Nothing is said: nobody is asked whether the repository is private (D61).
    expect(added.stderr).toBe('');
    expect(added.code).toBe(0);
    expect(added.json()).toMatchObject({
      name: 'work',
      created: true,
      branch: 'main',
      writer: { kind: 'device' },
    });
    expect(git(remote, ['ls-tree', '-r', '--name-only', 'main'])).toContain(
      '.penmoss/notebook.json',
    );

    const made = await laptop([
      'new',
      'Standup',
      '--text',
      '## Notes\n\nShip the CLI',
      '--tag',
      'work',
      '--notebook',
      'work',
      '--json',
    ]);
    expect(made.code).toBe(0);
    const id = made.json()['id'] as string;
    expect(git(remote, ['ls-tree', '-r', '--name-only', 'main'])).toContain('Standup.md');
    expect(git(remote, ['log', '-1', '--format=%s', 'main'])).toBe('Penmoss: 1 note [skip ci]');

    const agent = machine('agent');
    // On the agent's machine, a person's clone and an agent's, each added on its own.
    expect((await agent(['notebook', 'add', `file://${remote}`, '--name', 'work-ryan'])).code).toBe(
      0,
    );
    expect(
      (
        await agent([
          'notebook',
          'add',
          `file://${remote}`,
          '--name',
          'work',
          '--agent',
          'Claude Code',
        ])
      ).code,
    ).toBe(0);
    const found = await agent(['search', 'ship', '--notebook', 'work', '--json']);
    expect((found.json()['results'] as { id: string }[]).map((r) => r.id)).toEqual([id]);
    expect(found.json()['notice']).toMatch(/words only/);
    const read = await agent(['cat', 'Standup', '--notebook', 'work', '--body']);
    expect(read.stdout).toBe('## Notes\n\nShip the CLI\n');

    // One edit on each machine, offline, then each syncs. The merge itself is the engine's,
    // proved over 300 seeds (git-notebook's converge tests, A836).
    expect(
      (
        await laptop([
          'append',
          'Standup',
          '--text',
          '- from the laptop',
          '--notebook',
          'work',
          '--no-sync',
        ])
      ).code,
    ).toBe(0);
    expect(
      (
        await agent([
          'append',
          'Standup',
          '--text',
          '- from the agent',
          '--heading',
          'Notes',
          '--notebook',
          'work',
          '--no-sync',
        ])
      ).code,
    ).toBe(0);
    const pushed = await laptop(['notebook', 'sync', 'work', '--json']);
    expect((pushed.json()['synced'] as { commit: string }[])[0]!.commit).toMatch(/^[0-9a-f]{40}$/);
    await agent(['notebook', 'sync']);
    await laptop(['notebook', 'sync', 'work']);
    const one = (await laptop(['cat', 'Standup', '--notebook', 'work', '--body'])).stdout;
    const two = (await agent(['cat', 'Standup', '--notebook', 'work', '--body'])).stdout;
    expect(one).toBe(two);
    expect(one).toContain('from the laptop');
    expect(one).toContain('from the agent');
    expect(git(remote, ['rev-list', '--merges', 'main'])).toBe('');
    const authors = git(remote, ['log', '--format=%an', 'main']).split('\n');
    expect(authors).toContain('Claude Code');

    const status = await agent(['notebook', 'status', 'work', '--json']);
    expect(status.json()).toMatchObject({
      name: 'work',
      writer: { kind: 'agent', label: 'Claude Code' },
      unsynced: 0,
      notes: 1,
    });
    expect(status.json()['writerId']).toMatch(/^[0-9A-Z]{26}$/);
    expect((await agent(['notebook', 'ls', '--json'])).json()['notebooks']).toHaveLength(2);
  });

  it('commits only inside a directory of a code repository, with [skip ci], beside a colleague', async () => {
    const remote = bare('code');
    const work = join(root.path, 'colleague');
    mkdirSync(work);
    git(work, ['init', '--quiet', '--initial-branch=main']);
    git(work, ['config', 'user.name', 'Colleague']);
    git(work, ['config', 'user.email', 'c@example.invalid']);
    mkdirSync(join(work, 'docs', 'notes'), { recursive: true });
    writeFileSync(join(work, 'README.md'), '# App\n');
    writeFileSync(join(work, 'docs', 'notes', 'Mine.md'), '# By hand\n');
    git(work, ['add', '-A']);
    git(work, ['commit', '--quiet', '-m', 'Code']);
    git(work, ['remote', 'add', 'origin', `file://${remote}`]);
    git(work, ['push', '--quiet', 'origin', 'main']);
    const cli = machine('dev');
    const added = await cli([
      'notebook',
      'add',
      `file://${remote}`,
      '--dir',
      'docs/notes',
      '--json',
    ]);
    expect(added.json()).toMatchObject({ name: 'code-notes', dir: 'docs/notes', created: true });
    expect(
      (await cli(['new', 'Mine', '--text', 'from penmoss', '--notebook', 'code-notes'])).code,
    ).toBe(0);
    git(work, ['pull', '--quiet', '--ff-only', 'origin', 'main']);
    expect(git(work, ['show', 'HEAD:docs/notes/Mine.md'])).toBe('# By hand');
    expect(git(work, ['ls-tree', '-r', '--name-only', 'HEAD', 'docs/notes'])).toMatch(
      /docs\/notes\/Mine \([0-9A-Z]{7}\)\.md/,
    );
    for (const sha of git(work, ['log', '--format=%H', '--author=dev|Penmoss', '-E'])
      .split('\n')
      .filter(Boolean)) {
      expect(git(work, ['log', '-1', '--format=%s', sha])).toMatch(/\[skip ci\]$/);
      for (const path of git(work, ['diff-tree', '--no-commit-id', '--name-only', '-r', sha])
        .split('\n')
        .filter(Boolean)) {
        expect(path.startsWith('docs/notes/')).toBe(true);
      }
    }
  });

  it("prints the host's reason for a refused push, and keeps the edit for the next sync", async () => {
    const remote = bare('guarded');
    const cli = machine('m');
    await cli(['notebook', 'add', `file://${remote}`, '--name', 'nb']);
    writeFileSync(
      join(remote, 'hooks', 'pre-receive'),
      '#!/bin/sh\necho "GH006: Protected branch update failed for refs/heads/main." >&2\nexit 1\n',
      { mode: 0o755 },
    );
    const made = await cli(['new', 'Kept', '--notebook', 'nb']);
    expect(made.code).toBe(0);
    expect(made.stderr).toContain('saved here, not synced yet');
    expect(made.stderr).toContain('GH006: Protected branch update failed');
    expect((await cli(['notebook', 'status', 'nb', '--json'])).json()['unsynced']).toBeGreaterThan(
      0,
    );
    const sync = await cli(['notebook', 'sync', 'nb']);
    expect(sync.code, sync.stderr + sync.stdout).toBe(7);
    expect(sync.stderr).toMatch(/protected/i);
    // Removing it now would drop the edit.
    expect((await cli(['notebook', 'remove', 'nb'])).code).toBe(5);
    rmSync(join(remote, 'hooks', 'pre-receive'));
    expect((await cli(['notebook', 'sync', 'nb'])).code).toBe(0);
    expect(git(remote, ['ls-tree', '-r', '--name-only', 'main'])).toContain('Kept.md');
    expect((await cli(['notebook', 'remove', 'nb'])).code).toBe(0);
    expect((await cli(['notebook', 'ls', '--json'])).json()['notebooks']).toEqual([]);
  });

  it('sends PENMOSS_GIT_TOKEN to its own host, and syncs with it', async () => {
    const repo = bareRepository(join(root.path, 'host', 'o', 'r.git'));
    const host = await httpHost(join(root.path, 'host'), {
      user: 'x-access-token',
      password: 'pat',
    });
    try {
      const cli = machine('m', {
        env: { PENMOSS_GIT_TOKEN: 'pat', PENMOSS_GIT_TOKEN_HOST: '127.0.0.1' },
      });
      const added = await cli(['notebook', 'add', `${host.origin}/o/r.git`, '--name', 'nb']);
      expect(added.code, added.stderr).toBe(0);
      expect(added.stderr).toBe('');
      expect((await cli(['new', 'Over HTTP', '--notebook', 'nb'])).code).toBe(0);
      expect(git(repo, ['ls-tree', '-r', '--name-only', 'main'])).toContain('Over HTTP.md');
    } finally {
      await host.close();
    }
  });

  it('sends PENMOSS_GIT_TOKEN only to its own host', async () => {
    bareRepository(join(root.path, 'other', 'o', 'r.git'));
    const host = await httpHost(join(root.path, 'other'), {
      user: 'x-access-token',
      password: 'pat',
    });
    try {
      const cli = machine('m', {
        env: { PENMOSS_GIT_TOKEN: 'pat', PENMOSS_GIT_TOKEN_HOST: 'git.example.com' },
        gitEnv: { GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '' },
      });
      // 127.0.0.1 is not the token's host, so git asks with no token and the host refuses.
      const added = await cli(['notebook', 'add', `${host.origin}/o/r.git`, '--name', 'nb']);
      expect(added.code).not.toBe(0);
      expect((await cli(['notebook', 'ls', '--json'])).json()['notebooks']).toEqual([]);
    } finally {
      await host.close();
    }
  });

  it('adds and syncs a github.com repository without asking GitHub anything (D61)', async () => {
    // github.com over SSH, served from this machine: git's ssh command runs git here.
    const served = join(root.path, 'gh');
    const repo = bareRepository(join(served, 'acme', 'hidden.git'));
    const ssh = join(root.path, 'ssh.sh');
    writeFileSync(
      ssh,
      `#!/bin/sh\nfor last; do :; done\ncd '${served}' && exec sh -c "git \${last#git-}"\n`,
      { mode: 0o755 },
    );
    const fetch = vi.fn(() => Promise.reject(new Error('nothing may be fetched')));
    vi.stubGlobal('fetch', fetch);
    try {
      const cli = machine('m', { gitEnv: { GIT_SSH_COMMAND: ssh } });
      const added = await cli([
        'notebook',
        'add',
        'git@github.com:acme/hidden.git',
        '--name',
        'nb',
      ]);
      expect(added.code, added.stderr).toBe(0);
      expect(added.stderr).toBe('');
      expect((await cli(['new', 'First', '--notebook', 'nb'])).code).toBe(0);
      expect(git(repo, ['ls-tree', '-r', '--name-only', 'main'])).toContain('First.md');
      expect((await cli(['notebook', 'sync', 'nb'])).code).toBe(0);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('bounds the sync before a write; the write is saved and its sync left to the background (A852)', async () => {
    const remote = bare('stall');
    const cli = machine('m');
    expect((await cli(['notebook', 'add', `file://${remote}`, '--name', 'nb'])).code).toBe(0);
    const registry = JSON.parse(readFileSync(join(root.path, 'm', 'notebooks.json'), 'utf8')) as {
      notebooks: Array<{ localId: string }>;
    };
    const gitDir = join(root.path, 'm', 'git', registry.notebooks[0]!.localId, 'repo.git');
    // Every fetch hangs, as on a network that drops connections.
    const sleep = spawnSync('sh', ['-c', 'command -v sleep'], { encoding: 'utf8' }).stdout.trim();
    const hang = join(root.path, 'hang.sh');
    writeFileSync(hang, `#!/bin/sh\nexec '${sleep}' 60\n`, { mode: 0o755 });
    git(gitDir, ['config', 'remote.origin.uploadpack', hang]);
    const detached: string[][] = [];
    const started = Date.now();
    const made = await cli(['new', 'Stalled', '--notebook', 'nb'], {
      detached,
      cliEnv: { PENMOSS_NOTEBOOK_SYNC_TIMEOUT: '1' },
    });
    const took = Date.now() - started;
    expect(made.code).toBe(0);
    expect(made.stdout).toContain('Created');
    expect(made.stderr).toContain('the host did not answer within 1 s');
    expect(made.stderr).toContain('the sync is pending and runs in the background');
    expect(detached).toEqual([['notebook', 'sync', 'nb', '--wait', '120']]);
    // One bounded sync, not a second after the write.
    expect(took).toBeLessThan(10_000);
    git(gitDir, ['config', '--unset', 'remote.origin.uploadpack']);
    expect((await cli(['notebook', 'sync', 'nb'])).code).toBe(0);
    expect(git(remote, ['ls-tree', '-r', '--name-only', 'main'])).toContain('Stalled.md');
  });

  it('commits as git’s identity now, or as the notebook’s own (#170 F3, F6)', async () => {
    const remote = bare('who');
    const global = join(root.path, 'gitconfig');
    const identity = (email: string) =>
      writeFileSync(global, `[user]\n\tname = Ryan\n\temail = ${email}\n`);
    identity('ryan@example.invalid');
    const cli = machine('m', { gitEnv: { GIT_CONFIG_GLOBAL: global } });
    const added = await cli(['notebook', 'add', `file://${remote}`, '--name', 'nb']);
    expect(added.code, added.stderr).toBe(0);
    const lastEmail = () => git(remote, ['log', '-1', '--format=%an <%ae>', 'main']);
    expect((await cli(['new', 'One', '--notebook', 'nb'])).code).toBe(0);
    expect(lastEmail()).toBe('Ryan <ryan@example.invalid>');
    // git's user.email changed after the notebook was added: the next commit has it.
    identity('1234+ryan@users.noreply.github.com');
    expect((await cli(['new', 'Two', '--notebook', 'nb'])).code).toBe(0);
    expect(lastEmail()).toBe('Ryan <1234+ryan@users.noreply.github.com>');
    // This notebook's own, over git's.
    const set = await cli([
      'notebook',
      'set',
      'nb',
      '--author-email',
      '9+rh@users.noreply.github.com',
    ]);
    expect(set.code, set.stderr).toBe(0);
    expect(set.stdout).toContain('nb commits as Ryan <9+rh@users.noreply.github.com> from now on.');
    expect((await cli(['notebook', 'status', 'nb'])).stdout).toMatch(
      /commits as +Ryan <9\+rh@users\.noreply\.github\.com> \(this notebook’s own\)/,
    );
    expect((await cli(['new', 'Three', '--notebook', 'nb'])).code).toBe(0);
    expect(lastEmail()).toBe('Ryan <9+rh@users.noreply.github.com>');
    expect(
      (await cli(['notebook', 'set', 'nb', '--author-name', 'R H', '--author-email', 'x@y.z']))
        .code,
    ).toBe(0);
    expect((await cli(['notebook', 'set', 'nb', '--author-email', 'not-an-email'])).code).toBe(2);
    expect((await cli(['notebook', 'set', 'nb', '--author-name', 'Only'])).code).toBe(2);
    // Plain text only (#174 review): no NUL, control, bidi or other format character.
    for (const [flag, value] of [
      ['--author-email', 'a‮@b.c'],
      ['--author-email', 'a\u0000@b.c'],
      ['--author-name', 'R⁦H'],
    ] as const) {
      const extra = flag === '--author-name' ? ['--author-email', 'x@y.z'] : [];
      expect((await cli(['notebook', 'set', 'nb', flag, value, ...extra])).code, value).toBe(2);
    }
    expect((await cli(['notebook', 'set', 'nb', '--git-author'])).code).toBe(0);
    expect((await cli(['new', 'Four', '--notebook', 'nb'])).code).toBe(0);
    expect(lastEmail()).toBe('Ryan <1234+ryan@users.noreply.github.com>');
  });

  it('says to commit as the GitHub no-reply address when GitHub refuses a private email (GH007, #170 F6)', async () => {
    const remote = bare('gh007');
    const cli = machine('m');
    await cli(['notebook', 'add', `file://${remote}`, '--name', 'nb']);
    writeFileSync(
      join(remote, 'hooks', 'pre-receive'),
      '#!/bin/sh\necho "error: GH007: Your push would publish a private email address." >&2\nexit 1\n',
      { mode: 0o755 },
    );
    expect((await cli(['new', 'Kept', '--notebook', 'nb'])).code).toBe(0);
    const sync = await cli(['notebook', 'sync', 'nb']);
    expect(sync.code, sync.stderr).toBe(7);
    expect(sync.stderr).toContain(
      'GitHub refused the push: its commits would make your private email address public (GH007).',
    );
    expect(sync.stderr).toContain('penmoss notebook set nb --author-email <that address>');
  });

  it('says to add again with --author-email when GitHub refuses add’s first push, and add takes it (#198)', async () => {
    const remote = bare('gh007-add');
    const global = join(root.path, 'gitconfig-198');
    writeFileSync(global, '[user]\n\tname = Ryan\n\temail = ryan@example.invalid\n');
    const hook = join(remote, 'hooks', 'pre-receive');
    writeFileSync(
      hook,
      '#!/bin/sh\nwhile read old new ref; do\n  git log --format=%ae "$new" | grep -q "@users.noreply.github.com" || { echo "error: GH007: Your push would publish a private email address." >&2; exit 1; }\ndone\n',
      { mode: 0o755 },
    );
    const cli = machine('m', { gitEnv: { GIT_CONFIG_GLOBAL: global } });
    const refused = await cli(['notebook', 'add', `file://${remote}`, '--name', 'nb']);
    expect(refused.code, refused.stderr).toBe(7);
    expect(refused.stderr).toContain('(GH007)');
    // add rolled back, so the advice is add again, not `notebook set` on a notebook not there.
    expect(refused.stderr).toContain(
      'Nothing was added: run the same penmoss notebook add again with --author-email <that address>',
    );
    expect(refused.stderr).not.toContain('notebook set nb');
    expect(refused.stderr).not.toContain('nothing is lost');
    expect((await cli(['notebook', 'ls'])).stdout).toContain('No git notebooks yet');

    const added = await cli([
      'notebook',
      'add',
      `file://${remote}`,
      '--name',
      'nb',
      '--author-email',
      '1234+ryan@users.noreply.github.com',
    ]);
    expect(added.code, added.stderr).toBe(0);
    const lastAuthor = () => git(remote, ['log', '-1', '--format=%an <%ae>', 'main']);
    // The name is git's user.name when only the email is given.
    expect(lastAuthor()).toBe('Ryan <1234+ryan@users.noreply.github.com>');
    expect((await cli(['notebook', 'status', 'nb'])).stdout).toMatch(
      /commits as +Ryan <1234\+ryan@users\.noreply\.github\.com> \(this notebook’s own\)/,
    );
    expect((await cli(['new', 'Later', '--notebook', 'nb'])).code).toBe(0);
    expect(lastAuthor()).toBe('Ryan <1234+ryan@users.noreply.github.com>');
    // The same checks as set's.
    const bad = await cli(['notebook', 'add', `file://${remote}`, '--author-email', 'nope']);
    expect(bad.code).toBe(2);
    const nameOnly = await cli(['notebook', 'add', `file://${remote}`, '--author-name', 'R']);
    expect(nameOnly.code).toBe(2);
  });

  it('follows a rewrite in git’s configuration, as git does (D62)', async () => {
    const remote = bare('rewritten');
    const elsewhere = bare('rewritten-to');
    const cli = machine('m', {
      gitEnv: {
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: `url.file://${elsewhere}.insteadOf`,
        GIT_CONFIG_VALUE_0: `file://${remote}`,
      },
    });
    const added = await cli(['notebook', 'add', `file://${remote}`, '--name', 'nb']);
    expect(added.code, added.stderr).toBe(0);
    // The notebook went where git's configuration sends the remote, as any git command would.
    expect(git(elsewhere, ['ls-tree', '-r', '--name-only', 'main'])).toContain(
      '.penmoss/notebook.json',
    );
    expect(git(remote, ['branch', '--list'])).toBe('');
  });
});
