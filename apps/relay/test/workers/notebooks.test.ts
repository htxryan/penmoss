/**
 * The Notebooks page (PEN-194), in workerd with GitHub faked: the list with each notebook's place,
 * access and sync state; Add Notebook… as the app's flow (the App's repositories or a token's,
 * then the notebooks found on the repository's branches, one choice to add); Remove… after
 * asking; Replace Token…; a token shown only by its last four characters; and the forms' tokens.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { call, forgetApp, keepTestApp, keepTestNotebooks, ORIGIN, signInToPages } from './support';

const NOTEBOOK_JSON = (name: string) =>
  btoa(JSON.stringify({ id: '01JBNOTEBOOK0000000000000X', name, format: 1 }));

/** Where each repository holds its notebook, by `repository#branch`: the folder, '' for the root. */
const NOTEBOOKS: Record<string, string> = { 'ryan/other#main': '', 'quanta/new#dev': 'penmoss' };

/** GitHub, faked: the App's installation, its repositories, and each repository's files. */
function fakeGitHub(login = 'htxryan') {
  const real = globalThis.fetch;
  const asked: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    const auth = new Headers(init?.headers).get('authorization') ?? '';
    const path = url.pathname + url.search;
    asked.push(`${init?.method ?? 'GET'} ${path}`);
    if (url.origin === 'https://github.test' && url.pathname === '/login/oauth/access_token') {
      return Response.json({ access_token: 'ghu_fake', token_type: 'bearer', scope: '' });
    }
    if (url.origin !== 'https://api.github.test') return real(input, init);
    if (path === '/user') return Response.json({ login });
    if (url.pathname === '/user/repos') {
      if (auth !== 'Bearer github_pat_new1234') {
        return Response.json({ message: 'Bad credentials' }, { status: 401 });
      }
      const repo = (name: string, push: boolean) => ({
        full_name: `quanta/${name}`,
        name,
        owner: { login: 'quanta' },
        clone_url: `https://github.com/quanta/${name}.git`,
        private: true,
        visibility: 'private',
        default_branch: 'main',
        permissions: { push },
        size: 10,
      });
      return Response.json([repo('new', true), repo('readonly', false)]);
    }
    if (path.startsWith('/app/installations') && path.endsWith('/access_tokens')) {
      return Response.json(
        { token: 'ghs_app', expires_at: '2099-01-01T00:00:00Z' },
        { status: 201 },
      );
    }
    if (path.startsWith('/app/installations')) return Response.json([{ id: 9 }]);
    if (path.startsWith('/installation/repositories')) {
      return Response.json({
        repositories: [{ full_name: 'ryan/other' }, { full_name: 'ryan/empty' }],
      });
    }
    const repo = /^\/repos\/([^/]+\/[^/?]+)(.*)$/.exec(path);
    if (!repo) return Response.json({ message: 'Not Found' }, { status: 404 });
    const [, name, rest] = repo as unknown as [string, string, string];
    if (rest === '/installation') {
      return name.startsWith('ryan/')
        ? Response.json({ id: 9 })
        : Response.json({}, { status: 404 });
    }
    const allowed = name.startsWith('ryan/')
      ? auth === 'Bearer ghs_app'
      : auth === 'Bearer github_pat_new1234';
    if (!allowed) return Response.json({ message: 'Bad credentials' }, { status: 401 });
    if (rest === '') return Response.json({ default_branch: 'main', private: true });
    if (rest.startsWith('/branches')) return Response.json([{ name: 'dev' }, { name: 'main' }]);
    const tree = /^\/git\/trees\/([^?]+)\?recursive=1$/.exec(rest);
    if (tree) {
      const branch = decodeURIComponent(tree[1]!);
      const at = NOTEBOOKS[`${name}#${branch}`];
      const entries = [{ path: 'README.md', type: 'blob', sha: 'readme' }];
      if (at !== undefined) {
        const dir = at ? `${at}/` : '';
        if (at) entries.push({ path: at, type: 'tree', sha: 'dir' });
        entries.push({ path: `${dir}.penmoss`, type: 'tree', sha: 'meta' });
        entries.push({ path: `${dir}.penmoss/notebook.json`, type: 'blob', sha: `nb-${name}` });
      }
      return Response.json({ tree: entries, truncated: false });
    }
    if (rest.startsWith('/git/blobs/nb-')) {
      return Response.json({
        content: NOTEBOOK_JSON(name === 'ryan/other' ? 'Other' : 'Quanta New'),
      });
    }
    if (rest.startsWith('/contents/')) {
      if (name === 'ryan/empty') return Response.json({ message: 'Not Found' }, { status: 404 });
      return Response.json({
        content: NOTEBOOK_JSON(name === 'ryan/other' ? 'Other' : 'Quanta New'),
      });
    }
    // Anything a sync asks for: nothing here.
    return Response.json({ message: 'Not Found' }, { status: 404 });
  });
  return asked;
}

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(async () => {
  await forgetApp();
  await keepTestApp();
  await keepTestNotebooks([]);
});

/** The owner, signed in: the session cookie and the page's form token. */
async function owner() {
  fakeGitHub();
  const signed = await signInToPages();
  const session = signed.headers
    .getSetCookie()
    .find((each) => each.startsWith('penmoss_relay_session='))!
    .split(';')[0]!;
  const list = await (await call('/notebooks', { headers: { cookie: session } })).text();
  const csrf = /name="csrf" value="([0-9a-f]{48})"/.exec(list)![1]!;
  const get = (path: string) => call(path, { headers: { cookie: session } });
  const post = (path: string, body: Record<string, string>) =>
    call(path, {
      method: 'POST',
      headers: {
        cookie: session,
        origin: ORIGIN,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ csrf, ...body }).toString(),
    });
  return { get, post, csrf };
}

describe('the Notebooks page', () => {
  it('starts empty, with the connector address and Add Notebook…', async () => {
    const { get } = await owner();
    const response = await get('/notebooks');
    const html = await response.text();
    expect(html).toContain('No Notebooks Yet');
    expect(html).toContain(`<code>${ORIGIN}/mcp</code>`);
    expect(html).toContain(`data-copy="${ORIGIN}/mcp">Copy</button>`);
    expect(html).toContain('Add Notebook…');
    // The one script, Copy's, is allowed by its hash and nothing else.
    expect(response.headers.get('content-security-policy')).toMatch(
      /script-src 'sha256-[A-Za-z0-9+/=]+';/,
    );
  });

  it('adds a notebook through the App: its repositories listed, the notebook found, one choice', async () => {
    const { get, post } = await owner();
    const add = await (await get('/notebooks/add')).text();
    expect(add).toContain('href="/notebooks/add/repo?r=ryan%2Fother">Choose</a>');
    expect(add).toContain('href="/notebooks/add/repo?r=ryan%2Fempty">Choose</a>');
    expect(add).toContain('Install on More Repositories…');
    expect(add).not.toContain('owner/name');
    const repo = await (await get('/notebooks/add/repo?r=ryan%2Fother')).text();
    expect(repo).toContain('<span class="lf-row-label">Other</span>');
    expect(repo).toContain('main · Root');
    const added = await post('/notebooks/add/finish', { r: 'ryan/other', b: 'main', f: '' });
    expect(added.status).toBe(303);
    const list = await (await get('/notebooks')).text();
    expect(list).toContain('ryan/other · main · GitHub App');
    expect(await (await get('/notebooks/add/repo?r=ryan%2Fother')).text()).toContain(
      '<span class="relay-state">Added</span>',
    );
  });

  it('adds a notebook by a token: its repositories, the notebook on another branch, never the token', async () => {
    const { get, post } = await owner();
    const started = await post('/notebooks/add/token', { token: 'github_pat_new1234' });
    expect(started.status).toBe(303);
    const at = started.headers.get('location')!;
    const pending = new URL(at, ORIGIN).searchParams.get('p')!;
    const repos = await (await get(at)).text();
    expect(repos).toContain('quanta/new');
    expect(repos).not.toContain('quanta/readonly');
    expect(repos).not.toContain('github_pat_new1234');
    const repo = await (await get(`/notebooks/add/repo?p=${pending}&r=quanta%2Fnew`)).text();
    expect(repo).toContain('<span class="lf-row-label">Quanta New</span>');
    expect(repo).toContain('dev · penmoss/');
    expect(repo).not.toContain('github_pat_new1234');
    const added = await post('/notebooks/add/finish', {
      p: pending,
      r: 'quanta/new',
      b: 'dev',
      f: 'penmoss',
    });
    expect(added.status).toBe(303);
    const list = await (await get('/notebooks')).text();
    expect(list).toContain('quanta/new · dev · penmoss/ · Token ending 1234');
    expect(list).not.toContain('github_pat_new');
    expect(list).toContain('Replace Token…');
  });

  it('says why when a token is refused, a repository holds no notebook, or a place has none', async () => {
    const { get, post } = await owner();
    const refused = await post('/notebooks/add/token', { token: 'github_pat_wrong' });
    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain('GitHub refused this token');
    const empty = await (await get('/notebooks/add/repo?r=ryan%2Fempty')).text();
    expect(empty).toContain('No Notebooks Found');
    expect(empty).toContain('None on <code>main</code>, <code>dev</code>.');
    expect(empty).not.toContain('Look There');
    const none = await post('/notebooks/add/finish', { r: 'ryan/empty', b: 'main', f: '' });
    expect(none.status).toBe(400);
    expect(await none.text()).toContain('There’s no Penmoss notebook in ryan/empty on main');
    const stale = await (await get(`/notebooks/add/token?p=${'a'.repeat(48)}`)).text();
    expect(stale).toContain('This was started too long ago');
    const branch = await (await get('/notebooks/add/repo?r=ryan%2Fother&b=nope')).text();
    expect(branch).toContain('ryan/other has no branch “nope”');
  });

  it('asks before it removes a notebook, and the notes stay in the repository', async () => {
    await keepTestNotebooks([{ repository: 'ryan/other', branch: 'main', root: '' }]);
    const { get, post } = await owner();
    const key = encodeURIComponent('ryan/other#main:');
    const ask = await (await get(`/notebooks/remove?n=${key}`)).text();
    expect(ask).toContain('<h1 class="t-page-title">Remove “ryan/other”?</h1>');
    expect(ask).toContain('Its notes stay in <code>ryan/other</code>');
    expect(ask).toContain('>Remove Notebook</button>');
    const removed = await post(`/notebooks/remove?n=${key}`, {});
    expect(removed.status).toBe(303);
    expect(await (await get('/notebooks')).text()).toContain('No Notebooks Yet');
  });

  it('replaces a notebook’s token after reading the repository with it', async () => {
    await keepTestNotebooks([
      { repository: 'quanta/new', branch: 'main', root: '', token: 'github_pat_old9999' },
    ]);
    const { get, post } = await owner();
    const key = encodeURIComponent('quanta/new#main:');
    expect(await (await get(`/notebooks/token?n=${key}`)).text()).toContain('a token ending 9999');
    const wrong = await post(`/notebooks/token?n=${key}`, { token: 'github_pat_wrong' });
    expect(wrong.status).toBe(400);
    const saved = await post(`/notebooks/token?n=${key}`, { token: 'github_pat_new1234' });
    expect(saved.status).toBe(303);
    expect(await (await get('/notebooks')).text()).toContain('Token ending 1234');
  });

  it('refuses a form without its token', async () => {
    const { post } = await owner();
    const forged = await post('/notebooks/add/token', {
      token: 'github_pat_new1234',
      csrf: 'f'.repeat(48),
    });
    expect(forged.status).toBe(403);
  });
});
