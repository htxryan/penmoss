/**
 * The Notebooks page (PEN-194), in workerd with GitHub faked: the list with each notebook's place,
 * access and sync state; Add Notebook… through the App or a token, the default branch first, and
 * refused without a notebook.json; Remove… after asking; Replace Token…; a token shown only by its
 * last four characters; and the forms' tokens.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { call, forgetApp, keepTestApp, keepTestNotebooks, ORIGIN, signInToPages } from './support';

const NOTEBOOK_JSON = (name: string) =>
  btoa(JSON.stringify({ id: '01JBNOTEBOOK0000000000000X', name, format: 1 }));

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

const pendingOf = (html: string) => /name="pending" value="([0-9a-f]{48})"/.exec(html)![1]!;

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

  it('adds a notebook through the App: its repository offered, the default branch first', async () => {
    const { get, post } = await owner();
    const add = await (await get('/notebooks/add')).text();
    expect(add).toContain('<option value="ryan/other">');
    const step = await post('/notebooks/add', { repository: 'ryan/other', access: 'app' });
    expect(step.status).toBe(200);
    const html = await step.text();
    expect(html.indexOf('<option value="main">')).toBeLessThan(
      html.indexOf('<option value="dev">'),
    );
    const added = await post('/notebooks/add/finish', {
      pending: pendingOf(html),
      branch: 'main',
      folder: '',
    });
    expect(added.status).toBe(303);
    const list = await (await get('/notebooks')).text();
    expect(list).toContain('ryan/other · main · GitHub App');
    expect(list).not.toContain('No Notebooks Yet');
  });

  it('adds a notebook by a token, showing only its last four characters', async () => {
    const { get, post } = await owner();
    const step = await post('/notebooks/add', {
      repository: 'quanta/new',
      access: 'token',
      token: 'github_pat_new1234',
    });
    const html = await step.text();
    expect(html).not.toContain('github_pat_new1234');
    const added = await post('/notebooks/add/finish', {
      pending: pendingOf(html),
      branch: 'main',
      folder: 'penmoss',
    });
    expect(added.status).toBe(303);
    const list = await (await get('/notebooks')).text();
    expect(list).toContain('quanta/new · main · penmoss/ · Token ending 1234');
    expect(list).not.toContain('github_pat_new');
    expect(list).toContain('Replace Token…');
  });

  it('refuses a repository with no notebook.json, or one it can’t read, saying why', async () => {
    const { post } = await owner();
    const step = await (
      await post('/notebooks/add', { repository: 'ryan/empty', access: 'app' })
    ).text();
    const refused = await post('/notebooks/add/finish', {
      pending: pendingOf(step),
      branch: 'main',
      folder: '',
    });
    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain('There’s no Penmoss notebook in ryan/empty on main');
    const unreadable = await post('/notebooks/add', {
      repository: 'quanta/new',
      access: 'token',
      token: 'github_pat_wrong',
    });
    expect(unreadable.status).toBe(400);
    expect(await unreadable.text()).toContain('can’t be read with this access');
    const noToken = await post('/notebooks/add', { repository: 'quanta/new', access: 'token' });
    expect(await noToken.text()).toContain('Paste the notebook’s token');
    const badName = await post('/notebooks/add', { repository: 'nope', access: 'app' });
    expect(await badName.text()).toContain('Name the repository as owner/name');
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
    const forged = await post('/notebooks/add', {
      repository: 'ryan/other',
      access: 'app',
      csrf: 'f'.repeat(48),
    });
    expect(forged.status).toBe(403);
  });
});
