/**
 * The Notebooks page (PEN-194, R2): the notebooks this relay serves, and the owner's ways to
 * change them. Add Notebook… is the app's own Add Notebook flow, unchanged (A1701): its page runs
 * `NotebookSteps` from apps/web, bundled into `add-flow.gen.ts`, over a bridge whose calls come
 * here (`/notebooks/add/call`) and are answered by `AddBridge` in the Mac bridge's shapes.
 * Remove… asks first, and pushes the notebook's unpushed edits before it goes. Replace Token…
 * takes a new token. A token shows only its last four characters. Only the owner, signed in,
 * reaches any of it.
 */
import { ADD_FLOW_JS } from './add-flow.gen';
import type { AppSummary } from './app';
import {
  buttonForm,
  escape,
  group,
  linkButton,
  page,
  para,
  problem as problemBox,
  row,
  type PageOptions,
} from './pages';
import { callIsOwn, formIsOwn, type Session } from './session';

/** A served notebook as the page shows it: nothing secret. */
export interface NotebookRow {
  readonly name: string;
  /** Its `notebook.json`'s id, once synced. */
  readonly id: string | null;
  /** Its place's key (`placeKey`), naming it in the page's forms. */
  readonly key: string;
  readonly repository: string;
  readonly branch: string;
  /** '' or `dir/`. */
  readonly root: string;
  readonly access: 'app' | 'token';
  /** A token's last four characters. */
  readonly tokenEnd: string | null;
  /** When it last synced (ms), or null for not yet. */
  readonly syncedAt: number | null;
  /** What went wrong with its last sync or push, in a sentence. */
  readonly problem: string | null;
}

type Answer<T> = T | { readonly problem: string };

export interface NotebooksStore {
  /** The repositories of the notebooks served, for claude.ai's consent page. */
  repositories(): Promise<readonly string[]>;
  notebooks(): Promise<readonly NotebookRow[]>;
  /** The relay's GitHub App, or null before setup. */
  summary(): Promise<AppSummary | null>;
  /** Where the App is installed on more repositories, or null without an App. */
  installUrl(): Promise<string | null>;
  /** One of Add Notebook's bridge calls (A1701), by name: its answer, or null. */
  addCall(name: string, args: readonly unknown[]): Promise<unknown>;
  remove(key: string): Promise<Answer<{ readonly name: string }>>;
  replaceToken(key: string, token: string): Promise<Answer<{ readonly name: string }>>;
}

/** Copies the connector's address (the page's one script, allowed by its hash). */
const COPY_SCRIPT =
  "document.querySelectorAll('[data-copy]').forEach(function(b){b.addEventListener('click',function(){navigator.clipboard.writeText(b.getAttribute('data-copy')).then(function(){b.textContent='Copied';setTimeout(function(){b.textContent='Copy'},1500)})})})";
let copyHash: Promise<string> | null = null;
const scriptHash = () =>
  (copyHash ??= crypto.subtle
    .digest('SHA-256', new TextEncoder().encode(COPY_SCRIPT))
    .then((digest) => `'sha256-${btoa(String.fromCharCode(...new Uint8Array(digest)))}'`));

const where = (each: Pick<NotebookRow, 'repository' | 'branch' | 'root'>) =>
  [escape(each.repository), escape(each.branch), ...(each.root ? [escape(each.root)] : [])].join(
    ' · ',
  );

/** “Synced 12 seconds ago”, from the time the page is made. */
export function syncedAgo(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  const say = (n: number, unit: string) => `Synced ${n} ${unit}${n === 1 ? '' : 's'} ago`;
  if (seconds < 60) return say(seconds, 'second');
  if (seconds < 3600) return say(Math.round(seconds / 60), 'minute');
  if (seconds < 86_400) return say(Math.round(seconds / 3600), 'hour');
  return say(Math.round(seconds / 86_400), 'day');
}

const signedIn = (session: Session) =>
  `Signed in as ${escape(session.login)} · ${buttonForm('/sign-out', 'Sign Out', { csrf: session.csrf }, { className: 'relay-link' })}`;

const ownPage = (
  session: Session,
  status: number,
  title: string,
  body: string,
  options: PageOptions = {},
) => page(status, title, body, { aside: signedIn(session), ...options });

const keyLink = (path: string, key: string) => `${path}?n=${encodeURIComponent(key)}`;

async function listPage(
  url: URL,
  session: Session,
  store: NotebooksStore,
  now: number,
): Promise<Response> {
  const listed = await store.notebooks();
  const rows = listed.length
    ? listed.map((each) => {
        const reached =
          each.access === 'app' ? 'GitHub App' : `Token ending ${escape(each.tokenEnd ?? '')}`;
        const state = each.problem
          ? `<span class="relay-state bad">${escape(each.problem)}</span>`
          : `<span class="relay-state">${each.syncedAt ? syncedAgo(each.syncedAt, now) : 'Not synced yet'}</span>`;
        const controls =
          (each.access === 'token'
            ? linkButton(keyLink('/notebooks/token', each.key), 'Replace Token…')
            : '') + linkButton(keyLink('/notebooks/remove', each.key), 'Remove…');
        return row(each.name, `${where(each)} · ${reached}`, controls, 'div', state);
      })
    : [row('No Notebooks Yet', 'Add a notebook, and Claude can use it once you connect.')];
  const address = `${url.origin}/mcp`;
  const added = url.searchParams.get('added');
  return ownPage(
    session,
    200,
    'Notebooks',
    (added
      ? `<p class="relay-notice t-body" role="status">Added ${escape(added)}. Claude can use it now.</p>`
      : '') +
      para(
        'Claude reaches these notebooks through this relay. In Claude, add a custom connector with the address below.',
      ) +
      group([
        row(
          'Connector Address',
          `<code>${escape(address)}</code>`,
          `<button type="button" class="btn" data-copy="${escape(address)}">Copy</button>`,
        ),
      ]) +
      group(rows) +
      `<div>${linkButton('/notebooks/add', 'Add Notebook…', true)}</div>` +
      `<script>${COPY_SCRIPT}</script>`,
    { scriptHash: await scriptHash() },
  );
}

const cancel = () => linkButton('/notebooks', 'Cancel');

/** Add Notebook… (A1701): the app's flow, mounted by its script, with the form token. */
async function addPage(session: Session, store: NotebooksStore): Promise<Response> {
  if (!(await store.summary())) {
    return ownPage(
      session,
      409,
      'This Relay Isn’t Set Up',
      para('It has no GitHub App yet.') + linkButton('/setup', 'Set Up This Relay', true),
    );
  }
  const start = JSON.stringify({ csrf: session.csrf, login: session.login }).replace(
    /</g,
    '\\u003c',
  );
  return page(
    200,
    'Add Notebook',
    `<main class="first-run" data-testid="add-notebook" data-flow="add" id="relay-add-root"><p class="fr-status" role="status">Opening Add Notebook…</p></main><script type="application/json" id="relay-add">${start}</script><script src="/notebooks/add/flow.js"></script>`,
    { app: true },
  );
}

/** One of the page's bridge calls: `{ name, args }` in, its answer (JSON) out. */
async function addCall(
  request: Request,
  session: Session,
  store: NotebooksStore,
): Promise<Response> {
  const json = (body: unknown, status = 200) =>
    Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
  if (!callIsOwn(request, session)) {
    return json({ refused: 'Open Add Notebook again and try once more.' }, 403);
  }
  const body = (await request.json().catch(() => null)) as {
    name?: unknown;
    args?: unknown;
  } | null;
  if (typeof body?.name !== 'string' || !Array.isArray(body.args)) {
    return json({ refused: 'That call isn’t one Add Notebook makes.' }, 400);
  }
  return json({ answer: await store.addCall(body.name, body.args) });
}

async function named(store: NotebooksStore, key: string | null): Promise<NotebookRow | null> {
  if (!key) return null;
  return (await store.notebooks()).find((each) => each.key === key) ?? null;
}

const missing = (session: Session) =>
  ownPage(
    session,
    404,
    'No Such Notebook',
    para('It may have been removed already.') + linkButton('/notebooks', 'Notebooks'),
  );

function removePage(
  session: Session,
  notebook: NotebookRow,
  status = 200,
  trouble: string | null = null,
): Response {
  return ownPage(
    session,
    status,
    `Remove “${notebook.name}”?`,
    (trouble ? problemBox(`“${notebook.name}” Wasn’t Removed`, escape(trouble)) : '') +
      para(
        `Its notes stay in <code>${escape(notebook.repository)}</code>. Claude no longer reaches them through this relay, and the relay’s copy is deleted. Edits Claude made that aren’t pushed yet are pushed first.`,
      ) +
      `<form method="post" action="${escape(keyLink('/notebooks/remove', notebook.key))}" class="relay-actions"><input type="hidden" name="csrf" value="${escape(session.csrf)}"><button type="submit" class="btn danger-fill">Remove Notebook</button>${cancel()}</form>`,
  );
}

function tokenPage(
  session: Session,
  notebook: NotebookRow,
  status = 200,
  trouble: string | null = null,
): Response {
  return ownPage(
    session,
    status,
    `Replace Token for “${notebook.name}”`,
    (trouble ? problemBox('This Token Wasn’t Saved', escape(trouble)) : '') +
      para(
        `The relay reaches <code>${escape(notebook.repository)}</code> with a token ending ${escape(notebook.tokenEnd ?? '')}. A new one needs Contents: Read and Write on this repository.`,
      ) +
      `<form method="post" action="${escape(keyLink('/notebooks/token', notebook.key))}" class="relay-form"><input type="hidden" name="csrf" value="${escape(session.csrf)}">` +
      group([
        row(
          'New Token',
          'Only its last four characters are shown again.',
          '<input class="input" type="password" name="token" autocomplete="off" required>',
        ),
      ]) +
      `<div class="relay-actions"><button type="submit" class="btn primary">Save Token</button>${cancel()}</div></form>`,
  );
}

const text = (form: FormData, name: string) => {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
};

/** The Notebooks page and its forms, for the signed-in owner; null for a path it doesn't serve. */
export async function notebooksRoute(
  request: Request,
  session: Session,
  store: NotebooksStore,
  now: number,
): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (path === '/notebooks/add/call' && request.method === 'POST') {
    return addCall(request, session, store);
  }
  if (request.method === 'GET') {
    if (path === '/notebooks') return listPage(url, session, store, now);
    if (path === '/notebooks/add') return addPage(session, store);
    if (path === '/notebooks/add/flow.js') {
      return new Response(ADD_FLOW_JS, {
        headers: {
          'content-type': 'text/javascript; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        },
      });
    }
    if (path === '/notebooks/remove' || path === '/notebooks/token') {
      const notebook = await named(store, url.searchParams.get('n'));
      if (!notebook) return missing(session);
      if (path === '/notebooks/remove') return removePage(session, notebook);
      if (notebook.access !== 'token') return missing(session);
      return tokenPage(session, notebook);
    }
    return null;
  }
  if (request.method !== 'POST') return null;
  if (!['/notebooks/remove', '/notebooks/token'].includes(path)) return null;
  const form = await request.formData();
  if (!formIsOwn(request, form, session)) {
    return ownPage(
      session,
      403,
      'This Form Isn’t From This Page',
      para('Open the page again and try once more.') + linkButton('/notebooks', 'Notebooks'),
    );
  }
  const done = () => new Response(null, { status: 303, headers: { location: '/notebooks' } });
  const notebook = await named(store, url.searchParams.get('n'));
  if (!notebook) return missing(session);
  if (path === '/notebooks/remove') {
    const removed = await store.remove(notebook.key);
    return 'problem' in removed ? removePage(session, notebook, 409, removed.problem) : done();
  }
  const replaced = await store.replaceToken(notebook.key, text(form, 'token').trim());
  return 'problem' in replaced ? tokenPage(session, notebook, 400, replaced.problem) : done();
}
