/**
 * The Notebooks page (PEN-194), in workerd with GitHub faked: the list with each notebook's place,
 * access and sync state; Add Notebook… as the app's own flow (A1701), so its page and the bridge
 * calls the flow makes (the App's repositories or an account's, a repository's folders, the add
 * of a notebook there or of a new one, Create New Repo, the accounts of Manage GitHub Accounts);
 * Remove… after asking; Replace Token…; a token shown only by its last four characters; and the
 * forms' and calls' tokens.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { call, forgetApp, keepTestApp, keepTestNotebooks, ORIGIN, signInToPages } from './support';

const ID = '01JBNOTEBOOK0000000000000X';
const NOTEBOOK_JSON = (name: string, id = ID) => btoa(JSON.stringify({ id, name, format: 1 }));

/** Where each repository holds its notebook, by `repository#branch`: the folder, '' for the root. */
const NOTEBOOKS: Record<string, string> = { 'ryan/other#main': '', 'quanta/new#dev': 'penmoss' };

const PAT = 'github_pat_new1234';

/** GitHub, faked: the App's installation, an account's token, each repository's files. */
function fakeGitHub(login = 'htxryan') {
  const real = globalThis.fetch;
  const asked: string[] = [];
  /** Notebooks made through the contents API, by `repository#branch:path`. */
  const made = new Map<string, string>();
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    // As workerd: a fetch takes only `follow` or `manual`.
    if (init?.redirect === 'error') throw new TypeError('Invalid redirect value');
    const auth = new Headers(init?.headers).get('authorization') ?? '';
    const method = init?.method ?? 'GET';
    const path = url.pathname + url.search;
    asked.push(`${method} ${path} ${auth}`);
    if (url.origin === 'https://github.test' && url.pathname === '/login/oauth/access_token') {
      return Response.json({ access_token: 'ghu_fake', token_type: 'bearer', scope: '' });
    }
    if (url.origin !== 'https://api.github.test') return real(input, init);
    const repoJson = (owner: string, name: string, extra: Record<string, unknown> = {}) => ({
      full_name: `${owner}/${name}`,
      name,
      owner: { login: owner },
      clone_url: `https://github.com/${owner}/${name}.git`,
      private: true,
      visibility: 'private',
      default_branch: 'main',
      pushed_at: '2026-11-01T00:00:00Z',
      permissions: { push: true },
      size: 10,
      ...extra,
    });
    if (url.pathname === '/user') {
      if (auth === `Bearer ${PAT}`) return Response.json({ login: 'quanta-ryan' });
      if (auth === 'Bearer github_pat_wrong') {
        return Response.json({ message: 'Bad credentials' }, { status: 401 });
      }
      return Response.json({ login });
    }
    if (url.pathname === '/user/orgs') return Response.json([]);
    if (url.pathname === '/user/repos' && method === 'POST') {
      if (auth !== 'Bearer ghu_fake' && auth !== `Bearer ${PAT}`) {
        return Response.json({ message: 'Bad credentials' }, { status: 401 });
      }
      const body = JSON.parse(init?.body as string) as { name: string };
      const owner = auth === 'Bearer ghu_fake' ? login : 'quanta-ryan';
      return Response.json(repoJson(owner, body.name, { size: 0, pushed_at: null }), {
        status: 201,
      });
    }
    if (url.pathname === '/user/repos') {
      if (auth !== `Bearer ${PAT}`) {
        return Response.json({ message: 'Bad credentials' }, { status: 401 });
      }
      return Response.json([
        repoJson('quanta', 'new'),
        repoJson('quanta', 'readonly', { permissions: { push: false } }),
      ]);
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
        total_count: 2,
        repositories: [
          // As the metadata token minted to list them sees them.
          repoJson('ryan', 'empty', {
            size: 0,
            pushed_at: '2026-01-01T00:00:00Z',
            permissions: { push: false },
          }),
          repoJson('ryan', 'other', { permissions: { push: false } }),
        ],
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
    const allowed = name.startsWith('ryan/') ? auth === 'Bearer ghs_app' : auth === `Bearer ${PAT}`;
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
    const contents = /^\/contents\/([^?]+)(?:\?ref=(.*))?$/.exec(rest);
    if (contents) {
      const file = decodeURIComponent(contents[1]!);
      if (method === 'PUT') {
        const body = JSON.parse(init?.body as string) as { content: string; branch: string };
        made.set(`${name}#${body.branch}:${file}`, body.content);
        return Response.json({ content: { path: file } }, { status: 201 });
      }
      const key = `${name}#${decodeURIComponent(contents[2] ?? 'main')}:${file}`;
      if (made.has(key)) return Response.json({ content: made.get(key) });
      if (name === 'ryan/empty') return Response.json({ message: 'Not Found' }, { status: 404 });
      return Response.json({
        content: NOTEBOOK_JSON(name === 'ryan/other' ? 'Other' : 'Quanta New'),
      });
    }
    // Anything a sync asks for: nothing here.
    return Response.json({ message: 'Not Found' }, { status: 404 });
  });
  return { asked, made };
}

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(async () => {
  await forgetApp();
  await keepTestApp();
  await keepTestNotebooks([]);
});

/** A bridge call's answer, as these tests read it: each test checks the fields it expects. */
interface Answer {
  readonly ok: boolean;
  readonly via: string;
  readonly value: {
    readonly kind: string;
    readonly created: boolean;
    readonly repos: readonly { readonly fullName: string; readonly canPush: boolean }[];
    readonly folders: readonly { readonly path: string; readonly notebook: unknown }[];
    readonly fullName: string;
    readonly notebook: { readonly notebookId: string; readonly name: string };
  };
  readonly error: { readonly code: string; readonly message: string };
  readonly status: { readonly accounts: readonly { readonly login: string }[] };
  readonly message: string;
}

/** The owner, signed in: the session cookie and the page's form token. */
async function owner() {
  const github = fakeGitHub();
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
  /** One of the flow's bridge calls, as the page's script makes it. */
  const bridge = async (name: string, args: readonly unknown[], token = csrf) => {
    const response = await call('/notebooks/add/call', {
      method: 'POST',
      headers: {
        cookie: session,
        'sec-fetch-site': 'same-origin',
        'x-penmoss-csrf': token,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name, args }),
    });
    const body = await response.json<{ answer?: Answer; refused?: string }>();
    return { status: response.status, answer: body.answer!, refused: body.refused };
  };
  return { get, post, bridge, csrf, github };
}

const at = (remote: string, branch = 'main', dir = '') => ({ remote, branch, dir });

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

  it('serves the app’s Add Notebook, with the form token, and its styles', async () => {
    const { get, csrf } = await owner();
    const response = await get('/notebooks/add');
    const html = await response.text();
    expect(html).toContain('id="relay-add-root"');
    expect(html).toContain('<script src="/notebooks/add/flow.js"></script>');
    const start = JSON.parse(
      /<script type="application\/json" id="relay-add">([^<]*)<\/script>/.exec(html)![1]!,
    ) as { csrf: string; login: string };
    expect([start.csrf, start.login]).toEqual([csrf, 'htxryan']);
    // The first run's own styles are on the page.
    expect(html).toContain('.fr-screen');
    expect(response.headers.get('content-security-policy')).toContain(
      "script-src 'self'; connect-src 'self';",
    );
    const script = await get('/notebooks/add/flow.js');
    expect(script.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(await script.text()).toContain('relay-add-root');
  });

  it('opens a notebook through the App, as the Mac opens one through its git sign-in', async () => {
    const { get, bridge } = await owner();
    expect((await bridge('gitLogin', [])).answer).toBe('htxryan');
    const repos = (await bridge('repos', [])).answer;
    expect(repos.via).toBe('git');
    expect(repos.value.repos.map((each) => [each.fullName, each.canPush])).toEqual([
      ['ryan/other', true],
      ['ryan/empty', true],
    ]);
    const folders = (await bridge('folders', ['ryan/other', 'main'])).answer;
    expect(folders.value.folders).toEqual([{ path: '', notebook: { id: ID, name: 'Other' } }]);
    const added = (await bridge('add', [at('https://github.com/ryan/other.git')])).answer;
    expect(added.ok).toBe(true);
    expect(added.value.kind).toBe('added');
    expect(added.value.created).toBe(false);
    expect(added.value.notebook).toMatchObject({ notebookId: ID, name: 'Other' });
    const list = await (await get('/notebooks?added=Other')).text();
    expect(list).toContain('Added Other. Claude can use it now.');
    expect(list).toContain('ryan/other · main · GitHub App');
    // Listed as the Mac's git.list lists it, so the flow shows it Already Added.
    const listed = (await bridge('list', [])).answer as unknown as { notebookId: string }[];
    expect(listed.map((each) => each.notebookId)).toEqual([ID]);
    const again = (await bridge('add', [at('https://github.com/ryan/other.git')])).answer;
    expect(again.error.code).toBe('notebook_exists');
  });

  it('makes a new notebook where there is none, once it is named', async () => {
    const { bridge, github } = await owner();
    const place = at('https://github.com/ryan/empty.git');
    const unnamed = (await bridge('add', [place])).answer;
    expect(unnamed.value.kind).toBe('needs-name');
    const made = (await bridge('add', [{ ...place, name: 'Scratch' }])).answer;
    expect(made.value.created).toBe(true);
    expect(made.value.notebook.name).toBe('Scratch');
    const file = github.made.get('ryan/empty#main:.penmoss/notebook.json')!;
    expect(JSON.parse(atob(file))).toMatchObject({ name: 'Scratch', format: 1, renderVersion: 3 });
  });

  it('keeps a pasted token as an account, lists its repositories, and adds through it', async () => {
    const { get, bridge } = await owner();
    const refused = (await bridge('save', ['github_pat_wrong'])).answer;
    expect(refused.ok).toBe(false);
    expect(refused.message).toContain('GitHub does not accept this token');
    const saved = (await bridge('save', [PAT])).answer;
    expect(saved.status.accounts.map((each) => each.login)).toEqual(['quanta-ryan']);
    const status = (await bridge('status', [])).answer;
    expect(JSON.stringify(status)).not.toContain(PAT);
    const repos = (await bridge('repos', ['quanta-ryan'])).answer;
    expect(repos.via).toBe('penmoss');
    expect(repos.value.repos.map((each) => [each.fullName, each.canPush])).toEqual([
      ['quanta/new', true],
      ['quanta/readonly', false],
    ]);
    // Pick Branch (A1621): the default first, then by name; the notebook is on dev's penmoss/.
    const branches = (await bridge('branches', ['quanta/new', 'main', 'quanta-ryan'])).answer;
    expect(branches).toMatchObject({ ok: true, via: 'penmoss', value: ['main', 'dev'] });
    const onDev = (await bridge('folders', ['quanta/new', 'dev', 'quanta-ryan'])).answer;
    expect(onDev.value.folders).toContainEqual({
      path: 'penmoss',
      notebook: { id: ID, name: 'Quanta New' },
    });
    const onMain = (await bridge('folders', ['quanta/new', 'main', 'quanta-ryan'])).answer;
    expect(onMain.value.folders.some((each) => each.notebook)).toBe(false);
    // Paste a URL, with its branch and folder: the App isn't installed there, the account is.
    const added = (await bridge('add', [at('https://github.com/quanta/new', 'dev', 'penmoss')]))
      .answer;
    expect(added.value.notebook.name).toBe('Quanta New');
    const list = await (await get('/notebooks')).text();
    expect(list).toContain('quanta/new · dev · penmoss/ · Token ending 1234');
    expect(list).not.toContain('github_pat_new');
    const removed = (await bridge('remove', ['quanta-ryan'])).answer;
    expect(removed.status.accounts).toEqual([]);
  });

  it('makes a repository as the owner, through their sign-in to the relay', async () => {
    const { bridge, github } = await owner();
    expect((await bridge('owners', [])).answer.value).toEqual([{ login: 'htxryan', kind: 'user' }]);
    const made = (await bridge('create', [{ login: 'htxryan', kind: 'user' }, 'fresh'])).answer;
    expect(made.ok).toBe(true);
    expect(made.value.fullName).toBe('htxryan/fresh');
    expect(github.asked).toContain('POST /user/repos Bearer ghu_fake');
  });

  it('says why when it can’t reach a repository, and makes only the flow’s calls', async () => {
    const { bridge } = await owner();
    const unreachable = (await bridge('add', [at('https://github.com/nobody/thing')])).answer;
    expect(unreachable.error.message).toContain(
      'The relay’s GitHub App isn’t installed on nobody/thing',
    );
    const elsewhere = (await bridge('add', [at('https://gitlab.com/ryan/notes')])).answer;
    expect(elsewhere.error.code).toBe('invalid');
    expect((await bridge('keepApp', [{}])).answer).toBeNull();
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
    const saved = await post(`/notebooks/token?n=${key}`, { token: PAT });
    expect(saved.status).toBe(303);
    expect(await (await get('/notebooks')).text()).toContain('Token ending 1234');
  });

  it('refuses a form, or a call, without its token', async () => {
    const { post, bridge } = await owner();
    const forged = await post('/notebooks/remove?n=x', { csrf: 'f'.repeat(48) });
    expect(forged.status).toBe(403);
    expect((await bridge('repos', [], 'f'.repeat(48))).status).toBe(403);
    expect((await bridge('save', [PAT], '')).status).toBe(403);
  });
});
