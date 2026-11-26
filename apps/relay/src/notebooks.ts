/**
 * The Notebooks page (PEN-193; PEN-194 adds adding and removing): the notebooks this relay
 * serves, the connector's address, and who is signed in. Only the owner sees it.
 */
import { buttonForm, escape, group, page, para, row } from './pages';
import type { Session } from './session';

/** A served notebook as the page shows it: nothing secret. */
export interface NotebookRow {
  readonly name: string;
  readonly repository: string;
  readonly branch: string;
  /** '' or `dir/`. */
  readonly root: string;
  readonly access: 'app' | 'token';
}

export interface NotebooksStore {
  /** The repositories of the notebooks served, for claude.ai's consent page. */
  repositories(): Promise<readonly string[]>;
  notebooks(): Promise<readonly NotebookRow[] | { readonly problem: string }>;
}

const where = (each: NotebookRow) =>
  [escape(each.repository), escape(each.branch), ...(each.root ? [escape(each.root)] : [])].join(
    ' · ',
  );

export async function notebooksPage(
  url: URL,
  session: Session,
  store: NotebooksStore,
): Promise<Response> {
  const listed = await store.notebooks();
  const rows =
    'problem' in listed
      ? [row('No Notebooks Yet', escape(listed.problem))]
      : listed.map((each) =>
          row(each.name, `${where(each)} · ${each.access === 'app' ? 'GitHub App' : 'Token'}`),
        );
  const signOut = buttonForm(
    '/sign-out',
    'Sign Out',
    { csrf: session.csrf },
    { className: 'relay-link' },
  );
  return page(
    200,
    'Notebooks',
    para(
      'Claude reaches these notebooks through this relay. In Claude, add a custom connector with the address below.',
    ) +
      group([row('Connector Address', `<code>${escape(url.origin)}/mcp</code>`)]) +
      group(rows),
    { aside: `Signed in as ${escape(session.login)} · ${signOut}` },
  );
}
