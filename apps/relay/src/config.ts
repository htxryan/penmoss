/**
 * The relay's settings (T55): which repository, branch and directory hold the notebook, who may
 * sign in, which redirect hosts may receive a grant, and how the relay reaches GitHub (a GitHub
 * App installation, or a fine-grained token limited to the notes repository).
 */

/** What the relay reads from its environment: plain variables and secrets. */
export interface RelaySettings {
  readonly NOTES_REPOSITORY?: string;
  readonly NOTES_BRANCH?: string;
  readonly NOTES_DIR?: string;
  readonly ALLOWED_GITHUB_LOGIN?: string;
  readonly AGENT_LABEL?: string;
  readonly ALLOWED_REDIRECT_HOSTS?: string;
  readonly GITHUB_CLIENT_ID?: string;
  readonly GITHUB_CLIENT_SECRET?: string;
  readonly GITHUB_TOKEN?: string;
  readonly GITHUB_APP_ID?: string;
  readonly GITHUB_APP_INSTALLATION_ID?: string;
  readonly GITHUB_APP_PRIVATE_KEY?: string;
  /** Tests only: a fake GitHub API and web origin. */
  readonly GITHUB_API?: string;
  readonly GITHUB_WEB?: string;
}

export type GitHubAccess =
  | { readonly kind: 'token'; readonly token: string }
  | {
      readonly kind: 'app';
      readonly appId: string;
      readonly installationId: string;
      readonly privateKey: string;
    };

export interface RelayConfig {
  readonly repository: string;
  readonly branch: string;
  /** '' or `dir/`. */
  readonly root: string;
  readonly allowedLogin: string;
  readonly agentLabel: string;
  readonly redirectHosts: readonly string[];
  readonly access: GitHubAccess;
  readonly api: string;
  readonly web: string;
}

const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** The settings checked: the config, or what is missing or wrong (said to whoever connects). */
export function readConfig(env: RelaySettings): RelayConfig | { readonly problem: string } {
  const repository = env.NOTES_REPOSITORY?.trim() ?? '';
  if (!REPOSITORY.test(repository)) {
    return { problem: 'NOTES_REPOSITORY must be set to owner/name of the notes repository.' };
  }
  const allowedLogin = env.ALLOWED_GITHUB_LOGIN?.trim() ?? '';
  if (!allowedLogin) return { problem: 'ALLOWED_GITHUB_LOGIN must name the one GitHub account.' };
  const dir = (env.NOTES_DIR ?? '').trim().replace(/^\/+|\/+$/g, '');
  if (dir.split('/').some((part) => part === '..')) {
    return { problem: 'NOTES_DIR must be a directory inside the repository.' };
  }
  let access: GitHubAccess;
  if (env.GITHUB_TOKEN?.trim()) {
    access = { kind: 'token', token: env.GITHUB_TOKEN.trim() };
  } else if (
    env.GITHUB_APP_ID?.trim() &&
    env.GITHUB_APP_INSTALLATION_ID?.trim() &&
    env.GITHUB_APP_PRIVATE_KEY?.trim()
  ) {
    access = {
      kind: 'app',
      appId: env.GITHUB_APP_ID.trim(),
      installationId: env.GITHUB_APP_INSTALLATION_ID.trim(),
      privateKey: env.GITHUB_APP_PRIVATE_KEY,
    };
  } else {
    return {
      problem:
        'Set GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID and GITHUB_APP_PRIVATE_KEY, or GITHUB_TOKEN.',
    };
  }
  const redirectHosts = (env.ALLOWED_REDIRECT_HOSTS ?? 'claude.ai,claude.com')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  return {
    repository,
    branch: env.NOTES_BRANCH?.trim() || 'main',
    root: dir ? `${dir}/` : '',
    allowedLogin,
    agentLabel: env.AGENT_LABEL?.trim() || 'claude.ai',
    redirectHosts,
    access,
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
