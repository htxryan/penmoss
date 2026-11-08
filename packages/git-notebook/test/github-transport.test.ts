/**
 * The GitHub transport (T55, D48) against a fake GitHub API over a `MemoryRemote`: the same rules
 * the system-git transport keeps (commit on the head, push fast-forward only, a rejected push and
 * a rebuild, a new branch, nothing outside the notebook's directory), and the engine end to end,
 * with a relay over GitHub and a Mac over git writing the same notebook and converging.
 */
import { readTitle } from '@penmoss/sync-client/note';
import { describe, expect, it } from 'vitest';
import {
  GitNotebookEngine,
  GitTransportError,
  MemoryRemote,
  MemorySecrets,
  MemoryStorage,
  NotebookOps,
} from '../src';
import { COMPARE_FILE_LIMIT, GitHubTransport } from '../src/github';
import { FAKE_API, FAKE_REPO, FAKE_TOKEN, fakeGitHub } from './support/fake-github';
import { NOTEBOOK_ID, testNotebook, titles } from './support/notebooks';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const bytes = (text: string) => encoder.encode(text);

function github(
  remote: MemoryRemote,
  options: { root?: string; branch?: string; compareLimit?: number; private?: boolean } = {},
) {
  const fake = fakeGitHub(remote, {
    ...(options.compareLimit !== undefined ? { compareLimit: options.compareLimit } : {}),
    ...(options.private !== undefined ? { private: options.private } : {}),
  });
  let time = Date.UTC(2026, 10, 4, 9, 0, 0);
  const transport = new GitHubTransport({
    repository: FAKE_REPO,
    branch: options.branch ?? 'main',
    root: options.root ?? '',
    token: () => Promise.resolve(FAKE_TOKEN),
    author: { name: 'Penmoss relay', email: 'relay@penmoss.invalid' },
    api: FAKE_API,
    fetch: fake.fetch,
    clock: () => (time += 1000),
  });
  return { fake, transport };
}

describe('GitHubTransport', () => {
  it('commits on the head, pushes fast-forward only, and rebuilds after a rejected push', async () => {
    const remote = new MemoryRemote();
    await remote.commitAs('main', { 'README.md': '# Notes\n' });
    const { transport: a } = github(remote);
    const head = await a.fetch();
    expect(head).toBe(remote.branches.get('main'));
    expect(await a.list(head!)).toEqual(new Map([['README.md', expect.any(String) as string]]));

    const commit = await a.commit(head, new Map([['a.md', bytes('a\n')]]), 'add a');
    expect(commit).not.toBeNull();
    // The same bytes again change nothing.
    expect(await a.push(commit!)).toBe('pushed');
    expect(await a.commit(commit, new Map([['a.md', bytes('a\n')]]), 'same')).toBeNull();

    // Someone else pushes: a commit on the old head is refused, one on the new head lands.
    await remote.commitAs('main', { 'README.md': '# Notes 2\n' });
    const stale = await a.commit(commit, new Map([['b.md', bytes('b\n')]]), 'b');
    expect(await a.push(stale!)).toBe('rejected');
    const next = await a.fetch();
    const rebuilt = await a.commit(next, new Map([['b.md', bytes('b\n')]]), 'b');
    expect(await a.push(rebuilt!)).toBe('pushed');
    const files = await a.list(rebuilt!);
    expect([...files.keys()].sort()).toEqual(['README.md', 'a.md', 'b.md']);
    expect(decoder.decode((await a.read(rebuilt!, ['README.md'])).get('README.md'))).toBe(
      '# Notes 2\n',
    );
    // Deleting a path removes it; deleting one that is not there is ignored.
    const removed = await a.commit(
      rebuilt,
      new Map([
        ['a.md', null],
        ['never.md', null],
      ]),
      'remove a',
    );
    expect([...(await a.list(removed!)).keys()].sort()).toEqual(['README.md', 'b.md']);
  });

  it('starts a notebook on an empty repository and on a new branch', async () => {
    const remote = new MemoryRemote();
    const { transport: a } = github(remote);
    expect(await a.fetch()).toBeNull();
    const first = await a.commit(null, new Map([['x.md', bytes('x')]]), 'first');
    expect(await a.push(first!)).toBe('pushed');
    expect(remote.branches.get('main')).toBe(first);

    const { transport: b } = github(remote, { branch: 'notes' });
    expect(await b.fetch()).toBeNull();
    const own = await b.commit(null, new Map([['y.md', bytes('y')]]), 'own');
    expect(await b.push(own!)).toBe('pushed');
    // A second writer racing for the same new branch is rejected, not an error.
    const { transport: c } = github(remote, { branch: 'notes' });
    const late = await c.commit(null, new Map([['z.md', bytes('z')]]), 'late');
    expect(await c.push(late!)).toBe('rejected');
  });

  it('keeps to its directory: lists, changes and writes only under it', async () => {
    const remote = new MemoryRemote();
    await remote.commitAs('main', { 'README.md': '# Code\n', 'docs/notes/a.md': 'a' });
    const { transport: a } = github(remote, { root: 'docs/notes/' });
    const head = await a.fetch();
    expect([...(await a.list(head!)).keys()]).toEqual(['docs/notes/a.md']);
    await expect(a.commit(head, new Map([['README.md', bytes('x')]]), 'x')).rejects.toThrow(
      GitTransportError,
    );
    await expect(
      a.commit(head, new Map([['docs/notes/../../x.md', bytes('x')]]), 'x'),
    ).rejects.toThrow(/outside/);
    await remote.commitAs('main', { 'README.md': '# Code 2\n', 'docs/notes/b.md': 'b' });
    const next = await a.fetch();
    expect(await a.changed(head!, next!)).toEqual(['docs/notes/b.md']);
    expect(await a.sizes(next!, ['docs/notes/b.md', 'README.md'])).toEqual(
      new Map([['docs/notes/b.md', 1]]),
    );
  });

  it('answers null for changes it cannot be sure of', async () => {
    const remote = new MemoryRemote();
    await remote.commitAs('main', { 'a.md': 'a' });
    const { transport: a } = github(remote, { compareLimit: COMPARE_FILE_LIMIT });
    const from = (await a.fetch())!;
    const files: Record<string, string> = {};
    for (let i = 0; i < COMPARE_FILE_LIMIT + 5; i++) files[`n${i}.md`] = String(i);
    await remote.commitAs('main', files);
    const to = (await a.fetch())!;
    // GitHub cut the list at its cap: the engine must compare the trees itself.
    expect(await a.changed(from, to)).toBeNull();
    // An unknown commit, and two commits off one line, are null too.
    expect(await a.changed('0'.repeat(40), to)).toBeNull();
    expect(await a.changed(to, from)).toBeNull();
  });

  it('reads the log and old files for History', async () => {
    const remote = new MemoryRemote();
    const { transport: a } = github(remote, { root: 'n/' });
    const one = await a.commit(null, new Map([['n/a.md', bytes('one')]]), 'one');
    await a.push(one!);
    const two = await a.commit(one, new Map([['n/a.md', bytes('two')]]), 'two');
    await a.push(two!);
    await remote.commitAs('main', { 'README.md': 'outside' });
    const log = await a.log();
    expect(log.map((c) => c.message)).toEqual(['two', 'one']);
    expect(log[0]).toMatchObject({ id: two, parents: [one], author: { name: 'Penmoss relay' } });
    expect((await a.log({ paths: ['n/a.md'], limit: 1 })).map((c) => c.message)).toEqual(['two']);
    expect(decoder.decode((await a.readAt(one!, 'n/a.md'))!)).toBe('one');
    expect(await a.readAt(one!, 'n/missing.md')).toBeNull();
  });

  it('maps GitHub refusals to typed errors', async () => {
    const remote = new MemoryRemote();
    await remote.commitAs('main', { 'a.md': 'a' });
    const { transport: a, fake } = github(remote);
    const head = await a.fetch();
    const commit = await a.commit(head, new Map([['b.md', bytes('b')]]), 'b');
    remote.refuse = { code: 'protected', message: 'protected' };
    await expect(a.push(commit!)).rejects.toMatchObject({ code: 'protected' });
    remote.refuse = null;
    fake.settings.token = 'rotated';
    await expect(a.fetch()).rejects.toMatchObject({ code: 'auth' });
    fake.settings.token = FAKE_TOKEN;
    const { transport: elsewhere } = github(remote);
    // A repository the token cannot see is `not_found`.
    const missing = new GitHubTransport({
      repository: 'ryan/other',
      branch: 'main',
      root: '',
      token: () => Promise.resolve(FAKE_TOKEN),
      author: { name: 'x', email: 'x@example.invalid' },
      api: FAKE_API,
      fetch: fakeGitHub(remote).fetch,
    });
    await expect(missing.fetch()).rejects.toMatchObject({ code: 'not_found' });
    expect(await elsewhere.isPrivate()).toBe(true);
    expect(await github(remote, { private: false }).transport.isPrivate()).toBe(false);
  });
});

describe('a relay over GitHub and a Mac over git, on one notebook', () => {
  it('both write, both sync, and they converge', async () => {
    const nb = testNotebook({ dir: 'notes' });
    const mac = await nb.open('Mac', { create: true });
    const macNote = mac.ops.createNote({ title: 'From the Mac', markdown: 'typed here' });
    await mac.engine.sync();

    const { transport } = github(nb.remote, { root: 'notes/' });
    const relayEngine = await GitNotebookEngine.open({
      transport,
      storage: new MemoryStorage(),
      secrets: new MemorySecrets(),
      writer: { kind: 'agent', label: 'claude.ai' },
      clock: nb.clock,
      newId: nb.newId,
    });
    await relayEngine.sync();
    expect(relayEngine.info?.id).toBe(NOTEBOOK_ID);
    const relay = new NotebookOps(relayEngine, nb.clock, nb.newId);
    expect(readTitle(relay.requireNote(macNote))).toBe('From the Mac');

    // Both edit at once; the relay pushes first, the Mac's push is rejected and rebuilt.
    nb.tick();
    relay.createNote({ title: 'From claude.ai', markdown: 'written by the relay' });
    mac.ops.createNote({ title: 'Also from the Mac', markdown: 'meanwhile' });
    await relayEngine.sync();
    const report = await mac.engine.sync();
    expect(report.attempts).toBeGreaterThanOrEqual(1);
    await relayEngine.sync();

    const expected = ['Also from the Mac', 'From claude.ai', 'From the Mac'];
    expect(titles(mac)).toEqual(expected);
    expect(titles({ engine: relayEngine } as unknown as Parameters<typeof titles>[0])).toEqual(
      expected,
    );
    // The rendered markdown is on the branch, under the notebook's directory.
    expect([...nb.rendered().keys()].some((path) => path.endsWith('From claude.ai.md'))).toBe(true);
  });
});
