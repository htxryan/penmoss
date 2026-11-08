/**
 * The factory's GitHub identity is a GitHub App installed on the repository (A1222), not a user
 * account. Its private key stays on the host, in `github-app.env`'s key file, and never enters a
 * sandbox. The host mints installation tokens from it: a full one for pushing and PRs, and a
 * read-only one, scoped to the repository, for each sandbox. Both last an hour and are renewed
 * ten minutes before they expire.
 */
import { createSign } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { expandHome } from './config.ts';
import { loadEnvFile } from './secrets.ts';

export const GITHUB_API = 'https://api.github.com';

/** The names `github-app.env` may hold. It is read on the host alone. */
export const GITHUB_APP_KEYS = {
  GITHUB_APP_ID: "the factory app's ID, from its settings page",
  GITHUB_APP_PRIVATE_KEY: "the path of the app's private key (.pem), mode 600",
} as const;

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

const b64url = (data: string | Buffer) => Buffer.from(data).toString('base64url');

/** The app's JWT (RS256), valid nine minutes, back-dated a minute for clock drift. */
export function appJwt(appId: string, privateKey: string, nowSeconds: number): string {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(
    JSON.stringify({ iat: nowSeconds - 60, exp: nowSeconds + 540, iss: appId }),
  );
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${signer.sign(privateKey).toString('base64url')}`;
}

/** What a sandbox's token may do: read the code, PRs, checks and CI logs, nothing else. */
export const READ_ONLY = {
  contents: 'read',
  metadata: 'read',
  pull_requests: 'read',
  checks: 'read',
  actions: 'read',
} as const;

export interface AppIdentity {
  /** The app's slug, as its PR comments' author shows it in GraphQL (`penmoss-factory`). */
  readonly slug: string;
  /** The git identity its commits carry. */
  readonly name: string;
  readonly email: string;
}

export interface AppTokens {
  /** The installation's token, with every permission the app has, on this repository only. */
  write(): Promise<string>;
  /** A read-only token for a sandbox (READ_ONLY). */
  read(): Promise<string>;
  identity(): Promise<AppIdentity>;
}

export interface AppOptions {
  readonly appId: string;
  readonly privateKey: string;
  /** `owner/name`. */
  readonly repo: string;
  readonly fetcher?: Fetcher;
  /** Milliseconds since the epoch. */
  readonly now?: () => number;
}

export class GitHubAppError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitHubAppError';
  }
}

export function createAppTokens(options: AppOptions): AppTokens {
  const fetcher = options.fetcher ?? ((url, init) => fetch(url, init));
  const now = options.now ?? Date.now;
  const [, name = ''] = options.repo.split('/');
  const call = async <T>(path: string, auth: string | null, body?: unknown): Promise<T> => {
    const res = await fetcher(`${GITHUB_API}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const json = (await res.json().catch(() => ({}))) as T & { message?: string };
    if (!res.ok)
      throw new GitHubAppError(`GitHub ${path}: ${json.message ?? `HTTP ${res.status}`}`);
    return json;
  };
  const jwt = () => appJwt(options.appId, options.privateKey, Math.floor(now() / 1000));

  let installation: Promise<number> | undefined;
  const installationId = () =>
    (installation ??= call<{ id: number }>(`/repos/${options.repo}/installation`, jwt()).then(
      (r) => r.id,
    ));

  const cached = (permissions?: Readonly<Record<string, string>>) => {
    let held: { token: string; until: number } | undefined;
    return async () => {
      if (held && held.until > now()) return held.token;
      const r = await call<{ token: string; expires_at: string }>(
        `/app/installations/${await installationId()}/access_tokens`,
        jwt(),
        { repositories: [name], ...(permissions ? { permissions } : {}) },
      );
      held = { token: r.token, until: Date.parse(r.expires_at) - 10 * 60_000 };
      return r.token;
    };
  };

  let identity: Promise<AppIdentity> | undefined;
  return {
    write: cached(),
    read: cached(READ_ONLY),
    identity: () =>
      (identity ??= (async () => {
        const app = await call<{ slug: string }>('/app', jwt());
        const bot = `${app.slug}[bot]`;
        const user = await call<{ id: number }>(`/users/${encodeURIComponent(bot)}`, null);
        return {
          slug: app.slug,
          name: bot,
          email: `${user.id}+${bot}@users.noreply.github.com`,
        };
      })()),
  };
}

/** The app's ID and private key, from the host-only env file and the key file it names. */
export function loadAppCredentials(
  path: string,
): { ok: true; appId: string; privateKey: string } | { ok: false; error: string } {
  const loaded = loadEnvFile(path, GITHUB_APP_KEYS);
  if (!loaded.ok) return loaded;
  const { GITHUB_APP_ID: appId, GITHUB_APP_PRIVATE_KEY: keyPath } = loaded.secrets;
  if (!appId || !/^\d+$/.test(appId))
    return { ok: false, error: `${path} needs GITHUB_APP_ID, the app's number` };
  if (!keyPath)
    return { ok: false, error: `${path} needs GITHUB_APP_PRIVATE_KEY, the .pem's path` };
  const key = expandHome(keyPath);
  try {
    if ((statSync(key).mode & 0o077) !== 0)
      return { ok: false, error: `${key} must be readable by you alone: chmod 600 it` };
    return { ok: true, appId, privateKey: readFileSync(key, 'utf8') };
  } catch {
    return { ok: false, error: `${key} (GITHUB_APP_PRIVATE_KEY) doesn't exist` };
  }
}
