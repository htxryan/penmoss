/**
 * The relay's settings (T55, PEN-192): the notebooks it serves (each a repository, branch and
 * directory), who may sign in, which redirect hosts may receive a grant, and how the relay reaches
 * GitHub for each notebook (the relay's GitHub App, or a fine-grained token of that notebook's own).
 */

/** What the relay reads from its environment: plain variables and secrets. */
export interface RelaySettings {
  /**
   * The notebooks, as JSON: `[{"repository": "owner/name", "branch": "main", "folder": ""}]`
   * (branch and folder optional). Without it, the one notebook of `NOTES_*`.
   */
  readonly NOTEBOOKS?: string;
  /** Secret, as JSON: a fine-grained token for each repository that has one (`{"owner/name": "…"}`). */
  readonly NOTEBOOK_TOKENS?: string;
  readonly NOTES_REPOSITORY?: string;
  readonly NOTES_BRANCH?: string;
  readonly NOTES_DIR?: string;
  readonly ALLOWED_GITHUB_LOGIN?: string;
  readonly AGENT_LABEL?: string;
  readonly ALLOWED_REDIRECT_HOSTS?: string;
  readonly GITHUB_CLIENT_ID?: string;
  readonly GITHUB_CLIENT_SECRET?: string;
  /** A fine-grained token for every notebook without one of its own (instead of the App). */
  readonly GITHUB_TOKEN?: string;
  readonly GITHUB_APP_ID?: string;
  readonly GITHUB_APP_PRIVATE_KEY?: string;
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

/** One notebook the relay serves: where it is, and how the relay reaches it. */
export interface NotebookPlace {
  readonly repository: string;
  readonly branch: string;
  /** '' or `dir/`. */
  readonly root: string;
  readonly access: GitHubAccess;
}

export interface RelayConfig {
  readonly notebooks: readonly NotebookPlace[];
  /** The App, when a notebook is reached through it. */
  readonly app: AppCredentials | null;
  readonly allowedLogin: string;
  readonly agentLabel: string;
  readonly redirectHosts: readonly string[];
  readonly api: string;
  readonly web: string;
}

const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** A place's key: the same repository, branch and directory are the same notebook. */
export const placeKey = (place: Omit<NotebookPlace, 'access'>) =>
  `${place.repository}#${place.branch}:${place.root}`;

interface Listed {
  readonly repository: string;
  readonly branch: string;
  readonly root: string;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** One listed notebook, checked: the place, or what is wrong with it. */
function listed(
  repository: unknown,
  branch: unknown,
  folder: unknown,
  where: string,
): Listed | { readonly problem: string } {
  const repo = typeof repository === 'string' ? repository.trim() : '';
  if (!REPOSITORY.test(repo)) {
    return { problem: `${where} must name its repository as owner/name.` };
  }
  if (branch !== undefined && typeof branch !== 'string') {
    return { problem: `${where}'s branch must be text.` };
  }
  if (folder !== undefined && typeof folder !== 'string') {
    return { problem: `${where}'s folder must be text.` };
  }
  const dir = (folder ?? '').trim().replace(/^\/+|\/+$/g, '');
  if (dir.split('/').some((part) => part === '..')) {
    return { problem: `${where}'s folder must be a directory inside the repository.` };
  }
  return { repository: repo, branch: branch?.trim() || 'main', root: dir ? `${dir}/` : '' };
}

/** The notebooks the settings list, or what is wrong with the list. */
function readNotebooks(env: RelaySettings): readonly Listed[] | { readonly problem: string } {
  if (env.NOTEBOOKS?.trim()) {
    const list = parseJson(env.NOTEBOOKS);
    if (!Array.isArray(list) || list.length === 0) {
      return {
        problem:
          'NOTEBOOKS must be a JSON list of notebooks: [{"repository": "owner/name", "branch": "main", "folder": ""}].',
      };
    }
    const out: Listed[] = [];
    for (const [index, each] of list.entries()) {
      const where = `Notebook ${index + 1} in NOTEBOOKS`;
      if (typeof each !== 'object' || each === null || Array.isArray(each)) {
        return { problem: `${where} must be an object with a repository.` };
      }
      const item = each as Record<string, unknown>;
      const place = listed(item['repository'], item['branch'], item['folder'], where);
      if ('problem' in place) return place;
      if (out.some((other) => placeKey(other) === placeKey(place))) {
        return { problem: `${where} is listed twice.` };
      }
      out.push(place);
    }
    return out;
  }
  const one = listed(
    env.NOTES_REPOSITORY,
    env.NOTES_BRANCH,
    env.NOTES_DIR ?? '',
    'NOTES_REPOSITORY',
  );
  if ('problem' in one && !REPOSITORY.test(env.NOTES_REPOSITORY?.trim() ?? '')) {
    return {
      problem:
        'NOTEBOOKS must list the notebooks, or NOTES_REPOSITORY must be set to owner/name of the notes repository.',
    };
  }
  if ('problem' in one)
    return { problem: one.problem.replace("NOTES_REPOSITORY's folder", 'NOTES_DIR') };
  return [one];
}

/** The tokens secret: repository → token. */
function readTokens(
  env: RelaySettings,
): ReadonlyMap<string, string> | { readonly problem: string } {
  if (!env.NOTEBOOK_TOKENS?.trim()) return new Map();
  const tokens = parseJson(env.NOTEBOOK_TOKENS);
  if (typeof tokens !== 'object' || tokens === null || Array.isArray(tokens)) {
    return { problem: 'NOTEBOOK_TOKENS must be JSON: {"owner/name": "github_pat_…"}.' };
  }
  const out = new Map<string, string>();
  for (const [repository, token] of Object.entries(tokens)) {
    if (typeof token !== 'string' || !token.trim()) {
      return { problem: `NOTEBOOK_TOKENS gives ${repository} no token.` };
    }
    out.set(repository.toLowerCase(), token.trim());
  }
  return out;
}

/** The settings checked: the config, or what is missing or wrong (said to whoever connects). */
export function readConfig(env: RelaySettings): RelayConfig | { readonly problem: string } {
  const notebooks = readNotebooks(env);
  if ('problem' in notebooks) return notebooks;
  const allowedLogin = env.ALLOWED_GITHUB_LOGIN?.trim() ?? '';
  if (!allowedLogin) return { problem: 'ALLOWED_GITHUB_LOGIN must name the one GitHub account.' };
  const tokens = readTokens(env);
  if ('problem' in tokens) return tokens;
  const app: AppCredentials | null =
    env.GITHUB_APP_ID?.trim() && env.GITHUB_APP_PRIVATE_KEY?.trim()
      ? { appId: env.GITHUB_APP_ID.trim(), privateKey: env.GITHUB_APP_PRIVATE_KEY }
      : null;
  const shared = env.GITHUB_TOKEN?.trim();
  const places: NotebookPlace[] = [];
  for (const place of notebooks) {
    const own = tokens.get(place.repository.toLowerCase()) ?? shared;
    if (own) {
      places.push({ ...place, access: { kind: 'token', token: own } });
    } else if (app) {
      places.push({ ...place, access: { kind: 'app' } });
    } else {
      return {
        problem: `Nothing reaches ${place.repository}: set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY, or give it a token in NOTEBOOK_TOKENS.`,
      };
    }
  }
  const redirectHosts = (env.ALLOWED_REDIRECT_HOSTS ?? 'claude.ai,claude.com')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  return {
    notebooks: places,
    app: places.some((place) => place.access.kind === 'app') ? app : null,
    allowedLogin,
    agentLabel: env.AGENT_LABEL?.trim() || 'claude.ai',
    redirectHosts,
    api: (env.GITHUB_API?.trim() || 'https://api.github.com').replace(/\/+$/, ''),
    web: (env.GITHUB_WEB?.trim() || 'https://github.com').replace(/\/+$/, ''),
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
