/**
 * The relay Worker in workerd (T55): /mcp refuses calls without a grant; a claude.ai connector
 * registers, is shown the consent page, signs in with GitHub (faked) as the one allowed account,
 * gets a token and reaches MCP; another account, another redirect host and another browser are
 * refused. The Durable Object's SQLite keeps values larger than a row in parts.
 */
import { runInDurableObject } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SqlBlobs } from '../../src/storage';

const ORIGIN = 'https://mcp.penmoss.test';
const CLAUDE_CALLBACK = 'https://claude.ai/api/mcp/auth_callback';

const call = (path: string, init: RequestInit = {}) =>
  exports.default.fetch(`${ORIGIN}${path}`, { redirect: 'manual', ...init });

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

async function register(redirect = CLAUDE_CALLBACK) {
  const response = await call('/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Claude',
      redirect_uris: [redirect],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    }),
  });
  expect(response.status).toBe(201);
  return (await response.json<{ client_id: string }>()).client_id;
}

async function authorizeUrl(clientId: string, redirect = CLAUDE_CALLBACK) {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))),
  );
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirect,
    state: 'claude-state',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    scope: 'notes',
  });
  return { path: `/authorize?${query.toString()}`, verifier };
}

/** GitHub's sign-in, faked: the code exchange and `GET /user` answer as `login`. */
function fakeGitHubLogin(login: string) {
  const real = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url === 'https://github.test/login/oauth/access_token') {
      return Response.json({ access_token: 'gho_fake', token_type: 'bearer', scope: '' });
    }
    if (url === 'https://api.github.test/user') return Response.json({ login });
    return real(input, init);
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

async function signIn(login: string) {
  const clientId = await register();
  const { path, verifier } = await authorizeUrl(clientId);
  const consent = await call(path);
  expect(consent.status).toBe(200);
  // GitHub may redirect straight back, so the form's redirect chain ends at claude.ai.
  const formAction = /form-action ([^;]+)/.exec(
    consent.headers.get('content-security-policy')!,
  )![1]!;
  expect(formAction.split(' ')).toEqual(
    expect.arrayContaining(["'self'", 'https://github.test', 'https://claude.ai']),
  );
  const html = await consent.text();
  expect(html).toContain('Continue with GitHub');
  expect(html).toContain('ryan/notes');
  const pending = /name="pending" value="([0-9a-f]+)"/.exec(html)![1]!;
  const toGitHub = await call('/authorize', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ pending }).toString(),
  });
  expect(toGitHub.status).toBe(302);
  const github = new URL(toGitHub.headers.get('location')!);
  expect(github.origin + github.pathname).toBe('https://github.test/login/oauth/authorize');
  expect(github.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/callback`);
  const state = github.searchParams.get('state')!;
  const cookie = toGitHub.headers.get('set-cookie')!.split(';')[0]!;
  fakeGitHubLogin(login);
  const back = await call(`/callback?code=github-code&state=${state}`, { headers: { cookie } });
  return { back, clientId, verifier };
}

describe('the relay Worker', () => {
  it('says how to connect, and refuses MCP without a grant', async () => {
    const home = await call('/');
    expect(home.status).toBe(200);
    expect(await home.text()).toContain(`${ORIGIN}/mcp`);
    const mcp = await call('/mcp', {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });
    expect(mcp.status).toBe(401);
    await mcp.body?.cancel();
    const metadata = await call('/.well-known/oauth-authorization-server');
    expect(await metadata.json()).toMatchObject({
      authorization_endpoint: `${ORIGIN}/authorize`,
      token_endpoint: `${ORIGIN}/token`,
      registration_endpoint: `${ORIGIN}/register`,
    });
  });

  it('signs in the allowed account and reaches MCP with the token', async () => {
    const { back, clientId, verifier } = await signIn('HtxRyan');
    expect(back.status).toBe(302);
    const toClaude = new URL(back.headers.get('location')!);
    expect(toClaude.origin + toClaude.pathname).toBe(CLAUDE_CALLBACK);
    expect(toClaude.searchParams.get('state')).toBe('claude-state');
    const token = await call('/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: toClaude.searchParams.get('code')!,
        redirect_uri: CLAUDE_CALLBACK,
        client_id: clientId,
        code_verifier: verifier,
      }).toString(),
    });
    expect(token.status).toBe(200);
    const { access_token } = await token.json<{ access_token: string }>();
    const ping = await call('/mcp', {
      method: 'POST',
      headers: { authorization: `Bearer ${access_token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'ping' }),
    });
    expect(ping.status).toBe(200);
    expect(await ping.json()).toEqual({ jsonrpc: '2.0', id: 7, result: {} });
  });

  it('refuses another GitHub account', async () => {
    const { back } = await signIn('someone-else');
    expect(back.status).toBe(403);
    expect(await back.text()).toContain('serves only htxryan');
  });

  it('refuses a connector whose grant would go to another host', async () => {
    const clientId = await register('https://evil.example/callback');
    const { path } = await authorizeUrl(clientId, 'https://evil.example/callback');
    const response = await call(path);
    expect(response.status).toBe(403);
    expect(await response.text()).toContain('connects only to claude.ai');
  });

  it('refuses a callback from another browser (no state cookie)', async () => {
    const clientId = await register();
    const { path } = await authorizeUrl(clientId);
    const html = await (await call(path)).text();
    const pending = /name="pending" value="([0-9a-f]+)"/.exec(html)![1]!;
    const toGitHub = await call('/authorize', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ pending }).toString(),
    });
    const state = new URL(toGitHub.headers.get('location')!).searchParams.get('state')!;
    const back = await call(`/callback?code=c&state=${state}`);
    expect(back.status).toBe(400);
    await back.body?.cancel();
  });
});

describe('the copy in SQLite', () => {
  it('keeps a value larger than a row in parts, and rolls back a failed transaction', async () => {
    const stub = env.NOTEBOOK.get(env.NOTEBOOK.idFromName('storage-test'));
    await runInDurableObject(stub, (_instance, state) => {
      const blobs = new SqlBlobs(state.storage);
      const big = new Uint8Array(2_500_000).map((_, i) => i % 251);
      blobs.put('note:A', big);
      blobs.put('note:B', new Uint8Array(0));
      // Byte for byte, but not through toEqual: its deep walk of 2.5 million entries took ~5 s (#323).
      const back = blobs.get('note:A');
      expect(back).toBeInstanceOf(Uint8Array);
      expect(back?.byteLength).toBe(big.byteLength);
      expect(back?.findIndex((byte, i) => byte !== big[i])).toBe(-1);
      expect(blobs.get('note:B')).toEqual(new Uint8Array(0));
      expect(blobs.keys('note:')).toEqual(['note:A', 'note:B']);
      expect(() =>
        blobs.transaction(() => {
          blobs.put('note:C', new Uint8Array([1]));
          throw new Error('stop');
        }),
      ).toThrow('stop');
      expect(blobs.get('note:C')).toBeNull();
      blobs.delete('note:A');
      expect(blobs.keys('note:')).toEqual(['note:B']);
    });
  });
});
