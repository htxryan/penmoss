/**
 * How the engine reaches git (T50, A824; #147's A744). The engine never sees how: the CLI and the
 * Mac app spawn system git (`./node`), Android will move bytes through JGit, and the tests use
 * `MemoryTransport`. Every call is about one notebook target: a remote, a branch and `root`
 * (`<dir>/`, or '' for the repository's top).
 *
 * Commits are built on the remote's head (A822): no merge, no rebase and no working tree. A push
 * is a fast-forward or nothing; a rejected one makes the engine fetch and build again.
 */

/** A commit's identity and what `History` (G6) shows of it. */
export interface CommitInfo {
  readonly id: string;
  readonly parents: readonly string[];
  readonly author: { readonly name: string; readonly email: string };
  /** Epoch ms. */
  readonly at: number;
  readonly message: string;
}

export type PushOutcome = 'pushed' | 'rejected';

export interface GitTransport {
  /** The notebook's directory in the repository: '' or `docs/notes/`. */
  readonly root: string;
  /** Fetches the branch; its head, or null while the branch does not exist (a new notebook). */
  fetch(): Promise<string | null>;
  /** Every file under `root` at `head`: path (from the repository's top) → git blob id. */
  list(head: string): Promise<ReadonlyMap<string, string>>;
  /** The sizes in bytes of `paths` at `head`, so a huge log is never loaded (A822); optional. */
  sizes?(head: string, paths: readonly string[]): Promise<ReadonlyMap<string, number>>;
  /** Paths under `root` that differ between two commits; null when `from` is not known here. */
  changed(from: string, to: string): Promise<readonly string[] | null>;
  /** The bytes of `paths` at `head`, fetched in one go (a path not there is left out). */
  read(head: string, paths: readonly string[]): Promise<ReadonlyMap<string, Uint8Array>>;
  /**
   * A commit on top of `head` (null: the branch's first) that sets each path to its bytes, or
   * removes it (null). Every path must be under `root`. Null when the tree would not change.
   */
  commit(
    head: string | null,
    changes: ReadonlyMap<string, Uint8Array | null>,
    message: string,
  ): Promise<string | null>;
  /** Makes `commit` the branch's head if that is a fast-forward; 'rejected' when it is not. */
  push(commit: string): Promise<PushOutcome>;
  /** The commits that touched `paths` (all of `root` when absent), newest first. */
  log(options?: {
    readonly paths?: readonly string[];
    readonly limit?: number;
  }): Promise<CommitInfo[]>;
  /** A file's bytes at any commit (History, G6). */
  readAt(commit: string, path: string): Promise<Uint8Array | null>;
  /**
   * The branch's head at the remote now, cheaply and without fetching (T60, A1067: an
   * `ls-remote`); null when the branch does not exist there. Optional: the channel uses it to
   * sync only when the head moved.
   */
  remoteHead?(): Promise<string | null>;
  /** Housekeeping after a sync (A822: the clone's `git gc --auto`); optional. */
  maintain?(): Promise<void>;
}

/** Why a git call failed, for Status and the CLI (A824: refusals keep the host's message). */
export type GitErrorCode =
  /** Credentials missing or refused. */
  | 'auth'
  /** The host is unreachable, or the connection failed. */
  | 'network'
  /** The repository or branch does not exist, or this account cannot see it. */
  | 'not_found'
  /** SSH could not verify the host's key (an unknown or changed host). */
  | 'host_key'
  /** git's configuration signs commits, and signing failed (a locked or missing key). */
  | 'signing'
  /** A protected branch refused the push. */
  | 'protected'
  /** Repository rules, push rules or secret scanning refused the push. */
  | 'rules'
  /** A server hook (or another policy) refused the push. */
  | 'refused'
  /** git is not installed (or, on a Mac, the command-line tools are not). */
  | 'git_missing'
  /** A git command ran out of time and was stopped. */
  | 'timeout'
  /** git's configuration sends the push to another URL than the notebook's remote (a rewrite). */
  | 'redirected'
  /** Anything else git reported. */
  | 'git';

export class GitTransportError extends Error {
  constructor(
    readonly code: GitErrorCode,
    message: string,
    /** What the host said (`remote:` lines), when it said something. */
    readonly hostMessage?: string,
  ) {
    super(message);
    this.name = 'GitTransportError';
  }
}

/**
 * A remote on this device (#174 review, F9): a path, `file://`, or a host that is the loopback
 * (`localhost`, `127.x.x.x`, `::1`). The network being down says nothing about reaching it, so
 * a sync to it is tried whatever `navigator.onLine` says.
 */
export function isLocalRemote(remote: string): boolean {
  const text = remote.trim();
  if (text.startsWith('/') || /^file:/i.test(text)) return true;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    // A URL, read as a URL is (#174 delta review): `https://evil.com#@127.0.0.1/x` is evil.com.
    try {
      return isLoopbackHost(new URL(text).hostname);
    } catch {
      return false;
    }
  }
  // scp-like, as git reads it: `[user@]host:path`, a plain user and a plain host.
  const scp = /^(?:[A-Za-z0-9._~-]+@)?([A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\]):(?!\/\/)/.exec(text);
  return scp ? isLoopbackHost(scp[1]!) : false;
}

/** `localhost`, `127.x.x.x` or `::1`, with or without brackets or a port. */
export function isLoopbackHost(given: string): boolean {
  let host = given.trim().toLowerCase();
  const bracketed = /^\[([^\]]*)\](?::\d+)?$/.exec(host);
  if (bracketed) host = bracketed[1]!;
  else if (!host.includes('::')) host = host.replace(/:\d+$/, '');
  return host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host);
}

/**
 * GitHub's GH007 (#170 F6): the person's GitHub account keeps its email private and blocks
 * pushes that would show it, and the commits carry that email. Every push is refused until the
 * commits use another address, so the message says which one, and where to set it (`where`: the
 * client's own place for this notebook's commit identity). Null for any other refusal.
 */
export function privateEmailAdvice(said: string | null | undefined, where: string): string | null {
  if (!said || !/GH007|would publish a private email|email privacy restrictions/i.test(said)) {
    return null;
  }
  return `GitHub refused the push: its commits would make your private email address public (GH007). Commit as your GitHub no-reply address instead, the one ending in @users.noreply.github.com in GitHub's Settings → Emails: ${where}. The commits waiting are made again with it at the next sync; nothing is lost.`;
}
