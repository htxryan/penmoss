/**
 * Add a Git Notebook's GitHub browsing, in the main process (T81, #229; A1163–A1165): the
 * credential (git's own, else Penmoss's sign-in, T82) is asked for afresh on every call, used for
 * that call only, and sent only to the GitHub API base. The page gets repositories, folders and
 * owners, never the token. Used by main.ts and by the web E2E's stand-in Mac, so both test the
 * same code.
 */
import {
  GitHubBrowse,
  type BrowseError,
  type BrowseFetch,
  type BrowseResult,
  type GitHubOwner,
  type GitHubRepo,
  type RepoFolders,
  type RepoList,
} from '@penmoss/git-notebook/github-browse';
import { gitHubCredential, type CredentialAnswer } from './git-credential';

/** Which sign-in a call used: git's own, or Penmoss's (Sign in with GitHub, T82). */
export type BrowseVia = 'git' | 'penmoss';

export type ViaResult<T> =
  | { readonly ok: true; readonly value: T; readonly via: BrowseVia }
  | { readonly ok: false; readonly error: BrowseError };

export interface GitHubBrowseHostOptions {
  readonly fetch: BrowseFetch;
  /** `config.githubApi`: the suite's fake, else api.github.com. */
  readonly api?: string | null;
  /** git's environment (config.gitEnv). */
  readonly gitEnv?: Readonly<Record<string, string>> | null;
  /** git's credential; tests stand in for it. Default: `git credential fill`. */
  readonly credential?: () => Promise<CredentialAnswer>;
  /**
   * Penmoss's own GitHub sign-in (T82), when there is one: the first account's with no `login`,
   * else that account's (A1617).
   */
  readonly penmossToken?: (login?: string | null) => Promise<string | null>;
  /** GitHub refused one of Penmoss's sign-ins (401): Settings → GitHub says so. */
  readonly onPenmossRefused?: (login?: string | null) => Promise<void>;
}

const NO_CREDENTIAL: BrowseError = {
  reason: 'no_credential',
  message: 'Git on this Mac isn’t signed in to GitHub.',
};
const TIMEOUT: BrowseError = {
  reason: 'timeout',
  message: 'Git took too long to answer for its GitHub sign-in.',
};

const isString = (value: unknown, max = 300): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max;

/**
 * Which of Penmoss's accounts a call is for (A1617): a login, `null` for an account GitHub never
 * named, or undefined for no choice (git's sign-in, else the first account).
 */
export type BrowseAccount = string | null | undefined;

const accountOf = (value: unknown): BrowseAccount | false =>
  value === undefined || value === null ? value : isString(value, 100) ? value : false;

const NO_ACCOUNT: BrowseError = {
  reason: 'unauthorized',
  message: 'That GitHub account isn’t signed in on this Mac any more. Sign in again.',
};

export class GitHubBrowseHost {
  private readonly browse: GitHubBrowse;

  constructor(private readonly options: GitHubBrowseHostOptions) {
    this.browse = new GitHubBrowse({ fetch: options.fetch, api: options.api ?? null });
  }

  /**
   * Runs `call` with git's credential, else Penmoss's; one GitHub refuses (401) gives way to
   * Penmoss's when there is one.
   */
  private async withToken<T>(
    call: (token: string) => Promise<BrowseResult<T>>,
    account?: BrowseAccount,
  ): Promise<ViaResult<T>> {
    // One of Penmoss's accounts, picked in Add Notebook (A1617): that account's token alone.
    if (account !== undefined) {
      const token = await this.options.penmossToken?.(account).catch(() => null);
      return token ? this.withPenmoss(call, token, account) : { ok: false, error: NO_ACCOUNT };
    }
    const git = await (
      this.options.credential ?? (() => gitHubCredential({ gitEnv: this.options.gitEnv ?? null }))
    )();
    if (git.ok) {
      const answer = await call(git.token);
      if (answer.ok) return { ...answer, via: 'git' };
      if (answer.error.reason !== 'unauthorized') return answer;
      const own = await this.options.penmossToken?.().catch(() => null);
      return own ? this.withPenmoss(call, own) : answer;
    }
    const own = await this.options.penmossToken?.().catch(() => null);
    if (own) return this.withPenmoss(call, own);
    return { ok: false, error: git.reason === 'timeout' ? TIMEOUT : NO_CREDENTIAL };
  }

  /** The account `token` belongs to (`GET /user`), for Sign in with GitHub; null when GitHub won't say. */
  async loginOf(token: string): Promise<string | null> {
    const answer = await this.browse.owners(token).catch(() => null);
    return answer?.ok ? (answer.value.find((owner) => owner.kind === 'user')?.login ?? null) : null;
  }

  /**
   * The login git's own GitHub sign-in is for (A1617), so Add Notebook can list it beside
   * Penmoss's accounts; null when git has none or GitHub won't say.
   */
  async gitLogin(): Promise<string | null> {
    const git = await (
      this.options.credential ?? (() => gitHubCredential({ gitEnv: this.options.gitEnv ?? null }))
    )();
    return git.ok ? this.loginOf(git.token) : null;
  }

  /** One call with Penmoss's sign-in; a 401 marks it refused (A1171) and asks to sign in again. */
  private async withPenmoss<T>(
    call: (token: string) => Promise<BrowseResult<T>>,
    token: string,
    account?: BrowseAccount,
  ): Promise<ViaResult<T>> {
    const answer = await call(token);
    if (answer.ok) return { ...answer, via: 'penmoss' };
    if (answer.error.reason !== 'unauthorized') return answer;
    await this.options.onPenmossRefused?.(account).catch(() => undefined);
    return {
      ok: false,
      error: {
        reason: 'unauthorized',
        message: 'GitHub refused Penmoss’s sign-in. Sign in again.',
      },
    };
  }

  repos(account?: unknown): Promise<ViaResult<RepoList>> {
    const who = accountOf(account);
    if (who === false) return Promise.resolve({ ok: false, error: NO_ACCOUNT });
    return this.withToken((token) => this.browse.repos(token), who);
  }

  folders(fullName: unknown, branch: unknown, account?: unknown): Promise<ViaResult<RepoFolders>> {
    const who = accountOf(account);
    if (!isString(fullName, 140) || !isString(branch, 200) || who === false) {
      return Promise.resolve({
        ok: false,
        error: { reason: 'invalid', message: 'Pick a repository first.' },
      });
    }
    return this.withToken((token) => this.browse.folders(token, fullName, branch), who);
  }

  owners(account?: unknown): Promise<ViaResult<readonly GitHubOwner[]>> {
    const who = accountOf(account);
    if (who === false) return Promise.resolve({ ok: false, error: NO_ACCOUNT });
    return this.withToken((token) => this.browse.owners(token), who);
  }

  create(owner: unknown, name: unknown, account?: unknown): Promise<ViaResult<GitHubRepo>> {
    const o = owner as { login?: unknown; kind?: unknown } | null;
    const who = accountOf(account);
    if (
      who === false ||
      !o ||
      !isString(o.login, 40) ||
      (o.kind !== 'user' && o.kind !== 'org') ||
      !isString(name, 100)
    ) {
      return Promise.resolve({
        ok: false,
        error: { reason: 'invalid', message: 'Give the repository a name and an owner.' },
      });
    }
    const login = o.login;
    const kind = o.kind;
    return this.withToken((token) => this.browse.createRepo(token, { login, kind }, name), who);
  }
}
