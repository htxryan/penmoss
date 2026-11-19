/**
 * The dashboard behind Cloudflare Access (PEN-137, AC34): with no token, a forged one, one for
 * another application or team, an expired one or one not yet valid, every route (the page's
 * files too) is 403; a valid token gets the page and the API. Nothing but GET and HEAD.
 */
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { ACCESS_HEADER, AccessVerifier, teamHost } from '../src/access';
import { handle, type Deps } from '../src/handler';
import { TEST_AUD, createSigner, type TestSigner } from './signer';

const ORIGIN = 'https://stats.penmoss.test';
let signer: TestSigner;
let deps: Deps;

beforeAll(async () => {
  signer = await createSigner();
  deps = { verifier: new AccessVerifier(signer.fetchCerts), now: Date.now, cache: null };
});

async function call(path: string, token?: string, init: RequestInit = {}, using = deps) {
  const headers = new Headers(init.headers);
  if (token !== undefined) headers.set(ACCESS_HEADER, token);
  const ctx = createExecutionContext();
  const response = await handle(
    new Request(`${ORIGIN}${path}`, { ...init, headers }),
    env,
    ctx,
    using,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

const ROUTES = [
  '/',
  '/index.html',
  '/app.js',
  '/app.css',
  '/api/overview',
  '/api/health?days=7',
  '/nope',
];

describe('without a valid Access token', () => {
  it('is 403 with no header, on every route', async () => {
    for (const path of ROUTES) expect((await call(path)).status, path).toBe(403);
  });

  it('is 403 for a forged token: signed by another key with the same kid', async () => {
    const forger = await createSigner('test-key-1');
    const token = await forger.sign();
    for (const path of ROUTES) expect((await call(path, token)).status, path).toBe(403);
  });

  it('is 403 for a token whose payload was changed after signing', async () => {
    const [head, , signature] = (await signer.sign()).split('.');
    const body = btoa(
      JSON.stringify({
        aud: [TEST_AUD],
        iss: 'https://penmoss-test.cloudflareaccess.com',
        exp: 9_999_999_999,
        email: 'mallory@example.invalid',
      }),
    )
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect((await call('/api/overview', `${head}.${body}.${signature}`)).status).toBe(403);
  });

  it('is 403 for another application, another team, or no algorithm', async () => {
    expect((await call('/', await signer.sign({ aud: ['another-application'] }))).status).toBe(403);
    expect((await call('/', await signer.sign({ aud: 'another-application' }))).status).toBe(403);
    expect(
      (await call('/', await signer.sign({ iss: 'https://evil.cloudflareaccess.com' }))).status,
    ).toBe(403);
    expect((await call('/', await signer.sign({}, { alg: 'none' }))).status).toBe(403);
    expect((await call('/', await signer.sign({}, { alg: 'HS256' }))).status).toBe(403);
    expect((await call('/', await signer.sign({}, { kid: 'unknown-key' }))).status).toBe(403);
  });

  it('is 403 once the token has expired, or before it is valid', async () => {
    const now = Math.floor(Date.now() / 1000);
    expect((await call('/', await signer.sign({ exp: now - 1 }))).status).toBe(403);
    expect((await call('/', await signer.sign({ exp: undefined }))).status).toBe(403);
    expect((await call('/', await signer.sign({ nbf: now + 3600 }))).status).toBe(403);
  });

  it('is 403 for rubbish, and when the Worker has no team or AUD set', async () => {
    for (const token of ['', 'a.b', 'a.b.c', '...', 'x'.repeat(5000)]) {
      expect((await call('/', token)).status, token.slice(0, 10)).toBe(403);
    }
    const token = await signer.sign();
    const ctx = createExecutionContext();
    for (const missing of [
      { ACCESS_AUD: '' },
      { ACCESS_TEAM: '' },
      { ACCESS_TEAM: 'evil.example.com' },
    ]) {
      const request = new Request(`${ORIGIN}/`, { headers: { [ACCESS_HEADER]: token } });
      expect((await handle(request, { ...env, ...missing }, ctx, deps)).status).toBe(403);
    }
  });

  it('is 403 when the certs cannot be fetched', async () => {
    const offline: Deps = {
      ...deps,
      verifier: new AccessVerifier(() => Promise.reject(new Error('offline'))),
    };
    expect((await call('/', await signer.sign(), {}, offline)).status).toBe(403);
  });
});

describe('with a valid Access token', () => {
  it('serves the page, its files and the API', async () => {
    const token = await signer.sign();
    const page = await call('/', token);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('<title>Penmoss Usage</title>');
    expect(page.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect((await call('/app.js', token)).status).toBe(200);
    expect((await call('/app.css', token)).status).toBe(200);
    const api = await call('/api/health?days=7', token);
    expect(api.status).toBe(200);
    expect(await api.json()).toMatchObject({ view: 'health', filters: { days: 7 } });
  });

  it('allows only GET and HEAD', async () => {
    const token = await signer.sign();
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect((await call('/api/overview', token, { method })).status, method).toBe(405);
    }
    expect((await call('/', token, { method: 'HEAD' })).status).toBe(200);
  });

  it('fetches the team certs once, not on every request', async () => {
    let fetched = 0;
    const counting = new AccessVerifier((url) => {
      fetched++;
      return signer.fetchCerts(url);
    });
    const token = await signer.sign();
    for (let i = 0; i < 3; i++) {
      expect((await call('/api/health', token, {}, { ...deps, verifier: counting })).status).toBe(
        200,
      );
    }
    expect(fetched).toBe(1);
  });
});

it('teamHost takes a team name or its domain, nothing else', () => {
  expect(teamHost('penmoss')).toBe('penmoss.cloudflareaccess.com');
  expect(teamHost('Penmoss.cloudflareaccess.com')).toBe('penmoss.cloudflareaccess.com');
  expect(teamHost('')).toBeNull();
  expect(teamHost(undefined)).toBeNull();
  expect(teamHost('evil.com/x')).toBeNull();
  expect(teamHost('penmoss.example.com')).toBeNull();
});

it('the Worker entry exports nothing but its handler, as workerd requires', async () => {
  const entry = await import('../src/index');
  expect(Object.keys(entry)).toEqual(['default']);
});
