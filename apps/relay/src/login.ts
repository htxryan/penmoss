/**
 * Signing in to the relay (T55): the OAuth 2.1 server claude.ai's custom connectors expect is
 * `@cloudflare/workers-oauth-provider`; this handler is its sign-in. A connector's request is
 * granted only when its redirect goes to an allowed host (claude.ai by default) and the person
 * signs in with GitHub as the one allowed account. Anything else is refused with a page saying
 * why. The GitHub sign-in asks for no scopes: only who the person is.
 */
import type { AuthRequest, OAuthHelpers } from '@cloudflare/workers-oauth-provider';
import { readConfig, redirectAllowed, sameLogin, type RelaySettings } from './config';

export interface LoginEnv extends RelaySettings {
  readonly OAUTH_KV: KVNamespace;
  readonly OAUTH_PROVIDER: OAuthHelpers;
}

/** What a grant carries to the MCP endpoint. */
export interface GrantProps {
  readonly login: string;
}

const PENDING_TTL_S = 600;
const STATE_COOKIE = 'penmoss_relay_state';

const escape = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

export function page(status: number, title: string, body: string, headers: HeadersInit = {}) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)}</title>
<style>:root{color-scheme:light dark}body{font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;max-width:34rem;margin:12vh auto;padding:0 20px}h1{font-size:1.4rem}button{font:inherit;padding:.6em 1.2em;cursor:pointer}code{font-size:.9em}</style>
</head><body><h1>${escape(title)}</h1>${body}</body></html>`;
  return new Response(html, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy':
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://github.com",
      'x-frame-options': 'DENY',
      ...headers,
    },
  });
}

const randomId = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');

function cookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return value.join('=');
  }
  return null;
}

export const loginHandler = {
  async fetch(request: Request, env: LoginEnv): Promise<Response> {
    const url = new URL(request.url);
    const config = readConfig(env);
    if (url.pathname === '/') {
      return page(
        200,
        'Penmoss relay',
        `<p>This relay serves a Penmoss notebook to claude.ai. Add <code>${escape(url.origin)}/mcp</code> as a custom connector in claude.ai's settings.</p>`,
      );
    }
    if ('problem' in config)
      return page(503, 'The relay is not set up', `<p>${escape(config.problem)}</p>`);

    if (url.pathname === '/authorize' && request.method === 'GET') {
      let auth: AuthRequest;
      try {
        auth = await env.OAUTH_PROVIDER.parseAuthRequest(request);
      } catch (error) {
        return page(400, 'Not a sign-in request', `<p>${escape(String(error))}</p>`);
      }
      const client = await env.OAUTH_PROVIDER.lookupClient(auth.clientId);
      if (!client)
        return page(400, 'Unknown app', '<p>This app is not registered with the relay.</p>');
      if (!redirectAllowed(auth.redirectUri, config.redirectHosts)) {
        return page(
          403,
          'This app cannot connect',
          `<p>The relay connects only to ${escape(config.redirectHosts.join(', '))}. This request would send access to <code>${escape(auth.redirectUri)}</code>.</p>`,
        );
      }
      const id = randomId();
      await env.OAUTH_KV.put(`pending:${id}`, JSON.stringify(auth), {
        expirationTtl: PENDING_TTL_S,
      });
      const name = client.clientName ?? new URL(auth.redirectUri).hostname;
      // A browser applies form-action to every redirect the form leads to. When GitHub has
      // already authorized the app it redirects straight back, so the chain runs form → GitHub →
      // /callback → claude.ai without a new navigation, and the last hop must be allowed too.
      const formAction = [
        "'self'",
        config.web,
        ...config.redirectHosts.flatMap((host) => [`https://${host}`, `https://*.${host}`]),
      ].join(' ');
      return page(
        200,
        `Connect ${name} to your notes?`,
        `<p><b>${escape(name)}</b> (${escape(new URL(auth.redirectUri).hostname)}) will be able to read, create and edit notes in <code>${escape(config.repository)}</code>. Its edits are committed as the agent “${escape(config.agentLabel)}”.</p>
<form method="post" action="/authorize"><input type="hidden" name="pending" value="${id}"><button type="submit">Continue with GitHub</button></form>`,
        {
          'content-security-policy': `default-src 'none'; style-src 'unsafe-inline'; form-action ${formAction}`,
        },
      );
    }

    if (url.pathname === '/authorize' && request.method === 'POST') {
      const form = await request.formData();
      const given = form.get('pending');
      const pending = typeof given === 'string' ? given : '';
      const auth = /^[0-9a-f]{48}$/.test(pending)
        ? await env.OAUTH_KV.get(`pending:${pending}`)
        : null;
      if (!auth) return page(400, 'This sign-in expired', '<p>Start again from claude.ai.</p>');
      await env.OAUTH_KV.delete(`pending:${pending}`);
      const state = randomId();
      await env.OAUTH_KV.put(`state:${state}`, auth, { expirationTtl: PENDING_TTL_S });
      const github = new URL(`${config.web}/login/oauth/authorize`);
      github.searchParams.set('client_id', env.GITHUB_CLIENT_ID ?? '');
      github.searchParams.set('redirect_uri', `${url.origin}/callback`);
      github.searchParams.set('state', state);
      github.searchParams.set('allow_signup', 'false');
      return new Response(null, {
        status: 302,
        headers: {
          location: github.toString(),
          // The state is this browser's: a sign-in started elsewhere cannot finish here.
          'set-cookie': `${STATE_COOKIE}=${state}; HttpOnly; Secure; SameSite=Lax; Path=/callback; Max-Age=${PENDING_TTL_S}`,
        },
      });
    }

    if (url.pathname === '/callback' && request.method === 'GET') {
      const state = url.searchParams.get('state') ?? '';
      const code = url.searchParams.get('code') ?? '';
      const stored = /^[0-9a-f]{48}$/.test(state) ? await env.OAUTH_KV.get(`state:${state}`) : null;
      if (!stored || !code || cookie(request, STATE_COOKIE) !== state) {
        return page(400, 'This sign-in expired', '<p>Start again from claude.ai.</p>');
      }
      await env.OAUTH_KV.delete(`state:${state}`);
      const exchange = await fetch(`${config.web}/login/oauth/access_token`, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'user-agent': 'penmoss-relay',
        },
        body: JSON.stringify({
          client_id: env.GITHUB_CLIENT_ID,
          client_secret: env.GITHUB_CLIENT_SECRET,
          code,
          redirect_uri: `${url.origin}/callback`,
        }),
      });
      const token = ((await exchange.json().catch(() => ({}))) as { access_token?: string })
        .access_token;
      if (!token)
        return page(502, 'GitHub did not sign you in', '<p>Start again from claude.ai.</p>');
      const user = await fetch(`${config.api}/user`, {
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/vnd.github+json',
          'user-agent': 'penmoss-relay',
        },
      });
      const login = ((await user.json().catch(() => ({}))) as { login?: string }).login;
      if (!sameLogin(login, config.allowedLogin)) {
        return page(
          403,
          'This relay is not yours',
          `<p>You signed in to GitHub as <b>${escape(login ?? 'unknown')}</b>. This relay serves only ${escape(config.allowedLogin)}.</p>`,
        );
      }
      const auth = JSON.parse(stored) as AuthRequest;
      const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
        request: auth,
        userId: config.allowedLogin.toLowerCase(),
        metadata: { login },
        scope: auth.scope,
        props: { login: login! } satisfies GrantProps,
      });
      return new Response(null, {
        status: 302,
        headers: {
          location: redirectTo,
          'set-cookie': `${STATE_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/callback; Max-Age=0`,
        },
      });
    }

    return page(404, 'Not found', '<p>Nothing here.</p>');
  },
};
