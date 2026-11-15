/**
 * The system-git transport and the engine over real hosts (T50 G2, #150): a host over HTTP with
 * Basic auth and a partial clone, git's own configuration (D62), a directory target in a code
 * repository with a colleague pushing at the same time, and devices converging. The transport's
 * own calls are `node-transport.test.ts`.
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GitNotebookEngine, type GitTransportError } from '../src';
import { FileStorage } from '../src/node/storage';
import { git, httpHost } from './support/git';
import { box, device, transport } from './support/node-clone';

const encoder = new TextEncoder();

describe('over HTTP, with a token', () => {
  it('fetches and pushes with the token through GIT_ASKPASS, and fails cleanly without it', async () => {
    const sb = box();
    // The host's repositories live under its project root.
    const remote = sb.bare('host/team/notes');
    const host = await httpHost(join(sb.dir, 'host'), {
      user: 'x-access-token',
      password: 'pat_secret_123',
    });
    try {
      const url = `${host.origin}/team/notes.git`;
      const a = await transport(sb.dir, url, { token: 'pat_secret_123', name: 'a' });
      expect(await a.fetch()).toBeNull();
      const first = await a.commit(null, new Map([['x.md', encoder.encode('x')]]), 'first');
      expect(await a.push(first!)).toBe('pushed');
      expect(git(remote.path, ['rev-parse', 'refs/heads/main'])).toBe(first);
      // The token is never left on disk: the askpass script is gone, the config has none.
      const config = git(join(sb.dir, 'clone-a.git'), ['config', '--list']);
      expect(config).not.toContain('pat_secret_123');
      expect(readdirSync(join(sb.dir, 'clone-a.git', 'penmoss-askpass'))).toEqual([]);

      const wrong = await transport(sb.dir, url, { token: 'wrong', name: 'b' });
      expect(await wrong.fetch().catch((e: unknown) => (e as GitTransportError).code)).toBe('auth');
      const none = await transport(sb.dir, url, { name: 'c' });
      expect(await none.fetch().catch((e: unknown) => (e as GitTransportError).code)).toBe('auth');
    } finally {
      await host.close();
    }
  });

  it('two devices over HTTP converge, with a partial clone that fetches blobs in one batch', async () => {
    const sb = box();
    const remote = sb.bare('host/notes');
    const host = await httpHost(join(sb.dir, 'host'), { user: 'x-access-token', password: 'pat' });
    try {
      const url = `${host.origin}/notes.git`;
      const a = await device(sb, url, 'a', { create: true, token: 'pat' });
      const ids = Array.from({ length: 30 }, (_, i) =>
        a.ops.createNote({ title: `Note ${i}`, markdown: `body ${i}` }),
      );
      await a.engine.sync();
      const b = await device(sb, url, 'b', { token: 'pat' });
      const before = host.requests.length;
      await b.engine.sync();
      // One fetch, then one batched blob fetch per phase of the sync (notebook.json and the
      // workspace logs, the note logs, the writer's own files, the rendered files): a few
      // round trips whatever the number of notes, never one per note.
      const posts = host.requests.slice(before).filter((r) => r.startsWith('POST'));
      expect(posts.length).toBeLessThanOrEqual(6);
      expect(b.engine.replica.noteIds().length).toBe(30);
      // Both edit offline, then sync in turn: the second builds on the first's push at once.
      b.ops.createNote({ title: 'From b', markdown: 'b' });
      b.ops.trash(ids[0]!);
      a.ops.createNote({ title: 'From a', markdown: 'a' });
      await b.engine.sync();
      expect((await a.engine.sync()).attempts).toBe(1);
      await b.engine.sync();
      expect(a.engine.replica.noteIds().sort()).toEqual(b.engine.replica.noteIds().sort());
      expect(ids.length).toBe(30);
      expect(git(remote.path, ['log', '--format=%s', 'main']).split('\n')[0]).toMatch(
        /\[skip ci\]$/,
      );
      expect(git(remote.path, ['rev-list', '--merges', 'main'])).toBe('');
      // A third device from scratch (over file://, the same repository) reads the same, and its
      // state survives a restart.
      const c = await device(sb, remote.url, 'c');
      await c.engine.sync();
      expect(c.engine.replica.noteIds().sort()).toEqual(a.engine.replica.noteIds().sort());
      const again = await GitNotebookEngine.open({
        transport: c.transport,
        storage: new FileStorage(c.storage.dir),
        secrets: c.secrets,
        writer: { kind: 'device', label: 'c' },
      });
      expect(again.replica.noteIds().sort()).toEqual(c.engine.replica.noteIds().sort());
      expect((await again.sync()).commit).toBeNull();
    } finally {
      await host.close();
    }
  });
});

describe('git follows its own configuration (D62)', () => {
  it('fetches where git’s configuration rewrites the remote to (insteadOf)', async () => {
    const sb = box();
    sb.bare('mine/notes');
    sb.bare('theirs/notes');
    const mine = await httpHost(join(sb.dir, 'mine'), { user: 'x-access-token', password: 'pat' });
    const theirs = await httpHost(join(sb.dir, 'theirs'), {
      user: 'x-access-token',
      password: 'pat',
    });
    try {
      const t = await transport(sb.dir, `${mine.origin}/notes.git`, {
        token: 'pat',
        env: {
          GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: `url.${theirs.origin}/.insteadOf`,
          GIT_CONFIG_VALUE_0: `${mine.origin}/`,
        },
      });
      await t.fetch();
      expect(theirs.requests.length).toBeGreaterThan(0);
      expect(mine.requests).toEqual([]);
    } finally {
      await mine.close();
      await theirs.close();
    }
  });
});

describe('the engine over system git', () => {
  it('a directory target commits only inside the directory, and survives a concurrent push', async () => {
    const sb = box();
    const remote = sb.bare('code');
    const colleague = sb.colleague(remote.url);
    colleague.commit({
      'README.md': '# App\n',
      'docs/notes/Hand written.md': '# Mine\n',
      'src/app.ts': 'x',
    });
    const a = await device(sb, remote.url, 'a', { root: 'docs/notes/', create: true });
    a.ops.createNote({ title: 'Plan', markdown: 'one' });
    let pushed = false;
    const report = await a.engine.sync({
      beforePush: () => {
        if (pushed) return;
        pushed = true;
        // A colleague pushes code between our fetch and our push.
        colleague.commit({ 'src/app.ts': 'y' }, 'Fix the app');
      },
    });
    expect(report.attempts).toBe(2);
    const files = colleague.files();
    expect(files).toContain('docs/notes/Plan.md');
    expect(files).toContain('docs/notes/Hand written.md');
    expect(colleague.read('src/app.ts')).toBe('y');
    expect(colleague.read('docs/notes/Hand written.md')).toBe('# Mine\n');
    const mine = git(colleague.path, ['log', '--format=%H %s', '--author=Penmoss']).split('\n');
    for (const line of mine) {
      const [sha] = line.split(' ');
      expect(line).toMatch(/\[skip ci\]$/);
      const touched = git(colleague.path, [
        'diff-tree',
        '--no-commit-id',
        '--name-only',
        '-r',
        sha!,
      ]).split('\n');
      for (const path of touched.filter(Boolean)) expect(path.startsWith('docs/notes/')).toBe(true);
    }
  });

  it('notices a server that ignored the blob filter (a full clone)', async () => {
    const sb = box();
    const remote = sb.bare('nofilter');
    git(remote.path, ['config', 'uploadpack.allowFilter', 'false']);
    const colleague = sb.colleague(remote.url);
    colleague.commit({ 'a.txt': 'a' });
    const a = await transport(sb.dir, remote.url);
    await a.fetch();
    expect(a.notes.filterIgnored).toBe(true);
  });
});
