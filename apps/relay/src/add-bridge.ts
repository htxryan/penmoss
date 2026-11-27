/**
 * Add Notebook's bridge on the relay (A1701): the relay's side of the Mac app's `DesktopGit` and
 * `DesktopGitHubToken` (apps/web/src/desktop/bridge.ts), so the page runs the app's own Add
 * Notebook flow unchanged (`apps/web/src/relay`). Every answer has the bridge's shape.
 *
 * GitHub is reached as the Mac reaches it: what is found without asking (on the Mac, git's own
 * sign-in; here, the relay's GitHub App, as its owner), or one of the GitHub accounts kept here
 * (tokens pasted in Manage GitHub Accounts). A notebook added through an account keeps a copy of
 * its token, as on the Mac. Create New Repo makes the repository as the owner (their sign-in to
 * the relay, which needs the App's Administration permission) or as an account; a new notebook is
 * its `notebook.json`, committed to the repository before it is added.
 */
import { TOKEN_MESSAGES, tokenIsWhole } from '@penmoss/core/feedback-github';
import { ulid } from '@penmoss/core/ids';
import {
  GitHubBrowse,
  type BrowseError,
  type GitHubOwner,
  type GitHubRepo,
  type RepoFolders,
  type RepoList,
} from '@penmoss/git-notebook/github-browse';
import { remoteParts } from '@penmoss/git-notebook/remote';
import { checkPlace, placeKey, type Place } from './config';
import { makeNotebookFile, notebookFileOf, type GitHubCall } from './github-api';
import { ownerTokenFrom, type AppTokens, type OwnerToken } from './github-auth';
import { readNotebookList, writeNotebookList, type StoredNotebook } from './notebook-list';
import type { NotebookRow } from './notebooks';
import type { Blobs } from './storage';

/** Which sign-in a browse call used: the relay's App (the Mac's `git`), or an account. */
type Via = 'git' | 'penmoss';

export type GitHubAnswer<T> =
  | { readonly ok: true; readonly value: T; readonly via: Via }
  | { readonly ok: false; readonly error: BrowseError };

export type GitAnswer<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } };

/** A served notebook as the bridge lists it; the page fills the Mac's other fields. */
export interface BridgeNotebook {
  readonly notebookId: string;
  readonly name: string;
  readonly remote: string;
  readonly repository: string;
  readonly branch: string;
  readonly dir: string;
  readonly hasToken: boolean;
  /** When it last synced (ms), or null for not yet. */
  readonly syncedAt: number | null;
  /** What went wrong with its last sync, in a sentence. */
  readonly problem: string | null;
}

export type AddResult =
  | { readonly kind: 'added'; readonly notebook: BridgeNotebook; readonly created: boolean }
  | { readonly kind: 'needs-name' };

export interface AddInput {
  readonly remote: string;
  readonly branch: string;
  readonly dir: string;
  readonly name?: string;
  readonly githubSignIn?: boolean;
  readonly githubAccount?: string | null;
}

/** Penmoss's GitHub accounts, as Settings → GitHub lists them (`DesktopGitHubTokenStatus`). */
export interface AccountsStatus {
  readonly accounts: readonly {
    readonly login: string | null;
    readonly primary: boolean;
    readonly signedIn: boolean;
    readonly problem: string | null;
  }[];
  readonly saved: boolean;
  readonly login: string | null;
  readonly problem: string | null;
  readonly keychain: boolean;
  readonly signedIn: boolean;
}

/** A pasted token, kept as an account. */
interface Account {
  readonly login: string;
  readonly token: string;
}

const ACCOUNTS = 'settings:accounts';
const OWNER_TOKEN = 'settings:owner-token';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const refuse = (code: string, message: string) => ({
  ok: false as const,
  error: { code, message },
});

/** `owner/name` of a github.com remote (HTTPS or SSH), as the Mac reads remotes. */
function githubRepoOf(remote: string): string | null {
  const parts = remoteParts(remote.trim());
  return parts?.host === 'github.com' && /^[^/]+\/[^/]+$/.test(parts.path) ? parts.path : null;
}

/** A notebook at a place, as the bridge lists it. */
function bridgeNotebook(
  place: Pick<Place, 'repository' | 'branch' | 'root'>,
  fields: Pick<BridgeNotebook, 'notebookId' | 'name' | 'hasToken' | 'syncedAt' | 'problem'>,
): BridgeNotebook {
  return {
    ...fields,
    remote: `https://github.com/${place.repository}.git`,
    repository: `github.com/${place.repository}`,
    branch: place.branch,
    dir: place.root.replace(/\/$/, ''),
  };
}

function readOwnerToken(blobs: Blobs): OwnerToken | null {
  const bytes = blobs.get(OWNER_TOKEN);
  return bytes ? (JSON.parse(decoder.decode(bytes)) as OwnerToken) : null;
}

export function keepOwnerToken(blobs: Blobs, token: OwnerToken): void {
  blobs.put(OWNER_TOKEN, encoder.encode(JSON.stringify(token)));
}

export interface AddBridgeOptions {
  readonly blobs: Blobs;
  readonly api: string;
  readonly web: string;
  readonly owner: string;
  readonly browse: GitHubBrowse;
  readonly app: AppTokens | null;
  /** The App's client, to refresh the owner's sign-in. */
  readonly client: { readonly id: string; readonly secret: string } | null;
  /** The served notebooks, each synced once. */
  readonly rows: () => Promise<readonly NotebookRow[]>;
  /** The list changed: the relay is built again. */
  readonly changed: () => void;
  readonly fetch: typeof fetch;
  readonly clock?: () => number;
}

export class AddBridge {
  private readonly clock: () => number;

  constructor(private readonly options: AddBridgeOptions) {
    this.clock = options.clock ?? Date.now;
  }

  // Accounts (Settings → GitHub, embedded in Add Notebook's Manage GitHub Accounts).

  private accounts(): Account[] {
    const bytes = this.options.blobs.get(ACCOUNTS);
    return bytes ? (JSON.parse(decoder.decode(bytes)) as Account[]) : [];
  }

  private keepAccounts(accounts: readonly Account[]): void {
    this.options.blobs.put(ACCOUNTS, encoder.encode(JSON.stringify(accounts)));
  }

  status(): AccountsStatus {
    const accounts = this.accounts();
    return {
      accounts: accounts.map((each, at) => ({
        login: each.login,
        primary: at === 0,
        signedIn: false,
        problem: null,
      })),
      saved: accounts.length > 0,
      login: accounts[0]?.login ?? null,
      problem: null,
      keychain: true,
      signedIn: false,
    };
  }

  async save(
    token: string,
  ): Promise<
    | { readonly ok: true; readonly status: AccountsStatus; readonly note: string | null }
    | { readonly ok: false; readonly message: string }
  > {
    const pasted = token.trim();
    if (!tokenIsWhole(pasted)) return { ok: false, message: TOKEN_MESSAGES.shape };
    const owners = await this.options.browse.owners(pasted);
    if (!owners.ok) {
      return {
        ok: false,
        message:
          owners.error.reason === 'unauthorized' ? TOKEN_MESSAGES.invalid : owners.error.message,
      };
    }
    const login = owners.value.find((each) => each.kind === 'user')?.login;
    if (!login) return { ok: false, message: 'GitHub didn’t say whose token this is.' };
    const kept = this.accounts();
    const was = kept.some((each) => each.login === login);
    this.keepAccounts([
      ...kept.map((each) => (each.login === login ? { login, token: pasted } : each)),
      ...(was ? [] : [{ login, token: pasted }]),
    ]);
    return { ok: true, status: this.status(), note: null };
  }

  remove(login?: string | null): { readonly ok: true; readonly status: AccountsStatus } {
    const kept = this.accounts();
    const gone = login ? kept.filter((each) => each.login !== login) : kept.slice(1);
    this.keepAccounts(gone);
    return { ok: true, status: this.status() };
  }

  /** An account's token, by login; the first when none is named. */
  private tokenOf(account: string | null | undefined): string | null {
    const kept = this.accounts();
    return (account ? kept.find((each) => each.login === account) : kept[0])?.token ?? null;
  }

  // GitHub, as Add Notebook browses it.

  /** Whose the App's sign-in is: the relay's owner. */
  gitLogin(): string {
    return this.options.owner;
  }

  async repos(account?: string | null): Promise<GitHubAnswer<RepoList>> {
    if (account !== undefined) {
      const token = this.tokenOf(account);
      if (!token) return this.noAccount();
      const listed = await this.options.browse.repos(token);
      return listed.ok ? { ...listed, via: 'penmoss' } : listed;
    }
    const app = this.options.app;
    if (!app) return this.noApp();
    const repos = new Map<string, GitHubRepo>();
    let more = false;
    for (const each of await app.installationTokens().catch(() => [] as string[])) {
      const listed = await this.options.browse.installed(each);
      if (!listed.ok) return listed;
      more ||= listed.value.more;
      for (const repo of listed.value.repos) repos.set(repo.fullName, repo);
    }
    const pushed = (repo: GitHubRepo) => repo.pushedAt ?? '';
    return {
      ok: true,
      via: 'git',
      value: {
        repos: [...repos.values()].sort((a, b) => pushed(b).localeCompare(pushed(a))),
        more,
      },
    };
  }

  async folders(
    fullName: string,
    branch: string,
    account?: string | null,
  ): Promise<GitHubAnswer<RepoFolders>> {
    const token = await this.readToken(fullName, account);
    if (typeof token !== 'string') return token;
    const read = await this.options.browse.folders(token, fullName, branch);
    return read.ok ? { ...read, via: account === undefined ? 'git' : 'penmoss' } : read;
  }

  /** Pick Branch's branches (A1621), read as `folders` reads. */
  async branches(
    fullName: string,
    defaultBranch: string,
    account?: string | null,
  ): Promise<GitHubAnswer<readonly string[]>> {
    const token = await this.readToken(fullName, account);
    if (typeof token !== 'string') return token;
    const read = await this.options.browse.branches(token, fullName, defaultBranch);
    return read.ok ? { ...read, via: account === undefined ? 'git' : 'penmoss' } : read;
  }

  async owners(account?: string | null): Promise<GitHubAnswer<readonly GitHubOwner[]>> {
    if (account !== undefined) {
      const token = this.tokenOf(account);
      if (!token) return this.noAccount();
      const owners = await this.options.browse.owners(token);
      return owners.ok ? { ...owners, via: 'penmoss' } : owners;
    }
    // As the owner, through the App: their own account.
    return { ok: true, via: 'git', value: [{ login: this.options.owner, kind: 'user' }] };
  }

  async create(
    owner: GitHubOwner,
    name: string,
    account?: string | null,
  ): Promise<GitHubAnswer<GitHubRepo>> {
    const token = account !== undefined ? this.tokenOf(account) : await this.ownerToken();
    if (!token) {
      return account !== undefined
        ? this.noAccount()
        : {
            ok: false,
            error: {
              reason: 'unauthorized',
              message: 'Sign in to this relay again, then make the repository.',
            },
          };
    }
    const made = await this.options.browse.createRepo(token, owner, name);
    if (!made.ok) {
      return made.error.reason === 'forbidden' && account === undefined
        ? {
            ok: false,
            error: {
              reason: 'forbidden',
              message:
                'The relay’s GitHub App may not make repositories. In its settings on GitHub, give it Administration: Read and write, and accept the change, then try again.',
            },
          }
        : made;
    }
    return { ok: true, via: account === undefined ? 'git' : 'penmoss', value: made.value };
  }

  // The notebooks.

  async list(): Promise<BridgeNotebook[]> {
    const stored = readNotebookList(this.options.blobs);
    const rows = await this.options.rows();
    return rows.map((row) => {
      const entry = stored.find((each) => placeKey(each) === row.key);
      return bridgeNotebook(row, {
        notebookId: row.id ?? entry?.id ?? row.key,
        name: row.name,
        hasToken: row.access === 'token',
        syncedAt: row.syncedAt,
        problem: row.problem,
      });
    });
  }

  /**
   * Adds the notebook at an address, as the Mac's git.add does: the one it holds, or, with a
   * name, a new one there; with neither, `needs-name`.
   */
  async add(input: AddInput): Promise<GitAnswer<AddResult>> {
    const repository = githubRepoOf(input.remote);
    if (!repository) {
      return refuse(
        'invalid',
        'The relay reaches GitHub repositories: paste a github.com address.',
      );
    }
    const place = checkPlace(repository, input.branch || 'main', input.dir);
    if ('problem' in place) return refuse('invalid', place.problem);
    const list = readNotebookList(this.options.blobs);
    if (list.some((each) => placeKey(each) === placeKey(place))) {
      return refuse('notebook_exists', 'That notebook is on this relay already.');
    }
    const access = await this.accessFor(place, input);
    if ('problem' in access) return refuse('auth', access.problem);
    const github: GitHubCall = {
      api: this.options.api,
      fetch: (request, init) => this.options.fetch(request, init),
      token: access.token,
    };
    const file = await notebookFileOf(github, place);
    let id: string;
    let name: string;
    let created = false;
    if (!('problem' in file)) {
      ({ id, name } = file);
      const served = await this.list();
      if (served.some((each) => each.notebookId === id)) {
        return refuse('notebook_exists', `The notebook “${name}” is on this relay already.`);
      }
    } else if (!('missing' in file)) {
      return refuse('git', file.problem);
    } else if (!input.name) {
      return { ok: true, value: { kind: 'needs-name' } };
    } else {
      id = ulid(this.clock());
      name = input.name.trim().slice(0, 80) || 'Notebook';
      const made = await makeNotebookFile(github, place, { id, name });
      if (made) return refuse('git', made);
      created = true;
    }
    writeNotebookList(this.options.blobs, [
      ...list,
      {
        ...place,
        id,
        name,
        ...(access.kept ? { token: access.kept } : {}),
      } satisfies StoredNotebook,
    ]);
    this.options.changed();
    return {
      ok: true,
      value: {
        kind: 'added',
        created,
        notebook: bridgeNotebook(place, {
          notebookId: id,
          name,
          hasToken: access.kept !== null,
          syncedAt: null,
          problem: null,
        }),
      },
    };
  }

  /**
   * How the relay reaches a notebook: the account picked (its token kept with the notebook), else
   * the App, else the first account that reads the repository, as the Mac's git finds a way.
   */
  private async accessFor(
    place: Place,
    input: AddInput,
  ): Promise<{ token: () => Promise<string>; kept: string | null } | { problem: string }> {
    if (input.githubSignIn) {
      const token = this.tokenOf(input.githubAccount);
      if (!token) return { problem: 'That GitHub account isn’t kept here any more.' };
      return { token: () => Promise.resolve(token), kept: token };
    }
    const app = this.options.app;
    if (app) {
      try {
        await app.token(place.repository);
        return { token: () => app.token(place.repository), kept: null };
      } catch {
        // Not installed there: an account may reach it.
      }
    }
    for (const each of this.accounts()) {
      const read = await this.options.browse.folders(each.token, place.repository, place.branch);
      if (read.ok) return { token: () => Promise.resolve(each.token), kept: each.token };
    }
    return {
      problem: `The relay’s GitHub App isn’t installed on ${place.repository}, and no account kept here reaches it. Install the App there, or add an account in Manage GitHub Accounts.`,
    };
  }

  /** A token that reads `fullName`: the account's, or the App's for it. */
  private async readToken(
    fullName: string,
    account: string | null | undefined,
  ): Promise<string | { ok: false; error: BrowseError }> {
    if (account !== undefined) {
      const token = this.tokenOf(account);
      return token ?? this.noAccount();
    }
    const app = this.options.app;
    if (!app) return this.noApp();
    try {
      return await app.token(fullName);
    } catch {
      return {
        ok: false,
        error: {
          reason: 'not_found',
          message: `The relay’s GitHub App isn’t installed on ${fullName}.`,
        },
      };
    }
  }

  /** The owner's sign-in to the relay, refreshed when it ran out; null without one. */
  private async ownerToken(): Promise<string | null> {
    const held = readOwnerToken(this.options.blobs);
    if (!held) return null;
    if (held.until === null || this.clock() < held.until - 60_000) return held.token;
    const client = this.options.client;
    if (!held.refresh || !client) return null;
    const fresh = await ownerTokenFrom(
      this.options.fetch,
      this.options.web,
      {
        client_id: client.id,
        client_secret: client.secret,
        grant_type: 'refresh_token',
        refresh_token: held.refresh,
      },
      this.clock(),
    );
    if (!fresh) return null;
    keepOwnerToken(this.options.blobs, fresh);
    return fresh.token;
  }

  private noApp(): { ok: false; error: BrowseError } {
    return {
      ok: false,
      error: { reason: 'no_credential', message: 'Set up the relay’s GitHub App first.' },
    };
  }

  private noAccount(): { ok: false; error: BrowseError } {
    return {
      ok: false,
      error: { reason: 'no_credential', message: 'That GitHub account isn’t kept here any more.' },
    };
  }
}
