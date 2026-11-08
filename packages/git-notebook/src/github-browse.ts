/**
 * Browsing GitHub for a git notebook's repository and folder (T81, #229; A1164): the
 * repositories a credential reaches, one repository's folders with the notebooks in them, the
 * owners a new repository can go under, and making an empty private repository.
 *
 * Platform-free: an injected `fetch` that sees the method, the body and the response's headers
 * (Link paging, rate limits). The token is given per call and goes only to `api`.
 */

/** A fetch as this module needs it: `globalThis.fetch` and Electron's `net.fetch` both fit. */
export type BrowseFetch = (
  url: string,
  init: {
    readonly method?: string;
    readonly headers: Record<string, string>;
    readonly body?: string;
    /** Always 'error': a token is never carried to wherever a redirect points. */
    readonly redirect?: 'error';
  },
) => Promise<{
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}>;

export type RepoVisibility = 'private' | 'public' | 'internal';

/** A repository the credential reaches. */
export interface GitHubRepo {
  /** `owner/name`. */
  readonly fullName: string;
  readonly owner: string;
  readonly name: string;
  readonly visibility: RepoVisibility;
  readonly defaultBranch: string;
  /** The HTTPS clone address. */
  readonly cloneUrl: string;
  /** When it was last pushed (ISO), or null for never. */
  readonly pushedAt: string | null;
  /** The account can push to it; a read-only one can't hold a notebook. */
  readonly canPush: boolean;
  /** GitHub's size is 0: probably empty (only a hint, for ordering). */
  readonly empty: boolean;
}

export interface RepoList {
  readonly repos: readonly GitHubRepo[];
  /** More than [MAX_REPOS] were there: the oldest-pushed ones are not listed. */
  readonly more: boolean;
}

/** A folder of a repository: `''` is its root. */
export interface RepoFolder {
  readonly path: string;
  /** The notebook it holds (`<path>/.penmoss/notebook.json`), or null. */
  readonly notebook: { readonly id: string; readonly name: string } | null;
}

export interface RepoFolders {
  /** The branch has no commit yet (GitHub answers 409). */
  readonly empty: boolean;
  /** GitHub left some of the tree out: not every folder is listed. */
  readonly truncated: boolean;
  /** The root first, then the rest in path order. */
  readonly folders: readonly RepoFolder[];
}

export interface GitHubOwner {
  readonly login: string;
  readonly kind: 'user' | 'org';
}

export type BrowseReason =
  /** No credential for github.com (from git, or Penmoss's own sign-in). */
  | 'no_credential'
  /** Asking git for it took too long. */
  | 'timeout'
  /** GitHub refused the credential (401). */
  | 'unauthorized'
  /** GitHub refused the call (403 that is not a rate limit). */
  | 'forbidden'
  | 'rate_limited'
  | 'not_found'
  /** A name or branch GitHub would not take, or a 422 refusal. */
  | 'invalid'
  /** The repository name is taken. */
  | 'exists'
  /** GitHub could not be reached. */
  | 'offline'
  /** Anything else GitHub answered. */
  | 'github';

export interface BrowseError {
  readonly reason: BrowseReason;
  readonly message: string;
}

export type BrowseResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: BrowseError };

/** At most this many repositories load (D62: 3 pages of 100). */
export const MAX_REPOS = 300;
const PAGE = 100;
/** The notebook names read from one tree. */
const MAX_NOTEBOOKS = 20;
export const GITHUB_API_BASE = 'https://api.github.com';

/**
 * GitHub's characters for an owner (a user or an organisation). Older accounts may have a
 * trailing or doubled hyphen, so only the characters and the length are checked.
 */
const OWNER = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
/** GitHub's characters for a repository name. */
const REPO = /^[A-Za-z0-9._-]{1,100}$/;

export function ownerOk(owner: string): boolean {
  return OWNER.test(owner);
}

export function repoNameOk(name: string): boolean {
  return REPO.test(name) && name !== '.' && name !== '..' && !name.endsWith('.git');
}

/** A branch name git takes (the rules of `git check-ref-format --branch`). */
export function branchNameOk(branch: string): boolean {
  if (!branch || branch.length > 200) return false;
  if (branch.startsWith('-') || branch.startsWith('/') || branch.endsWith('/')) return false;
  if (branch.endsWith('.') || branch.endsWith('.lock') || branch === '@') return false;
  if (/\.\.|\/\/|@\{|\/\.|^\./.test(branch)) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(branch)) return false;
  return !branch.split('/').some((part) => part.endsWith('.lock'));
}

/**
 * A new repository's name from the notebook's (D62): kebab case plus `-notes` ("Work Log" gives
 * `work-log-notes`); no name yet gives `notes`.
 */
export function defaultRepoName(notebookName: string): string {
  const kebab = notebookName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return kebab ? `${kebab}-notes`.slice(0, 100) : 'notes';
}

interface ApiRepo {
  full_name?: unknown;
  name?: unknown;
  owner?: { login?: unknown };
  private?: unknown;
  visibility?: unknown;
  default_branch?: unknown;
  clone_url?: unknown;
  pushed_at?: unknown;
  size?: unknown;
  permissions?: { push?: unknown; admin?: unknown };
}

const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);

function repoOf(raw: ApiRepo): GitHubRepo | null {
  const fullName = text(raw.full_name);
  const name = text(raw.name);
  const owner = text(raw.owner?.login);
  const cloneUrl = text(raw.clone_url);
  if (!fullName || !name || !owner || !cloneUrl) return null;
  const visibility: RepoVisibility =
    raw.visibility === 'internal'
      ? 'internal'
      : raw.visibility === 'public' || raw.private === false
        ? 'public'
        : 'private';
  return {
    fullName,
    owner,
    name,
    visibility,
    defaultBranch: text(raw.default_branch) || 'main',
    cloneUrl,
    pushedAt: text(raw.pushed_at),
    canPush: raw.permissions?.push === true || raw.permissions?.admin === true,
    empty: raw.size === 0,
  };
}

/** The `rel="next"` address of a Link header, or null. */
function nextLink(link: string | null): string | null {
  if (!link) return null;
  for (const part of link.split(',')) {
    const match = /<([^>]+)>\s*;\s*rel="next"/.exec(part);
    if (match) return match[1]!;
  }
  return null;
}

/** GitHub's own words from an error body, when it has some. */
async function messageOf(response: { json(): Promise<unknown> }): Promise<string | null> {
  try {
    const body = (await response.json()) as {
      message?: unknown;
      errors?: Array<{ message?: unknown; field?: unknown; code?: unknown }>;
    };
    const first = body.errors?.find((each) => typeof each.message === 'string')?.message;
    if (typeof first === 'string') return first;
    return typeof body.message === 'string' ? body.message : null;
  } catch {
    return null;
  }
}

/** Decodes base64 (GitHub's blob content), platform-free. */
function fromBase64(value: string): string {
  const bytes = Uint8Array.from(atob(value.replace(/\s/g, '')), (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export interface GitHubBrowseOptions {
  readonly fetch: BrowseFetch;
  /** The API's origin (default `https://api.github.com`; tests point it at a fake). */
  readonly api?: string | null;
}

export class GitHubBrowse {
  private readonly api: string;

  constructor(private readonly options: GitHubBrowseOptions) {
    this.api = (options.api ?? GITHUB_API_BASE).replace(/\/+$/, '');
  }

  private headers(token: string, json = false): Record<string, string> {
    return {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'Penmoss',
      ...(json ? { 'Content-Type': 'application/json' } : {}),
    };
  }

  /** One call; a refusal as a reason and GitHub's words. */
  private async call(
    url: string,
    token: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<
    | { ok: true; status: number; response: Awaited<ReturnType<BrowseFetch>> }
    | { ok: false; error: BrowseError; status: number }
  > {
    if (!url.startsWith(`${this.api}/`)) {
      // A Link header naming another host is never followed with the token.
      return {
        ok: false,
        status: 0,
        error: { reason: 'github', message: 'GitHub answered with another host.' },
      };
    }
    let response: Awaited<ReturnType<BrowseFetch>>;
    try {
      response = await this.options.fetch(url, {
        ...(init.method ? { method: init.method } : {}),
        headers: this.headers(token, init.body !== undefined),
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        redirect: 'error',
      });
    } catch {
      return {
        ok: false,
        status: 0,
        error: {
          reason: 'offline',
          message: "Can't reach GitHub. Check the connection, or type an address.",
        },
      };
    }
    if (response.status >= 200 && response.status < 300) {
      return { ok: true, status: response.status, response };
    }
    const said = await messageOf(response);
    const status = response.status;
    const limited =
      (status === 403 || status === 429) &&
      (response.headers.get('x-ratelimit-remaining') === '0' || /rate limit/i.test(said ?? ''));
    const error: BrowseError = limited
      ? {
          reason: 'rate_limited',
          message:
            'GitHub is limiting requests for now. Try again in a few minutes, or type an address.',
        }
      : status === 401
        ? { reason: 'unauthorized', message: 'GitHub refused the sign-in git has for it.' }
        : status === 403
          ? { reason: 'forbidden', message: said ? `GitHub refused: ${said}` : 'GitHub refused.' }
          : status === 404
            ? {
                reason: 'not_found',
                message: 'GitHub has no such repository, or it is not shown to this sign-in.',
              }
            : status === 422
              ? /already exists/i.test(said ?? '')
                ? { reason: 'exists', message: 'A repository of that name is there already.' }
                : {
                    reason: 'invalid',
                    message: said ? `GitHub refused: ${said}` : 'GitHub refused the name.',
                  }
              : {
                  reason: 'github',
                  message: `GitHub answered ${status}${said ? `: ${said}` : ''}.`,
                };
    return { ok: false, status, error };
  }

  /** The repositories the token reaches, most recently pushed first, at most [MAX_REPOS]. */
  async repos(token: string): Promise<BrowseResult<RepoList>> {
    const repos: GitHubRepo[] = [];
    let url: string | null =
      `${this.api}/user/repos?affiliation=owner,collaborator,organization_member&sort=pushed&direction=desc&per_page=${PAGE}`;
    let pages = 0;
    while (url && pages < MAX_REPOS / PAGE) {
      const answer = await this.call(url, token);
      if (!answer.ok) return answer;
      const body: unknown = await answer.response.json().catch(() => null);
      if (!Array.isArray(body)) {
        return {
          ok: false,
          error: { reason: 'github', message: 'GitHub sent a list Penmoss cannot read.' },
        };
      }
      for (const raw of body as ApiRepo[]) {
        const repo = repoOf(raw);
        if (repo) repos.push(repo);
      }
      pages += 1;
      url = nextLink(answer.response.headers.get('link'));
    }
    return { ok: true, value: { repos: repos.slice(0, MAX_REPOS), more: url !== null } };
  }

  /**
   * One repository's folders at `branch`: the root first, without dot-folders or the subfolders
   * of a folder holding a notebook, each with the notebook it holds.
   */
  async folders(
    token: string,
    fullName: string,
    branch: string,
  ): Promise<BrowseResult<RepoFolders>> {
    const [owner, name, ...rest] = fullName.split('/');
    if (!owner || !name || rest.length > 0 || !ownerOk(owner) || !repoNameOk(name)) {
      return {
        ok: false,
        error: { reason: 'invalid', message: 'That is not a GitHub repository name.' },
      };
    }
    if (!branchNameOk(branch)) {
      return {
        ok: false,
        error: { reason: 'invalid', message: `“${branch}” is not a branch name git takes.` },
      };
    }
    const base = `${this.api}/repos/${owner}/${name}`;
    const answer = await this.call(
      `${base}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
      token,
    );
    if (!answer.ok) {
      // An empty repository has no tree yet; a missing branch of one that has commits is a 404.
      if (answer.status === 409) {
        return {
          ok: true,
          value: { empty: true, truncated: false, folders: [{ path: '', notebook: null }] },
        };
      }
      return answer;
    }
    const body = (await answer.response.json().catch(() => null)) as {
      tree?: Array<{ path?: unknown; type?: unknown; sha?: unknown }>;
      truncated?: unknown;
    } | null;
    const entries = body && Array.isArray(body.tree) ? body.tree : [];
    const dirs = new Set<string>();
    const notebookBlobs = new Map<string, string>();
    for (const entry of entries) {
      const path = text(entry.path);
      if (!path) continue;
      if (entry.type === 'tree') dirs.add(path);
      if (
        entry.type === 'blob' &&
        (path === '.penmoss/notebook.json' || path.endsWith('/.penmoss/notebook.json'))
      ) {
        const sha = text(entry.sha);
        if (sha)
          notebookBlobs.set(
            path.slice(0, -'.penmoss/notebook.json'.length).replace(/\/$/, ''),
            sha,
          );
      }
    }
    const notebooks = new Map<string, { id: string; name: string }>();
    for (const [folder, sha] of [...notebookBlobs].slice(0, MAX_NOTEBOOKS)) {
      const blob = await this.call(`${base}/git/blobs/${encodeURIComponent(sha)}`, token);
      if (!blob.ok) continue;
      try {
        const content = (await blob.response.json()) as { content?: unknown };
        const parsed = JSON.parse(fromBase64(text(content.content) ?? '')) as {
          id?: unknown;
          name?: unknown;
        };
        const id = text(parsed.id);
        if (id) notebooks.set(folder, { id, name: text(parsed.name) || 'Notebook' });
      } catch {
        // A notebook.json Penmoss cannot read is listed as a plain folder.
      }
    }
    const hidden = (path: string) =>
      path.split('/').some((part) => part.startsWith('.')) ||
      [...notebooks.keys()].some((folder) =>
        folder === '' ? true : path.startsWith(`${folder}/`),
      );
    const folders: RepoFolder[] = [{ path: '', notebook: notebooks.get('') ?? null }];
    for (const path of [...dirs].sort()) {
      if (hidden(path)) continue;
      folders.push({ path, notebook: notebooks.get(path) ?? null });
    }
    return { ok: true, value: { empty: false, truncated: body?.truncated === true, folders } };
  }

  /** The owners a new repository can go under: the account, then its organisations. */
  async owners(token: string): Promise<BrowseResult<readonly GitHubOwner[]>> {
    const me = await this.call(`${this.api}/user`, token);
    if (!me.ok) return me;
    const user = (await me.response.json().catch(() => null)) as { login?: unknown } | null;
    const login = text(user?.login);
    if (!login)
      return {
        ok: false,
        error: { reason: 'github', message: 'GitHub did not say who is signed in.' },
      };
    const owners: GitHubOwner[] = [{ login, kind: 'user' }];
    const orgs = await this.call(`${this.api}/user/orgs?per_page=100`, token);
    if (orgs.ok) {
      const list: unknown = await orgs.response.json().catch(() => null);
      if (Array.isArray(list)) {
        for (const org of list as Array<{ login?: unknown }>) {
          const name = text(org.login);
          if (name) owners.push({ login: name, kind: 'org' });
        }
      }
    }
    return { ok: true, value: owners };
  }

  /** Makes an empty private repository under `owner` (the account's own, or an organisation's). */
  async createRepo(
    token: string,
    owner: GitHubOwner,
    name: string,
  ): Promise<BrowseResult<GitHubRepo>> {
    if (!ownerOk(owner.login)) {
      return {
        ok: false,
        error: { reason: 'invalid', message: 'That is not a GitHub account or organisation.' },
      };
    }
    if (!repoNameOk(name)) {
      return {
        ok: false,
        error: {
          reason: 'invalid',
          message: 'Use letters, digits, hyphens, dots and underscores for the repository name.',
        },
      };
    }
    const url =
      owner.kind === 'org' ? `${this.api}/orgs/${owner.login}/repos` : `${this.api}/user/repos`;
    const answer = await this.call(url, token, {
      method: 'POST',
      body: { name, private: true, auto_init: false, description: 'Notes kept by Penmoss' },
    });
    if (!answer.ok) return answer;
    const repo = repoOf((await answer.response.json().catch(() => ({}))) as ApiRepo);
    if (!repo)
      return {
        ok: false,
        error: { reason: 'github', message: 'GitHub made the repository but did not say where.' },
      };
    return { ok: true, value: { ...repo, canPush: true, empty: true } };
  }
}
