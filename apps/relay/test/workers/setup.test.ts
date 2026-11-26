/**
 * Setting up a relay and the owner's pages (PEN-193), in workerd with GitHub faked: the manifest
 * form and its one-time state, the owner check on the App GitHub made, an expired code, one App
 * per relay, the session cookie's flags, form tokens, and no secret on any page.
 */
import { env, exports } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { forgetApp, keepTestApp, TEST_APP } from './support';

const ORIGIN = 'https://mcp.penmoss.test';

const call = (path: string, init: RequestInit = {}) =>
  exports.default.fetch(`${ORIGIN}${path}`, { redirect: 'manual', ...init });

/** GitHub's manifest conversion, faked: the App it made, by `owner`, or a refusal. */
function fakeConversion(answer: { owner: string } | { status: number }) {
  const real = globalThis.fetch;
  const asked: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith('https://api.github.test/app-manifests/')) {
      asked.push(url);
      if ('status' in answer)
        return Response.json({ message: 'Not Found' }, { status: answer.status });
      return Response.json(
        {
          id: 77,
          slug: 'made-app',
          name: 'Made App',
          owner: { login: answer.owner },
          html_url: 'https://github.test/apps/made-app',
          client_id: 'Iv1.made',
          client_secret: 'made-secret-abcdef',
          pem: 'fake-private-key-MADE',
        },
        { status: 201 },
      );
    }
    return real(input, init);
  });
  return asked;
}

/** GitHub's sign-in, faked: the code exchange and `GET /user` answer as `login`. */
function fakeGitHubLogin(login: string) {
  const real = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url === 'https://github.test/login/oauth/access_token') {
      return Response.json({ access_token: 'ghu_fake', token_type: 'bearer', scope: '' });
    }
    if (url === 'https://api.github.test/user') return Response.json({ login });
    // The notebooks' repositories: none here (the page lists them; nothing syncs).
    if (url.startsWith('https://api.github.test/repos/')) {
      return Response.json({ message: 'Not Found' }, { status: 404 });
    }
    return real(input, init);
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(async () => {
  await forgetApp();
});

/** Opens /setup: its state, its cookie and its manifest. */
async function openSetup() {
  const response = await call('/setup');
  expect(response.status).toBe(200);
  const html = await response.text();
  const action = /<form method="post" action="([^"]+)">/.exec(html)![1]!.replace(/&amp;/g, '&');
  const manifest = JSON.parse(
    /name="manifest" value="([^"]+)"/
      .exec(html)![1]!
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&'),
  ) as Record<string, unknown>;
  const state = new URL(action).searchParams.get('state')!;
  const cookie = response.headers.get('set-cookie')!;
  return { html, action, manifest, state, cookie, response };
}

const back = (state: string, cookie: string, code = 'manifest-code') =>
  call(`/setup?code=${code}&state=${state}`, { headers: { cookie: cookie.split(';')[0]! } });

describe('setting up a relay', () => {
  it('shows Set Up This Relay, posting a manifest with a one-time state to GitHub', async () => {
    const { html, action, manifest, state, cookie, response } = await openSetup();
    expect(html).toContain('<h1 class="t-page-title">Set Up This Relay</h1>');
    expect(html).toContain('Create GitHub App…');
    expect(action.startsWith('https://github.test/settings/apps/new?state=')).toBe(true);
    expect(state).toMatch(/^[0-9a-f]{48}$/);
    expect(cookie).toMatch(
      new RegExp(`^penmoss_relay_setup=${state}; HttpOnly; Secure; SameSite=Lax; Path=/setup`),
    );
    expect(response.headers.get('content-security-policy')).toContain(
      "form-action 'self' https://github.test",
    );
    expect(manifest).toMatchObject({
      url: ORIGIN,
      redirect_url: `${ORIGIN}/setup`,
      callback_urls: [`${ORIGIN}/callback`],
      setup_url: `${ORIGIN}/notebooks`,
      hook_attributes: { active: false },
      public: false,
      default_permissions: { contents: 'write', metadata: 'read' },
      default_events: [],
    });
    expect(String(manifest['name']).length).toBeLessThanOrEqual(34);
    // A second visit has another state: each is good once.
    expect((await openSetup()).state).not.toBe(state);
  });

  it('keeps the App GitHub made for the owner, then shows only what is done', async () => {
    const { state, cookie } = await openSetup();
    const asked = fakeConversion({ owner: 'HtxRyan' });
    const done = await back(state, cookie);
    expect(done.status).toBe(303);
    expect(done.headers.get('location')).toBe('/setup');
    expect(asked).toEqual(['https://api.github.test/app-manifests/manifest-code/conversions']);
    const page = await (await call('/setup')).text();
    expect(page).toContain('Made App, made on HtxRyan.');
    expect(page).toContain('href="https://github.test/apps/made-app/installations/new"');
    expect(page).not.toContain('Create GitHub App…');
    expect(page).not.toContain('made-secret');
    expect(page).not.toContain('fake-private-key');
    // The same code again, or a new one, can't make a second App.
    const again = await back(state, cookie, 'another-code');
    expect(again.status).toBe(409);
    expect(await again.text()).toContain('a relay keeps one');
  });

  it('refuses an App another account made, keeping nothing', async () => {
    const { state, cookie } = await openSetup();
    fakeConversion({ owner: 'someone-else' });
    const refused = await back(state, cookie);
    expect(refused.status).toBe(403);
    const html = await refused.text();
    expect(html).toContain('It was made by someone-else');
    expect(html).toContain('This relay belongs to htxryan');
    expect(html).not.toContain('made-secret');
    expect(await (await call('/setup')).text()).toContain('Create GitHub App…');
  });

  it('refuses a return with another state, or from another browser', async () => {
    const { state, cookie } = await openSetup();
    const asked = fakeConversion({ owner: 'htxryan' });
    expect((await back('0'.repeat(48), cookie)).status).toBe(400);
    const other = await call(`/setup?code=c&state=${state}`);
    expect(other.status).toBe(400);
    expect(await other.text()).toContain('This Setup Expired');
    expect(asked).toEqual([]);
  });

  it('says so when GitHub’s code has expired', async () => {
    const { state, cookie } = await openSetup();
    fakeConversion({ status: 404 });
    const expired = await back(state, cookie);
    expect(expired.status).toBe(400);
    expect(await expired.text()).toContain('expired or was used already');
    // The state is spent too: the same return can't be tried again.
    expect((await back(state, cookie)).status).toBe(400);
  });

  it('turns claude.ai away until the relay is set up', async () => {
    const response = await call('/authorize?client_id=x');
    expect(response.status).toBe(503);
    expect(await response.text()).toContain('Set Up This Relay');
  });
});

/** Signs in on the relay's own pages as `login`: the session cookie, or the refusal. */
async function signInToPages(login: string) {
  const start = await call('/sign-in');
  expect(start.status).toBe(302);
  const github = new URL(start.headers.get('location')!);
  expect(github.searchParams.get('client_id')).toBe(TEST_APP.clientId);
  const state = github.searchParams.get('state')!;
  const stateCookie = start.headers.get('set-cookie')!.split(';')[0]!;
  fakeGitHubLogin(login);
  return call(`/callback?code=c&state=${state}`, { headers: { cookie: stateCookie } });
}

const sessionOf = (response: Response) =>
  response.headers.getSetCookie().find((each) => each.startsWith('penmoss_relay_session='))!;

describe("the owner's pages", () => {
  it('signs the owner in with an HttpOnly, Secure, SameSite=Lax session', async () => {
    await keepTestApp();
    const signedIn = await signInToPages('htxryan');
    expect(signedIn.status).toBe(302);
    expect(signedIn.headers.get('location')).toBe('/notebooks');
    const session = sessionOf(signedIn);
    expect(session).toMatch(
      /^penmoss_relay_session=[0-9a-f]{48}; HttpOnly; Secure; SameSite=Lax; Path=\//,
    );
    const notebooks = await call('/notebooks', { headers: { cookie: session.split(';')[0]! } });
    expect(notebooks.status).toBe(200);
    const html = await notebooks.text();
    expect(html).toContain('<h1 class="t-page-title">Notebooks</h1>');
    expect(html).toContain('Signed in as htxryan');
    expect(html).toContain(`${ORIGIN}/mcp`);
    expect(html).toContain('ryan/notes');
    for (const secret of [TEST_APP.clientSecret, 'FAKEKEY', 'fake-token']) {
      expect(html).not.toContain(secret);
    }
  });

  it('turns another GitHub account away, naming the owner', async () => {
    await keepTestApp();
    const refused = await signInToPages('someone-else');
    expect(refused.status).toBe(403);
    expect(await refused.text()).toContain('This relay belongs to htxryan');
    expect(
      refused.headers.getSetCookie().some((each) => each.startsWith('penmoss_relay_session=')),
    ).toBe(false);
  });

  it('refuses a form without the page’s token, or from another origin', async () => {
    await keepTestApp();
    const session = sessionOf(await signInToPages('htxryan')).split(';')[0]!;
    const page = await (await call('/notebooks', { headers: { cookie: session } })).text();
    const csrf = /name="csrf" value="([0-9a-f]{48})"/.exec(page)![1]!;
    const post = (body: Record<string, string>, headers: Record<string, string> = {}) =>
      call('/sign-out', {
        method: 'POST',
        headers: {
          cookie: session,
          'content-type': 'application/x-www-form-urlencoded',
          ...headers,
        },
        body: new URLSearchParams(body).toString(),
      });
    expect((await post({})).status).toBe(403);
    expect((await post({ csrf: 'f'.repeat(48) })).status).toBe(403);
    expect((await post({ csrf }, { origin: 'https://evil.example' })).status).toBe(403);
    const out = await post({ csrf }, { origin: ORIGIN });
    expect(out.status).toBe(303);
    expect(out.headers.get('set-cookie')).toMatch(/^penmoss_relay_session=; .*Max-Age=0/);
    const after = await (await call('/notebooks', { headers: { cookie: session } })).text();
    expect(after).toContain('Sign In with GitHub');
  });

  it('asks for a sign-in on the Notebooks page without a session', async () => {
    await keepTestApp();
    const html = await (await call('/notebooks')).text();
    expect(html).toContain('Sign in as htxryan');
    expect(html).toContain('href="/sign-in"');
  });
});

describe('a relay without its owner set', () => {
  it('is the only thing env can get wrong before setup', () => {
    expect(env.OWNER_GITHUB_LOGIN).toBe('htxryan');
  });
});
