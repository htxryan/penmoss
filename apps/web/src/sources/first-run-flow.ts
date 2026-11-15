/**
 * The first run's flow (First Run C, "One Step per Screen"; Ryan's review of #192, findings 2–4):
 * what each screen is, where a new notebook goes, and the words the screens share. The screens
 * are FirstRun.tsx and the FirstRun*.tsx beside it.
 */
import type {
  BrowseError,
  DesktopGitHubBrowse,
  GitAddResult,
  GitAnswer,
  GitHubOwner,
  GitHubRepo,
  GitHubVia,
  RepoFolders,
  RepoList,
} from '../desktop/bridge';

/** Start a new notebook, or open one that exists (1.2). */
export type Goal = 'new' | 'existing';

/** Where a notebook is added: a repository, its branch and folder ('' for the root). */
export interface Place {
  readonly remote: string;
  readonly branch: string;
  readonly dir: string;
  /** `owner/name` for a GitHub repository, or the address as typed. */
  readonly label: string;
  /** Picked through Penmoss's own GitHub sign-in (T82, A1171): the notebook gets its token. */
  readonly githubSignIn: boolean;
  /** The name a new notebook here is offered: the repository's, in words. */
  readonly suggested: string;
}

/** What the last screen (7.1) does. */
export type Setup =
  /** A repository Create New Repo just made: make the notebook at its root. */
  | { readonly kind: 'create'; readonly place: Place; readonly name: string }
  /** A new notebook in a repository or folder that holds none. */
  | { readonly kind: 'make'; readonly place: Place; readonly name: string }
  /** A notebook the repository holds already. */
  | { readonly kind: 'open'; readonly place: Place; readonly name: string }
  /** Paste a URL added it already (the address held a notebook): only the first sync is left. */
  | {
      readonly kind: 'added';
      readonly place: Place;
      readonly name: string;
      readonly notebookId: string;
    };

export type Screen =
  | { readonly at: 'welcome' }
  | { readonly at: 'goal' }
  | { readonly at: 'way' }
  | { readonly at: 'github'; readonly then: 'create' | 'list' }
  | { readonly at: 'create' }
  | { readonly at: 'list' }
  | { readonly at: 'repo'; readonly repo: GitHubRepo }
  | { readonly at: 'folder'; readonly repo: GitHubRepo }
  | { readonly at: 'url' }
  | { readonly at: 'git-missing' }
  | { readonly at: 'name'; readonly place: Place }
  | { readonly at: 'setup'; readonly setup: Setup };

/** GitHub as the flow knows it once a sign-in answered (2.2, 2.5). */
export interface Hub {
  readonly list: RepoList;
  readonly via: GitHubVia;
  /** Whose sign-in it is, when known. */
  readonly login: string | null;
  /** Where Create New Repo can make one; null when GitHub would not say. */
  readonly owners: readonly GitHubOwner[] | null;
}

/** One repository's folders, as the tree and its screens read them (4.2, 4.5–4.8). */
export type RepoRead =
  | { readonly state: 'loading' }
  | { readonly state: 'ready'; readonly folders: RepoFolders }
  | { readonly state: 'failed'; readonly message: string };

/** git.add, as the flow calls it: it holds the first run open while a notebook is set up. */
export type AddNotebook = (input: {
  readonly remote: string;
  readonly branch: string;
  readonly dir: string;
  readonly name?: string;
  readonly githubSignIn?: boolean;
}) => Promise<GitAnswer<GitAddResult> | null>;

/** Asks GitHub for the repositories and owners, with whatever sign-in main finds (2.1). */
export async function readHub(
  github: DesktopGitHubBrowse,
): Promise<{ ok: true; hub: Hub } | { ok: false; error: BrowseError }> {
  const answer = await github.repos().catch(() => null);
  if (!answer) {
    return { ok: false, error: { reason: 'github', message: 'This window cannot browse GitHub.' } };
  }
  if (!answer.ok) return { ok: false, error: answer.error };
  const owners = await github.owners().catch(() => null);
  const list = owners?.ok ? owners.value : null;
  let login = list?.find((each) => each.kind === 'user')?.login ?? null;
  if (!login && answer.via === 'penmoss') {
    login = (await github.signIn?.status().catch(() => null))?.login ?? null;
  }
  return { ok: true, hub: { list: answer.value, via: answer.via, login, owners: list } };
}

/** `field-notes` → `Field Notes`: a repository's name as a notebook's. */
export function nameFromRepo(name: string): string {
  return name
    .replace(/\.git$/, '')
    .split(/[-_.\s]+/)
    .filter(Boolean)
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join(' ')
    .slice(0, 80);
}

/** The repository name at the end of an address (`git@host:me/notes.git` → `notes`). */
export function repoNameOf(address: string): string {
  const path = address.trim().replace(/\/+$/, '');
  const last = path.split(/[/:]/).pop() ?? '';
  return last.replace(/\.git$/, '');
}

/** A GitHub repository picked from the list, at a folder. */
export function placeIn(repo: GitHubRepo, via: GitHubVia, dir = '', branch?: string): Place {
  return {
    remote: repo.cloneUrl,
    branch: branch ?? (repo.defaultBranch || 'main'),
    dir,
    label: repo.fullName,
    githubSignIn: via === 'penmoss',
    suggested: nameFromRepo(dir ? (dir.split('/').pop() ?? repo.name) : repo.name),
  };
}

/** A refusal from main in words: its own, and the host's when it sent some (A824). */
export function refusalWords(error: { message: string; hostMessage?: string }): string {
  return error.hostMessage ? `${error.message} The host said: ${error.hostMessage}` : error.message;
}

/** Where a folder is, as the cards and rows show it: Root, or `docs/notes/`. */
export const folderWords = (dir: string) => (dir ? `${dir}/` : 'Root');

/** The user docs page for the first run (the welcome's and the sign-in's Learn More). */
export const FIRST_RUN_DOCS = 'https://penmoss.app/docs/first-notebook/';
