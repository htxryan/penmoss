/**
 * The Notebooks page (PEN-194, R2): the notebooks this relay serves, and the owner's ways to
 * change them. Add Notebook… is the app's flow (A1164): pick a repository the App reaches, or
 * paste a token and pick one it reaches; the relay then finds the notebooks on the repository's
 * branches, and one choice adds it. Nothing is typed but a token. Remove… asks first, and
 * pushes the notebook's unpushed edits before it goes. Replace Token… takes a new token. A token
 * shows only its last four characters. Only the owner, signed in, reaches any of it.
 */
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
import { formIsOwn, type Session } from './session';

/** A served notebook as the page shows it: nothing secret. */
export interface NotebookRow {
  readonly name: string;
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

/** A repository Add Notebook… offers. */
export interface RepoChoice {
  /** `owner/name`. */
  readonly fullName: string;
  /** Null when GitHub didn't say (the App's list). */
  readonly private: boolean | null;
}

/** A notebook found in a repository: where it is, and whether the relay serves it already. */
export interface FoundNotebook {
  readonly name: string;
  readonly branch: string;
  /** '' for the repository's root, else `dir/sub` (no slashes at the ends). */
  readonly folder: string;
  readonly served: boolean;
}

export interface NotebooksStore {
  /** The repositories of the notebooks served, for claude.ai's consent page. */
  repositories(): Promise<readonly string[]>;
  notebooks(): Promise<readonly NotebookRow[]>;
  /** Where the App is installed on more repositories, or null without an App. */
  installUrl(): Promise<string | null>;
  /** A pasted token, checked and kept for the next steps as `pending`. */
  startToken(token: string): Promise<Answer<{ readonly pending: string }>>;
  /** The repositories to pick from: the App's (`pending` null), or the token's. */
  repoChoices(
    pending: string | null,
  ): Promise<Answer<{ readonly repos: readonly RepoChoice[]; readonly more: boolean }>>;
  /** The notebooks in a repository, on `branch` or on its first branches. */
  notebooksIn(
    pending: string | null,
    repository: string,
    branch: string | null,
  ): Promise<
    Answer<{
      readonly repository: string;
      readonly branches: readonly string[];
      readonly looked: readonly string[];
      readonly found: readonly FoundNotebook[];
    }>
  >;
  /** The notebook at that place added, by its name. */
  finishAdd(
    pending: string | null,
    repository: string,
    branch: string,
    folder: string,
  ): Promise<Answer<{ readonly name: string }>>;
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
  return ownPage(
    session,
    200,
    'Notebooks',
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

/** Where a notebook is in its repository, as the app's cards say it (first-run-flow.ts). */
const folderWords = (folder: string) => (folder ? `${folder}/` : 'Root');

/** An Add Notebook… address, carrying the pending token when there is one. */
function addLink(
  path: string,
  query: { readonly p?: string | null; readonly r?: string; readonly b?: string },
) {
  const params = new URLSearchParams();
  if (query.p) params.set('p', query.p);
  if (query.r) params.set('r', query.r);
  if (query.b) params.set('b', query.b);
  const search = params.toString();
  return search ? `${path}?${search}` : path;
}

const trouble = (title: string, text: string | null) =>
  text ? problemBox(title, escape(text)) : '';

const repoRows = (repos: readonly RepoChoice[], pending: string | null, empty: string[]) =>
  repos.length
    ? repos.map((repo) =>
        row(
          repo.fullName,
          repo.private === null ? 'GitHub App' : repo.private ? 'Private' : 'Public',
          linkButton(
            addLink('/notebooks/add/repo', { p: pending, r: repo.fullName }),
            'Choose',
            true,
          ),
        ),
      )
    : [row(empty[0]!, empty[1]!)];

/** Step one: the App's repositories to pick from, or a token to paste. */
async function addPage(
  session: Session,
  store: NotebooksStore,
  status = 200,
  problemText: string | null = null,
): Promise<Response> {
  const [choices, install] = await Promise.all([store.repoChoices(null), store.installUrl()]);
  const repos = 'problem' in choices ? [] : choices.repos;
  return ownPage(
    session,
    status,
    'Add Notebook',
    trouble('This Token Can’t Be Used', problemText) +
      para('Choose the repository that holds the notebook. The relay finds the notebooks in it.') +
      group(
        repoRows(repos, null, [
          'The App Reaches No Repositories',
          'Install it on the repositories that hold your notebooks.',
        ]),
      ) +
      (install
        ? `<div class="relay-actions">${linkButton(install, 'Install on More Repositories…')}</div>`
        : '') +
      para(
        'A repository the App can’t be installed on, such as an organisation’s, is reached with a fine-grained token that has Contents: Read and Write on it.',
      ) +
      `<form method="post" action="/notebooks/add/token" class="relay-form"><input type="hidden" name="csrf" value="${escape(session.csrf)}">` +
      group([
        row(
          'Token',
          'Kept by the relay; only its last four characters are shown again.',
          '<input class="input" type="password" name="token" autocomplete="off" required>',
        ),
      ]) +
      `<div class="relay-actions"><button type="submit" class="btn">Show Its Repositories</button>${cancel()}</div></form>`,
  );
}

/** Step one, by a token: the repositories it can write to. */
async function tokenReposPage(
  session: Session,
  store: NotebooksStore,
  pending: string,
): Promise<Response> {
  const choices = await store.repoChoices(pending);
  if ('problem' in choices) return addPage(session, store, 400, choices.problem);
  return ownPage(
    session,
    200,
    'Add Notebook',
    para(
      'Choose the repository that holds the notebook. These are the ones the token can write to.',
    ) +
      group(
        repoRows(choices.repos, pending, [
          'This Token Can’t Write to Any Repository',
          'Give it Contents: Read and Write on the notebook’s repository, then paste it again.',
        ]),
      ) +
      `<div class="relay-actions">${linkButton('/notebooks/add', 'Back')}${cancel()}</div>`,
  );
}

/** Step two: the notebooks in the chosen repository, each added with one choice. */
async function repoPage(
  session: Session,
  store: NotebooksStore,
  pending: string | null,
  repository: string,
  branch: string | null,
  status = 200,
  problemText: string | null = null,
): Promise<Response> {
  const back = pending ? addLink('/notebooks/add/token', { p: pending }) : '/notebooks/add';
  const read = await store.notebooksIn(pending, repository, branch);
  if ('problem' in read) {
    return ownPage(
      session,
      400,
      'Add Notebook',
      trouble('This Repository Can’t Be Read', read.problem) +
        `<div class="relay-actions">${linkButton(back, 'Back', true)}${cancel()}</div>`,
    );
  }
  const fields = (each: FoundNotebook): Record<string, string> => ({
    csrf: session.csrf,
    ...(pending ? { p: pending } : {}),
    r: read.repository,
    b: each.branch,
    f: each.folder,
  });
  const rows = read.found.length
    ? read.found.map((each) =>
        row(
          each.name,
          `${escape(each.branch)} · ${escape(folderWords(each.folder))}`,
          each.served
            ? '<span class="relay-state">Added</span>'
            : buttonForm('/notebooks/add/finish', 'Add', fields(each), { primary: true }),
        ),
      )
    : [
        row(
          'No Notebooks Found',
          `None on ${read.looked.map((each) => `<code>${escape(each)}</code>`).join(', ')}. A notebook made in Penmoss has a <code>.penmoss/notebook.json</code> once it syncs.`,
        ),
      ];
  const others = read.branches.filter((each) => !(branch === null && read.looked.includes(each)));
  const branchForm =
    others.length > 0 && read.branches.length > 1
      ? `<form method="get" action="/notebooks/add/repo" class="relay-form">${pending ? `<input type="hidden" name="p" value="${escape(pending)}">` : ''}<input type="hidden" name="r" value="${escape(read.repository)}">` +
        group([
          row(
            'Another Branch',
            branch === null
              ? `Notebooks on ${read.looked.length === read.branches.length ? 'every branch' : `its first ${read.looked.length} branches`} are shown.`
              : `Notebooks on <code>${escape(branch)}</code> are shown.`,
            `<select class="pm-select" name="b">${read.branches.map((each) => `<option value="${escape(each)}"${each === branch ? ' selected' : ''}>${escape(each)}</option>`).join('')}</select>`,
          ),
        ]) +
        `<div class="relay-actions"><button type="submit" class="btn">Look There</button></div></form>`
      : '';
  return ownPage(
    session,
    status,
    'Add Notebook',
    trouble('This Notebook Can’t Be Added', problemText) +
      para(`The notebooks in <code>${escape(read.repository)}</code>.`) +
      group(rows) +
      branchForm +
      `<div class="relay-actions">${linkButton(back, 'Back')}${cancel()}</div>`,
  );
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
  if (request.method === 'GET') {
    if (path === '/notebooks') return listPage(url, session, store, now);
    if (path === '/notebooks/add') return addPage(session, store);
    const pending = url.searchParams.get('p');
    if (path === '/notebooks/add/token' && pending) return tokenReposPage(session, store, pending);
    if (path === '/notebooks/add/repo') {
      return repoPage(
        session,
        store,
        pending,
        url.searchParams.get('r') ?? '',
        url.searchParams.get('b') || null,
      );
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
  if (
    ![
      '/notebooks/add/token',
      '/notebooks/add/finish',
      '/notebooks/remove',
      '/notebooks/token',
    ].includes(path)
  )
    return null;
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
  if (path === '/notebooks/add/token') {
    const started = await store.startToken(text(form, 'token'));
    if ('problem' in started) return addPage(session, store, 400, started.problem);
    return new Response(null, {
      status: 303,
      headers: { location: addLink('/notebooks/add/token', { p: started.pending }) },
    });
  }
  if (path === '/notebooks/add/finish') {
    const pending = text(form, 'p') || null;
    const repository = text(form, 'r');
    const added = await store.finishAdd(pending, repository, text(form, 'b'), text(form, 'f'));
    if ('problem' in added) {
      return repoPage(session, store, pending, repository, null, 400, added.problem);
    }
    return done();
  }
  const notebook = await named(store, url.searchParams.get('n'));
  if (!notebook) return missing(session);
  if (path === '/notebooks/remove') {
    const removed = await store.remove(notebook.key);
    return 'problem' in removed ? removePage(session, notebook, 409, removed.problem) : done();
  }
  const replaced = await store.replaceToken(notebook.key, text(form, 'token').trim());
  return 'problem' in replaced ? tokenPage(session, notebook, 400, replaced.problem) : done();
}
