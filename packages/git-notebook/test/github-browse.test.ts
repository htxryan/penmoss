/**
 * Browsing GitHub for a notebook's repository and folder (T81, #229; A1164), against a fake of
 * GitHub's calls: paging, the mapping, an empty repository, notebook badges, name checks and
 * GitHub's refusals as reasons.
 */
import { describe, expect, it } from 'vitest';
import {
  branchNameOk,
  defaultRepoName,
  GitHubBrowse,
  MAX_REPOS,
  ownerOk,
  repoNameOk,
} from '../src/github-browse';
import { FakeGitHubBrowse } from './support/fake-github-browse';

const TOKEN = 'gho_test0token0for0browsing';

function setup() {
  const fake = new FakeGitHubBrowse({ token: TOKEN, login: 'ryan' });
  const browse = new GitHubBrowse({ fetch: fake.fetch, api: fake.base });
  return { fake, browse };
}

const notebookJson = (id: string, name: string) => JSON.stringify({ format: 1, id, name });

describe('the repositories a credential reaches', () => {
  it('lists them newest push first, with visibility, default branch, clone address and push rights', async () => {
    const { fake, browse } = setup();
    fake.repos = [
      {
        owner: 'ryan',
        name: 'old',
        pushedAt: '2026-01-01T00:00:00Z',
        visibility: 'public',
        files: { 'a.md': 'a' },
      },
      {
        owner: 'acme',
        name: 'wiki',
        pushedAt: '2026-10-01T00:00:00Z',
        visibility: 'internal',
        canPush: false,
        defaultBranch: 'trunk',
        files: { 'a.md': 'a' },
      },
      { owner: 'ryan', name: 'notes', pushedAt: '2026-11-06T00:00:00Z' },
    ];
    const listed = await browse.repos(TOKEN);
    expect(listed).toEqual({
      ok: true,
      value: {
        more: false,
        repos: [
          {
            fullName: 'ryan/notes',
            owner: 'ryan',
            name: 'notes',
            visibility: 'private',
            defaultBranch: 'main',
            cloneUrl: 'https://github.com/ryan/notes.git',
            pushedAt: '2026-11-06T00:00:00Z',
            canPush: true,
            empty: true,
          },
          expect.objectContaining({
            fullName: 'acme/wiki',
            visibility: 'internal',
            canPush: false,
            defaultBranch: 'trunk',
            empty: false,
          }),
          expect.objectContaining({ fullName: 'ryan/old', visibility: 'public', canPush: true }),
        ],
      },
    });
    const [first] = fake.requests;
    expect(first!.path).toBe(
      '/user/repos?affiliation=owner,collaborator,organization_member&sort=pushed&direction=desc&per_page=100',
    );
    expect(first!.auth).toBe(`Bearer ${TOKEN}`);
  });

  it('follows Link paging to at most 300, and says when there were more', async () => {
    const { fake, browse } = setup();
    fake.repos = Array.from({ length: 340 }, (_, i) => ({
      owner: 'ryan',
      name: `r${String(i).padStart(3, '0')}`,
      pushedAt: new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString(),
    }));
    const listed = await browse.repos(TOKEN);
    if (!listed.ok) throw new Error(listed.error.message);
    expect(listed.value.repos).toHaveLength(MAX_REPOS);
    expect(listed.value.more).toBe(true);
    expect(listed.value.repos[0]!.name).toBe('r339');
    expect(fake.requests.filter((each) => each.path.startsWith('/user/repos'))).toHaveLength(3);
  });

  it('says why GitHub refused: a credential it does not take, a rate limit, no network', async () => {
    const { fake, browse } = setup();
    await expect(browse.repos('gho_wrong')).resolves.toMatchObject({
      ok: false,
      error: { reason: 'unauthorized' },
    });
    fake.failNext = {
      status: 403,
      headers: { 'x-ratelimit-remaining': '0' },
      body: { message: 'API rate limit exceeded' },
    };
    await expect(browse.repos(TOKEN)).resolves.toMatchObject({
      ok: false,
      error: { reason: 'rate_limited' },
    });
    const offline = new GitHubBrowse({
      fetch: () => Promise.reject(new Error('ENOTFOUND')),
      api: fake.base,
    });
    await expect(offline.repos(TOKEN)).resolves.toMatchObject({
      ok: false,
      error: { reason: 'offline' },
    });
  });

  it('never follows a Link to another host with the token', async () => {
    const { browse } = setup();
    const sent: string[] = [];
    const leaky = new GitHubBrowse({
      api: 'https://api.github.test',
      fetch: (url) => {
        sent.push(url);
        return Promise.resolve({
          status: 200,
          headers: {
            get: (name) =>
              name === 'link' ? '<https://evil.example/user/repos?page=2>; rel="next"' : null,
          },
          json: () => Promise.resolve([]),
        });
      },
    });
    void browse;
    await expect(leaky.repos(TOKEN)).resolves.toMatchObject({ ok: false });
    expect(sent.every((url) => url.startsWith('https://api.github.test/'))).toBe(true);
  });
});

describe('a repository’s folders', () => {
  it('lists the root first, hides dot-folders and a notebook’s own folders, and names the notebooks', async () => {
    const { fake, browse } = setup();
    fake.repos = [
      {
        owner: 'ryan',
        name: 'code',
        files: {
          'README.md': '# code',
          '.github/workflows/ci.yml': 'on: push',
          'src/app/main.ts': '',
          'docs/notes/.penmoss/notebook.json': notebookJson(
            '01JBNOTEBOOK00000000000042',
            'Team notes',
          ),
          'docs/notes/Inbox/Call.md': 'call',
          'docs/guide/intro.md': 'intro',
        },
      },
    ];
    const folders = await browse.folders(TOKEN, 'ryan/code', 'main');
    expect(folders).toEqual({
      ok: true,
      value: {
        empty: false,
        truncated: false,
        folders: [
          { path: '', notebook: null },
          { path: 'docs', notebook: null },
          { path: 'docs/guide', notebook: null },
          {
            path: 'docs/notes',
            notebook: { id: '01JBNOTEBOOK00000000000042', name: 'Team notes' },
          },
          { path: 'src', notebook: null },
          { path: 'src/app', notebook: null },
        ],
      },
    });
    expect(
      fake.requests.some((each) => each.path === '/repos/ryan/code/git/trees/main?recursive=1'),
    ).toBe(true);
  });

  it('a notebook at the root hides every folder under it', async () => {
    const { fake, browse } = setup();
    fake.repos = [
      {
        owner: 'ryan',
        name: 'notes',
        files: {
          '.penmoss/notebook.json': notebookJson('01JBNOTEBOOK0000000000000A', 'Home'),
          'Inbox/a.md': 'a',
        },
      },
    ];
    await expect(browse.folders(TOKEN, 'ryan/notes', 'main')).resolves.toEqual({
      ok: true,
      value: {
        empty: false,
        truncated: false,
        folders: [{ path: '', notebook: { id: '01JBNOTEBOOK0000000000000A', name: 'Home' } }],
      },
    });
  });

  it('an empty repository is just its root; a truncated tree says so', async () => {
    const { fake, browse } = setup();
    fake.repos = [
      { owner: 'ryan', name: 'empty', files: null },
      { owner: 'ryan', name: 'huge', files: { 'a/b.md': 'x' }, truncated: true },
    ];
    await expect(browse.folders(TOKEN, 'ryan/empty', 'main')).resolves.toEqual({
      ok: true,
      value: { empty: true, truncated: false, folders: [{ path: '', notebook: null }] },
    });
    await expect(browse.folders(TOKEN, 'ryan/huge', 'main')).resolves.toMatchObject({
      ok: true,
      value: { truncated: true },
    });
  });

  it('checks the name and branch before asking, and encodes the branch', async () => {
    const { fake, browse } = setup();
    fake.repos = [
      { owner: 'ryan', name: 'r', defaultBranch: 'notes/main', files: { 'a/x.md': 'x' } },
    ];
    await expect(browse.folders(TOKEN, 'ryan/r', 'main..x')).resolves.toMatchObject({
      ok: false,
      error: { reason: 'invalid' },
    });
    await expect(browse.folders(TOKEN, '../etc', 'main')).resolves.toMatchObject({
      ok: false,
      error: { reason: 'invalid' },
    });
    await expect(browse.folders(TOKEN, 'ryan/r/extra', 'main')).resolves.toMatchObject({
      ok: false,
      error: { reason: 'invalid' },
    });
    expect(fake.requests).toEqual([]);
    await expect(browse.folders(TOKEN, 'ryan/r', 'notes/main')).resolves.toMatchObject({
      ok: true,
    });
    expect(fake.requests[0]!.path).toBe('/repos/ryan/r/git/trees/notes%2Fmain?recursive=1');
  });
});

describe('owners and a new private repository', () => {
  it('lists the account then its organisations', async () => {
    const { fake, browse } = setup();
    fake.orgs = ['acme'];
    await expect(browse.owners(TOKEN)).resolves.toEqual({
      ok: true,
      value: [
        { login: 'ryan', kind: 'user' },
        { login: 'acme', kind: 'org' },
      ],
    });
  });

  it('makes an empty private repository for the account or an organisation, and says when the name is taken', async () => {
    const { fake, browse } = setup();
    fake.orgs = ['acme'];
    const made = await browse.createRepo(TOKEN, { login: 'ryan', kind: 'user' }, 'work-log-notes');
    expect(made).toMatchObject({
      ok: true,
      value: { fullName: 'ryan/work-log-notes', visibility: 'private', empty: true, canPush: true },
    });
    expect(fake.requests.at(-1)).toMatchObject({
      method: 'POST',
      path: '/user/repos',
      body: { name: 'work-log-notes', private: true, auto_init: false },
    });
    await expect(
      browse.createRepo(TOKEN, { login: 'acme', kind: 'org' }, 'team-notes'),
    ).resolves.toMatchObject({ ok: true });
    expect(fake.requests.at(-1)!.path).toBe('/orgs/acme/repos');
    await expect(
      browse.createRepo(TOKEN, { login: 'ryan', kind: 'user' }, 'work-log-notes'),
    ).resolves.toMatchObject({
      ok: false,
      error: { reason: 'exists' },
    });
    const before = fake.requests.length;
    await expect(
      browse.createRepo(TOKEN, { login: 'ryan', kind: 'user' }, 'bad name'),
    ).resolves.toMatchObject({
      ok: false,
      error: { reason: 'invalid' },
    });
    expect(fake.requests).toHaveLength(before);
  });
});

describe('names', () => {
  it('a new repository is named after the notebook, in kebab case, plus -notes (D62)', () => {
    expect(defaultRepoName('Work Log')).toBe('work-log-notes');
    expect(defaultRepoName('  Ryan’s  Notes!! ')).toBe('ryan-s-notes-notes');
    expect(defaultRepoName('')).toBe('notes');
    expect(defaultRepoName('---')).toBe('notes');
  });

  it('checks repository and branch names as GitHub and git do', () => {
    // Older accounts can end in a hyphen or double one (review).
    for (const owner of ['ryan', 'acme-co', 'foo-', 'a--b', 'x'.repeat(39)]) {
      expect(ownerOk(owner)).toBe(true);
    }
    for (const owner of ['', '-x', 'a/b', 'a.b', '..', 'x'.repeat(40)]) {
      expect(ownerOk(owner)).toBe(false);
    }
    expect(repoNameOk('work-log-notes')).toBe(true);
    expect(repoNameOk('a b')).toBe(false);
    expect(repoNameOk('..')).toBe(false);
    expect(branchNameOk('main')).toBe(true);
    expect(branchNameOk('notes/main')).toBe(true);
    for (const bad of ['', '-x', 'a..b', 'a b', 'a~1', 'x.lock', 'a//b', '.hidden', 'a/', '@{x}']) {
      expect(branchNameOk(bad)).toBe(false);
    }
  });
});
