/**
 * The relay's pages and sign-in (T55, PEN-193). claude.ai's custom connectors expect an OAuth 2.1
 * server, which is `@cloudflare/workers-oauth-provider`; this handler is everything else it
 * serves:
 *
 * - `/setup` makes the relay's GitHub App (setup.ts); nothing else works before it.
 * - claude.ai's sign-in (`/authorize`): granted only when the connector's redirect goes to an
 *   allowed host (claude.ai by default) and the person signs in with GitHub as the owner.
 * - The owner's own pages (`/sign-in`, `/notebooks`, `/sign-out`), with a session (session.ts).
 *
 * Both sign-ins go through the stored App's web flow and come back to `/callback`. They ask for no
 * scopes: only who the person is. Anything refused gets a page saying why.
 */
import type { AuthRequest, OAuthHelpers } from '@cloudflare/workers-oauth-provider';
import type { AppSummary, StoredApp } from './app';
import {
  readBasics,
  redirectAllowed,
  sameLogin,
  type RelayBasics,
  type RelaySettings,
} from './config';
import { notebooksRoute, type NotebooksStore } from './notebooks';
import { buttonForm, escape, linkButton, page, para } from './pages';
import {
  clearSessionCookie,
  cookie,
  endSession,
  formIsOwn,
  randomId,
  readSession,
  sessionCookie,
  setCookie,
  startSession,
} from './session';
import { setupPage } from './setup';
import { tokenAnswer, type OwnerToken } from './add-bridge';

/** What the Worker asks of the relay's Durable Object. */
export interface RelayStore extends NotebooksStore {
  keepOwnerToken(token: OwnerToken): Promise<void>;
  summary(): Promise<AppSummary | null>;
  /** The App's client id and secret, for a sign-in; null before setup. */
  signIn(): Promise<{ readonly clientId: string; readonly clientSecret: string } | null>;
  keepApp(app: StoredApp): Promise<'kept' | 'exists'>;
}

export interface LoginEnv extends RelaySettings {
  readonly OAUTH_KV: KVNamespace;
  readonly OAUTH_PROVIDER: OAuthHelpers;
  readonly NOTEBOOK: DurableObjectNamespace;
}

/** What a grant carries to the MCP endpoint. */
export interface GrantProps {
  readonly login: string;
}

const PENDING_TTL_S = 600;
const STATE_COOKIE = 'penmoss_relay_state';
const ID = /^[0-9a-f]{48}$/;

/** The one Durable Object: the notebooks, and the relay's settings. */
export const storeOf = (env: LoginEnv) =>
  env.NOTEBOOK.get(env.NOTEBOOK.idFromName('notebook')) as unknown as RelayStore;

/** Where a sign-in started: claude.ai's grant, or the owner's pages. */
type Started = { readonly kind: 'grant'; readonly auth: AuthRequest } | { readonly kind: 'pages' };

const notSetUp = () =>
  page(
    503,
    'This Relay Isn’t Set Up',
    para('It needs its GitHub App before anyone can connect.') +
      linkButton('/setup', 'Set Up This Relay', true),
  );

const notTheOwner = (basics: RelayBasics, login: string | undefined) =>
  page(
    403,
    'This Relay Isn’t Yours',
    para(
      `You signed in to GitHub as <b>${escape(login ?? 'unknown')}</b>. This relay belongs to ${escape(basics.owner)}. Sign in as ${escape(basics.owner)}, or deploy a relay of your own.`,
    ),
  );

/** Sends the browser to GitHub's sign-in, the state kept in KV and in this browser's cookie. */
async function toGitHub(
  env: LoginEnv,
  basics: RelayBasics,
  origin: string,
  clientId: string,
  started: Started,
): Promise<Response> {
  const state = randomId();
  await env.OAUTH_KV.put(`state:${state}`, JSON.stringify(started), {
    expirationTtl: PENDING_TTL_S,
  });
  const github = new URL(`${basics.web}/login/oauth/authorize`);
  github.searchParams.set('client_id', clientId);
  github.searchParams.set('redirect_uri', `${origin}/callback`);
  github.searchParams.set('state', state);
  github.searchParams.set('allow_signup', 'false');
  return new Response(null, {
    status: 302,
    headers: {
      location: github.toString(),
      // The state is this browser's: a sign-in started elsewhere cannot finish here.
      'set-cookie': setCookie(STATE_COOKIE, state, '/callback', PENDING_TTL_S),
    },
  });
}

export const loginHandler = {
  async fetch(request: Request, env: LoginEnv): Promise<Response> {
    const url = new URL(request.url);
    const basics = readBasics(env);
    if ('problem' in basics) {
      return page(503, 'This Relay Isn’t Set Up', para(escape(basics.problem)));
    }
    const store = storeOf(env);

    if (url.pathname === '/') {
      const app = await store.summary();
      return page(
        200,
        'Penmoss Relay',
        para(
          `This relay lets Claude read and write ${escape(basics.owner)}’s Penmoss notebooks. In Claude, add <code>${escape(url.origin)}/mcp</code> as a custom connector.`,
        ) +
          (app
            ? linkButton('/notebooks', 'Notebooks', true)
            : linkButton('/setup', 'Set Up This Relay', true)),
      );
    }

    if (url.pathname === '/setup' && request.method === 'GET') {
      return setupPage(request, basics, store, env.OAUTH_KV);
    }

    if (url.pathname === '/authorize' && request.method === 'GET') {
      const signIn = await store.signIn();
      if (!signIn) return notSetUp();
      let auth: AuthRequest;
      try {
        auth = await env.OAUTH_PROVIDER.parseAuthRequest(request);
      } catch (error) {
        return page(400, 'Not a Sign-In Request', para(escape(String(error))));
      }
      const client = await env.OAUTH_PROVIDER.lookupClient(auth.clientId);
      if (!client)
        return page(400, 'Unknown App', para('This app is not registered with the relay.'));
      if (!redirectAllowed(auth.redirectUri, basics.redirectHosts)) {
        return page(
          403,
          'This App Can’t Connect',
          para(
            `The relay connects only to ${escape(basics.redirectHosts.join(', '))}. This request would send access to <code>${escape(auth.redirectUri)}</code>.`,
          ),
        );
      }
      const id = randomId();
      await env.OAUTH_KV.put(`pending:${id}`, JSON.stringify(auth), {
        expirationTtl: PENDING_TTL_S,
      });
      const name = client.clientName ?? new URL(auth.redirectUri).hostname;
      const repositories = await store.repositories();
      // A browser applies form-action to every redirect the form leads to. When GitHub has
      // already authorized the app it redirects straight back, so the chain runs form → GitHub →
      // /callback → claude.ai without a new navigation, and the last hop must be allowed too.
      const formAction = [
        basics.web,
        ...basics.redirectHosts.flatMap((host) => [`https://${host}`, `https://*.${host}`]),
      ];
      const where = repositories.length
        ? repositories.map((repository) => `<code>${escape(repository)}</code>`).join(', ')
        : 'the notebooks this relay serves';
      return page(
        200,
        `Connect ${name} to Your Notes?`,
        para(
          `<b>${escape(name)}</b> (${escape(new URL(auth.redirectUri).hostname)}) will be able to read, create and edit notes in ${where}. Its edits are committed as the agent “${escape(basics.agentLabel)}”.`,
        ) + buttonForm('/authorize', 'Continue with GitHub', { pending: id }, { primary: true }),
        { formAction },
      );
    }

    if (url.pathname === '/authorize' && request.method === 'POST') {
      const signIn = await store.signIn();
      if (!signIn) return notSetUp();
      const form = await request.formData();
      const given = form.get('pending');
      const pending = typeof given === 'string' ? given : '';
      const auth = ID.test(pending) ? await env.OAUTH_KV.get(`pending:${pending}`) : null;
      if (!auth) return page(400, 'This Sign-In Expired', para('Start again from Claude.'));
      await env.OAUTH_KV.delete(`pending:${pending}`);
      return toGitHub(env, basics, url.origin, signIn.clientId, {
        kind: 'grant',
        auth: JSON.parse(auth) as AuthRequest,
      });
    }

    if (url.pathname === '/sign-in' && request.method === 'GET') {
      const signIn = await store.signIn();
      if (!signIn) return notSetUp();
      return toGitHub(env, basics, url.origin, signIn.clientId, { kind: 'pages' });
    }

    if (url.pathname === '/callback' && request.method === 'GET') {
      const signIn = await store.signIn();
      if (!signIn) return notSetUp();
      const state = url.searchParams.get('state') ?? '';
      const code = url.searchParams.get('code') ?? '';
      const stored = ID.test(state) ? await env.OAUTH_KV.get(`state:${state}`) : null;
      if (!stored || !code || cookie(request, STATE_COOKIE) !== state) {
        return page(
          400,
          'This Sign-In Expired',
          para('Start again from Claude, or from this relay’s page.'),
        );
      }
      await env.OAUTH_KV.delete(`state:${state}`);
      const started = JSON.parse(stored) as Started;
      const exchange = await fetch(`${basics.web}/login/oauth/access_token`, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'user-agent': 'penmoss-relay',
        },
        body: JSON.stringify({
          client_id: signIn.clientId,
          client_secret: signIn.clientSecret,
          code,
          redirect_uri: `${url.origin}/callback`,
        }),
      });
      const answer = tokenAnswer(await exchange.json().catch(() => ({})), Date.now());
      const token = answer?.token;
      if (!token) return page(502, 'GitHub Didn’t Sign You In', para('Start again in a moment.'));
      const user = await fetch(`${basics.api}/user`, {
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/vnd.github+json',
          'user-agent': 'penmoss-relay',
        },
      });
      const login = ((await user.json().catch(() => ({}))) as { login?: string }).login;
      const clearState = setCookie(STATE_COOKIE, '', '/callback', 0);
      if (!sameLogin(login, basics.owner)) return notTheOwner(basics, login);
      if (started.kind === 'pages') {
        // Kept for Add Notebook's Create New Repo, made as the owner (A1701).
        await store.keepOwnerToken(answer);
        const session = await startSession(env.OAUTH_KV, login!);
        const headers = new Headers({ location: '/notebooks' });
        headers.append('set-cookie', clearState);
        headers.append('set-cookie', sessionCookie(session));
        return new Response(null, { status: 302, headers });
      }
      const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
        request: started.auth,
        userId: basics.owner.toLowerCase(),
        metadata: { login },
        scope: started.auth.scope,
        props: { login: login! } satisfies GrantProps,
      });
      return new Response(null, {
        status: 302,
        headers: { location: redirectTo, 'set-cookie': clearState },
      });
    }

    if (url.pathname === '/sign-out' || url.pathname.startsWith('/notebooks')) {
      if (!(await store.summary())) return notSetUp();
      const session = await readSession(env.OAUTH_KV, request);
      if (!session || !sameLogin(session.login, basics.owner)) {
        if (request.method !== 'GET') {
          return page(
            403,
            'Sign In First',
            para('Your session ended.') + linkButton('/notebooks', 'Notebooks'),
          );
        }
        return page(
          200,
          'Penmoss Relay',
          para(`Sign in as ${escape(basics.owner)} to manage the notebooks this relay serves.`) +
            linkButton('/sign-in', 'Sign In with GitHub', true),
        );
      }
      if (url.pathname === '/sign-out' && request.method === 'POST') {
        const form = await request.formData();
        if (!formIsOwn(request, form, session)) {
          return page(
            403,
            'This Form Isn’t From This Page',
            para('Open the page again and try once more.') + linkButton('/notebooks', 'Notebooks'),
          );
        }
        await endSession(env.OAUTH_KV, session);
        return new Response(null, {
          status: 303,
          headers: { location: '/notebooks', 'set-cookie': clearSessionCookie() },
        });
      }
      const answered = await notebooksRoute(request, session, store, Date.now());
      if (answered) return answered;
    }

    return page(404, 'Not Found', para('Nothing here.'));
  },
};
