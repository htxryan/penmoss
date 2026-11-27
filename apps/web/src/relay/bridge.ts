/**
 * The relay's bridge for the app's Add Notebook (A1701): `window.penmossDesktop` as the Mac's
 * preload gives it, with only what Add Notebook uses (its git list and add, GitHub browsing, and
 * the GitHub accounts of Manage GitHub Accounts), each a call to the relay
 * (`apps/relay/src/add-bridge.ts`). The flow and its screens are the app's, unchanged.
 */
import type {
  DesktopGit,
  DesktopGitHubBrowse,
  DesktopGitHubToken,
  DesktopGitHubTokenStatus,
  GitAddResult,
  GitAnswer,
  GitHubAnswer,
  GitHubOwner,
  GitHubRepo,
  GitNotebookInfo,
  PenmossDesktop,
  RepoFolders,
  RepoList,
} from '../desktop/bridge';

/** A served notebook as the relay lists it. */
export interface RelayNotebook {
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

/** One bridge call to the relay, with the page's form token; null when it fails. */
export type RelayCall = <T>(name: string, args: readonly unknown[]) => Promise<T | null>;

export function relayCall(csrf: string): RelayCall {
  return async <T>(name: string, args: readonly unknown[]) => {
    try {
      const response = await fetch('/notebooks/add/call', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'x-penmoss-csrf': csrf },
        body: JSON.stringify({ name, args }),
      });
      const body = (await response.json().catch(() => null)) as { answer?: T } | null;
      return body?.answer ?? null;
    } catch {
      return null;
    }
  };
}

/** The relay's notebook as the Mac's list has one. */
export function notebookInfo(each: RelayNotebook): GitNotebookInfo {
  return {
    localId: each.notebookId,
    notebookId: each.notebookId,
    name: each.name,
    create: false,
    remote: each.remote,
    repository: each.repository,
    host: 'github.com',
    branch: each.branch,
    dir: each.dir,
    pushDelayS: 5,
    pullEveryMin: 0,
    sign: false,
    author: null,
    hasToken: each.hasToken,
    filterIgnored: false,
  };
}

/** `account` as the bridge passes it: left out for the App, else named. */
const as = (account: string | null | undefined) => (account === undefined ? [] : [account]);

const refused = <T>(): Promise<GitAnswer<T> | null> =>
  Promise.resolve({
    ok: false,
    error: { code: 'relay', message: 'A relay can’t do this.' },
  });

/** `window.penmossDesktop` on the relay's Add Notebook page. */
export function relayDesktop(call: RelayCall): {
  readonly desktop: PenmossDesktop;
  readonly git: DesktopGit;
  /** The relay's notebooks with their sync state. */
  readonly notebooks: () => Promise<readonly RelayNotebook[]>;
} {
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const listener of listeners) listener();
  };
  const accountListeners = new Set<() => void>();
  const accountsChanged = () => {
    for (const listener of accountListeners) listener();
  };
  const notebooks = async () => (await call<RelayNotebook[]>('list', [])) ?? [];
  const github: DesktopGitHubBrowse = {
    repos: (account) => call<GitHubAnswer<RepoList>>('repos', as(account)),
    folders: (fullName, branch, account) =>
      call<GitHubAnswer<RepoFolders>>('folders', [fullName, branch, ...as(account)]),
    owners: (account) => call<GitHubAnswer<readonly GitHubOwner[]>>('owners', as(account)),
    create: (owner, name, account) =>
      call<GitHubAnswer<GitHubRepo>>('create', [owner, name, ...as(account)]),
    gitLogin: () => call<string>('gitLogin', []),
    // The relay signs in with its own GitHub App: no device sign-in of Penmoss's here.
    signIn: {
      status: () =>
        Promise.resolve({ available: false, state: { state: 'idle' as const }, login: null }),
      start: () => Promise.resolve(null),
      cancel: () => Promise.resolve(null),
      onChange: () => () => undefined,
    },
  };
  const git = {
    list: async () => (await notebooks()).map(notebookInfo),
    add: async (input) => {
      const answer = await call<
        | GitAnswer<{ kind: 'needs-name' }>
        | GitAnswer<{ kind: 'added'; notebook: RelayNotebook; created: boolean }>
      >('add', [input]);
      if (answer?.ok && answer.value.kind === 'added') {
        changed();
        const result: GitAddResult = {
          kind: 'added',
          created: answer.value.created,
          notebook: notebookInfo(answer.value.notebook),
        };
        return { ok: true, value: result };
      }
      return answer as GitAnswer<GitAddResult> | null;
    },
    onChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    github,
    remove: refused,
    update: refused,
    setToken: refused,
    purgeCheck: refused,
    restoreCheck: refused,
    purgesToConfirm: refused,
    writerSecret: refused,
    op: refused,
    cancel: () => Promise.resolve(null),
    identity: () => Promise.resolve(null),
    agents: refused,
    disconnectAgent: refused,
    cli: () => Promise.resolve(null),
    installCli: refused,
    removeCli: refused,
  } satisfies DesktopGit;
  const githubToken: DesktopGitHubToken = {
    status: () => call<DesktopGitHubTokenStatus>('status', []),
    save: async (token) => {
      const answer = await call<
        | { ok: true; status: DesktopGitHubTokenStatus; note: string | null }
        | { ok: false; message: string }
      >('save', [token]);
      if (answer?.ok) accountsChanged();
      return answer;
    },
    remove: async (login) => {
      const answer = await call<{ ok: true; status: DesktopGitHubTokenStatus }>(
        'remove',
        as(login),
      );
      if (answer?.ok) accountsChanged();
      return answer;
    },
    onChange: (listener) => {
      accountListeners.add(listener);
      return () => accountListeners.delete(listener);
    },
  };
  return {
    desktop: { git, githubToken } as unknown as PenmossDesktop,
    git,
    notebooks,
  };
}
