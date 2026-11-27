/**
 * Setting up a relay (PEN-193, R7): `/setup` makes the relay's GitHub App from a manifest. The
 * page posts the manifest to GitHub with a one-time `state` (in KV and in this browser's cookie);
 * GitHub sends the person back with a code, which the relay converts into the App's id, key and
 * secrets. The App is kept only when GitHub says the owner made it, and only once: a relay that
 * has its App shows what is done and can't make a second one.
 */
import { manifest, type AppSummary, type StoredApp } from './app';
import { sameLogin, type RelayBasics } from './config';
import { escape, group, linkButton, page, para, problem, row } from './pages';
import { cookie, randomId, setCookie } from './session';

/** How the setup page reaches the relay's storage. */
export interface SetupStore {
  summary(): Promise<AppSummary | null>;
  keepApp(app: StoredApp): Promise<'kept' | 'exists'>;
}

const SETUP_COOKIE = 'penmoss_relay_setup';
/** GitHub's manifest code lasts an hour; the state as long. */
const SETUP_TTL_S = 60 * 60;
const ID = /^[0-9a-f]{48}$/;

const owned = (basics: RelayBasics) => `Owner: ${escape(basics.owner)}`;

/** The page with each step, done or to do. */
function steps(app: AppSummary | null, create: string) {
  const made = app
    ? row(
        'Create the GitHub App',
        `${escape(app.name)}, made on ${escape(app.owner)}.`,
        '<span class="relay-done">Done</span>',
        'li',
      )
    : row(
        'Create the GitHub App',
        'GitHub opens with the App filled in: read and write access to contents, and to make repositories for Add Notebook’s Create New Repo. Create it there and you come back here.',
        create,
        'li',
      );
  const install = row(
    'Install It on Your Notebooks',
    'Choose the repositories that hold your notebooks. A notebook in an organisation that won’t allow the App can use a token of its own instead.',
    app
      ? linkButton(`${app.htmlUrl}/installations/new`, 'Install on GitHub…', true)
      : '<button type="button" class="btn" disabled>Install on GitHub…</button>',
    'li',
  );
  const add = row(
    'Add Your Notebooks',
    'Sign in, then add each notebook Claude may use.',
    app
      ? linkButton('/notebooks', 'Sign In with GitHub')
      : '<button type="button" class="btn" disabled>Sign In with GitHub</button>',
    'li',
  );
  return group([made, install, add], true);
}

export async function setupPage(
  request: Request,
  basics: RelayBasics,
  store: SetupStore,
  kv: KVNamespace,
): Promise<Response> {
  const url = new URL(request.url);
  const app = await store.summary();
  const code = url.searchParams.get('code');
  if (code !== null) return finish(request, basics, store, kv, app, code);
  if (app) {
    return page(
      200,
      'Set Up This Relay',
      para(
        'This relay has its GitHub App. Install it on your notebooks’ repositories, then add them.',
      ) + steps(app, ''),
      { aside: owned(basics) },
    );
  }
  const state = randomId();
  await kv.put(`setup:${state}`, '1', { expirationTtl: SETUP_TTL_S });
  const action = `${basics.web}/settings/apps/new?state=${state}`;
  const create = `<form method="post" action="${escape(action)}"><input type="hidden" name="manifest" value="${escape(JSON.stringify(manifest(url.origin, basics.owner)))}"><button type="submit" class="btn primary">Create GitHub App…</button></form>`;
  return page(
    200,
    'Set Up This Relay',
    para(
      'This relay lets Claude read and write your Penmoss notebooks. It needs a GitHub App of its own, made on your account in a few clicks.',
    ) +
      steps(null, create) +
      `<p class="relay-who">Only ${escape(basics.owner)} can finish setup: an App made by any other account is refused.</p>`,
    {
      aside: owned(basics),
      formAction: [basics.web],
      headers: { 'set-cookie': setCookie(SETUP_COOKIE, state, '/setup', SETUP_TTL_S) },
    },
  );
}

const again = (basics: RelayBasics) =>
  linkButton('/setup', 'Start Again') +
  ` <span class="relay-who">Owner: ${escape(basics.owner)}</span>`;

async function finish(
  request: Request,
  basics: RelayBasics,
  store: SetupStore,
  kv: KVNamespace,
  app: AppSummary | null,
  code: string,
): Promise<Response> {
  const clear = { 'set-cookie': setCookie(SETUP_COOKIE, '', '/setup', 0) };
  if (app) {
    return page(
      409,
      'This Relay Is Set Up',
      para(
        `It has its GitHub App, ${escape(app.name)}, already, and a relay keeps one. Delete the App you just made on GitHub, under Settings › Developer Settings › GitHub Apps.`,
      ) + linkButton('/setup', 'See Setup'),
      { headers: clear },
    );
  }
  const state = new URL(request.url).searchParams.get('state') ?? '';
  const known = ID.test(state) ? await kv.get(`setup:${state}`) : null;
  if (!known || cookie(request, SETUP_COOKIE) !== state || !/^[0-9a-zA-Z_-]{1,100}$/.test(code)) {
    return page(
      400,
      'This Setup Expired',
      para(
        'It was started in another browser, or more than an hour ago. Start again from this relay.',
      ) + again(basics),
      { headers: clear },
    );
  }
  await kv.delete(`setup:${state}`);
  const response = await fetch(`${basics.api}/app-manifests/${code}/conversions`, {
    method: 'POST',
    headers: {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'penmoss-relay',
    },
  });
  if (response.status !== 201) {
    await response.body?.cancel();
    return page(
      response.status === 404 || response.status === 422 ? 400 : 502,
      'GitHub Didn’t Finish the App',
      para(
        response.status === 404 || response.status === 422
          ? 'GitHub’s code for it has expired or was used already. Start again from this relay.'
          : `GitHub answered ${response.status}. Start again in a moment.`,
      ) + again(basics),
      { headers: clear },
    );
  }
  const made = await response.json<{
    id: number;
    slug: string;
    name: string;
    owner?: { login?: string };
    html_url: string;
    client_id: string;
    client_secret: string;
    pem: string;
  }>();
  const maker = made.owner?.login ?? 'another account';
  if (!sameLogin(made.owner?.login, basics.owner)) {
    return page(
      403,
      'This App Isn’t the Owner’s',
      problem(
        `It was made by ${maker}`,
        `This relay belongs to ${escape(basics.owner)}, so it keeps only an App made on ${escape(basics.owner)}’s account. Nothing was kept. Delete ${escape(made.name)} on GitHub, sign in to GitHub as ${escape(basics.owner)}, and start again.`,
      ) + again(basics),
      { headers: clear },
    );
  }
  const kept = await store.keepApp({
    id: made.id,
    slug: made.slug,
    name: made.name,
    owner: maker,
    htmlUrl: made.html_url,
    clientId: made.client_id,
    clientSecret: made.client_secret,
    pem: made.pem,
  });
  if (kept === 'exists') return finish(request, basics, store, kv, await store.summary(), code);
  return new Response(null, { status: 303, headers: { location: '/setup', ...clear } });
}
