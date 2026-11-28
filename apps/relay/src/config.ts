/**
 * The relay's settings (T55, PEN-192–PEN-194). Two come from its environment: its owner (the one
 * GitHub account that may set it up, sign in and connect) and which redirect hosts may receive a
 * grant. The rest the owner sets on the relay's own pages, and the Durable Object keeps: the
 * GitHub App setup made, and the notebooks it serves, each a repository, branch and directory
 * reached through the App or a fine-grained token of its own.
 */

/** What the relay reads from its environment. */
export interface RelaySettings {
  /** The relay's owner: the one GitHub account that may set it up, sign in and connect. */
  readonly OWNER_GITHUB_LOGIN?: string;
  readonly AGENT_LABEL?: string;
  readonly ALLOWED_REDIRECT_HOSTS?: string;
  /** Tests only: a fake GitHub API and web origin. */
  readonly GITHUB_API?: string;
  readonly GITHUB_WEB?: string;
}

/** The relay's GitHub App: its id and private key, installed on the notebooks' repositories. */
export interface AppCredentials {
  readonly appId: string;
  readonly privateKey: string;
}

/** How the relay reaches one notebook's repository. */
export type GitHubAccess =
  { readonly kind: 'token'; readonly token: string } | { readonly kind: 'app' };

/** Where a notebook is: its repository (`owner/name`), branch and directory ('' or `dir/`). */
export interface Place {
  readonly repository: string;
  readonly branch: string;
  readonly root: string;
}

/** One notebook the relay serves: where it is, and how the relay reaches it. */
export interface NotebookPlace extends Place {
  readonly access: GitHubAccess;
  /** Its `notebook.json`'s id and name as it was added, until its first sync reads them. */
  readonly id?: string;
  readonly name?: string;
}

/** What the relay's pages and its sign-in need, set up or not. */
export interface RelayBasics {
  /** The one GitHub account that may set the relay up, sign in and connect. */
  readonly owner: string;
  readonly agentLabel: string;
  readonly redirectHosts: readonly string[];
  readonly api: string;
  readonly web: string;
}

export interface RelayConfig extends RelayBasics {
  readonly notebooks: readonly NotebookPlace[];
  /** The App, when a notebook is reached through it. */
  readonly app: AppCredentials | null;
}

const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BRANCH = /^[^\s~^:?*[\\]+$/;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

/** A place's key: the same repository, branch and directory are the same notebook. */
export const placeKey = (place: Place) => `${place.repository}#${place.branch}:${place.root}`;

/**
 * A place as typed on the Notebooks page, checked: the place (the folder as `dir/` or ''), or a
 * sentence saying what is wrong.
 */
export function checkPlace(
  repository: string,
  branch: string,
  folder: string,
): Place | { readonly problem: string } {
  const repo = repository
    .trim()
    .replace(/^https:\/\/github\.com\//, '')
    .replace(/\.git$/, '');
  if (!REPOSITORY.test(repo)) {
    return { problem: 'Name the repository as owner/name, for example htxryan/penmoss-notes.' };
  }
  const name = branch.trim();
  if (!BRANCH.test(name) || name.includes('..')) {
    return { problem: `“${name}” isn’t a branch name.` };
  }
  const dir = folder.trim().replace(/^\/+|\/+$/g, '');
  if (dir.split('/').some((part) => part === '..' || part === '.')) {
    return { problem: 'The folder must be a folder inside the repository.' };
  }
  return { repository: repo, branch: name, root: dir ? `${dir}/` : '' };
}

/** The owner and the hosts: all the relay's pages need, before it is set up. */
export function readBasics(env: RelaySettings): RelayBasics | { readonly problem: string } {
  const owner = env.OWNER_GITHUB_LOGIN?.trim() ?? '';
  if (!LOGIN.test(owner)) {
    return { problem: "OWNER_GITHUB_LOGIN must be the owner's GitHub login." };
  }
  const redirectHosts = (env.ALLOWED_REDIRECT_HOSTS ?? 'claude.ai,claude.com')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  return {
    owner,
    agentLabel: env.AGENT_LABEL?.trim() || 'claude.ai',
    redirectHosts,
    api: (env.GITHUB_API?.trim() || 'https://api.github.com').replace(/\/+$/, ''),
    web: (env.GITHUB_WEB?.trim() || 'https://github.com').replace(/\/+$/, ''),
  };
}

/**
 * The relay's config: its basics, the App setup made (`null` before setup), and the notebooks
 * the owner added. A notebook reached through the App is left out until the App exists.
 */
export function readConfig(
  env: RelaySettings,
  app: AppCredentials | null,
  notebooks: readonly NotebookPlace[],
): RelayConfig | { readonly problem: string } {
  const basics = readBasics(env);
  if ('problem' in basics) return basics;
  const served = notebooks.filter((place) => place.access.kind === 'token' || app !== null);
  return {
    ...basics,
    notebooks: served,
    app: served.some((place) => place.access.kind === 'app') ? app : null,
  };
}

/** Whether a redirect URI's host is one the relay grants to (a host or its subdomain). */
export function redirectAllowed(uri: string, hosts: readonly string[]): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  return hosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

/** The same account, as GitHub compares logins (case does not matter). */
export const sameLogin = (a: string | undefined, b: string) =>
  typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
