/**
 * An in-memory git remote and transport (T50 G1, #149): what the engine's tests and property
 * runs use. It keeps git's rules that matter to the engine: commits form a history, a push is a
 * fast-forward or rejected, blob ids are git's (`git hash-object`), and a clone knows only the
 * commits it fetched. Faults can be injected: a refused push, a crash before or after a push.
 */
import { gitBlobSha } from '@penmoss/core/mirror';
import {
  GitTransportError,
  type CommitInfo,
  type GitTransport,
  type PushOutcome,
} from './transport';

interface StoredCommit extends CommitInfo {
  /** Every file in the repository: path → blob id. */
  readonly tree: ReadonlyMap<string, string>;
}

export class MemoryRemote {
  readonly blobs = new Map<string, Uint8Array>();
  readonly commits = new Map<string, StoredCommit>();
  readonly branches = new Map<string, string>();
  private seq = 0;
  /** Set to make every push refused, as a protected branch or a failed login would. */
  refuse: { code: 'auth' | 'protected' | 'rules'; message: string } | null = null;

  async putBlob(bytes: Uint8Array): Promise<string> {
    const id = await gitBlobSha(bytes);
    if (!this.blobs.has(id)) this.blobs.set(id, bytes.slice());
    return id;
  }

  async putCommit(
    parent: string | null,
    tree: ReadonlyMap<string, string>,
    message: string,
    author = { name: 'Penmoss', email: 'penmoss@example.invalid' },
    at = 0,
  ): Promise<string> {
    const text = JSON.stringify([parent, [...tree].sort(), message, author, at, ++this.seq]);
    const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text));
    const id = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
    this.commits.set(id, { id, parents: parent ? [parent] : [], author, at, message, tree });
    return id;
  }

  /** Someone else's commit (a colleague's push), straight onto the branch. */
  async commitAs(
    branch: string,
    files: Record<string, string | null>,
    message = 'Code change',
  ): Promise<string> {
    const head = this.branches.get(branch) ?? null;
    const tree = new Map(head ? this.commits.get(head)!.tree : []);
    for (const [path, text] of Object.entries(files)) {
      if (text === null) tree.delete(path);
      else tree.set(path, await this.putBlob(new TextEncoder().encode(text)));
    }
    const id = await this.putCommit(head, tree, message, {
      name: 'A Colleague',
      email: 'colleague@example.invalid',
    });
    this.branches.set(branch, id);
    return id;
  }

  /** Every commit of a branch, oldest first (first parents). */
  history(branch: string): StoredCommit[] {
    const out: StoredCommit[] = [];
    for (let id = this.branches.get(branch) ?? null; id;) {
      const commit = this.commits.get(id)!;
      out.push(commit);
      id = commit.parents[0] ?? null;
    }
    return out.reverse();
  }

  read(commit: string, path: string): Uint8Array | null {
    const blob = this.commits.get(commit)?.tree.get(path);
    return blob === undefined ? null : (this.blobs.get(blob) ?? null);
  }
}

export interface MemoryTransportOptions {
  readonly remote: MemoryRemote;
  readonly branch: string;
  readonly root: string;
  readonly author?: { readonly name: string; readonly email: string };
  readonly clock?: () => number;
}

/** One clone's view of a `MemoryRemote`. */
export class MemoryTransport implements GitTransport {
  readonly root: string;
  /** Commits this clone has fetched or made (a clone knows nothing else). */
  readonly known = new Set<string>();
  /** Test hooks around a push: throw from them to crash there. */
  beforePush: ((commit: string) => void | Promise<void>) | null = null;
  afterPush: ((commit: string) => void | Promise<void>) | null = null;
  readonly stats = { fetches: 0, pushes: 0, rejected: 0, commits: 0, reads: 0, heads: 0 };

  constructor(private readonly options: MemoryTransportOptions) {
    this.root = options.root;
  }

  get remote(): MemoryRemote {
    return this.options.remote;
  }

  fetch(): Promise<string | null> {
    this.stats.fetches++;
    const head = this.options.remote.branches.get(this.options.branch) ?? null;
    // Fetching brings the head and everything before it.
    for (let id = head; id && !this.known.has(id);) {
      this.known.add(id);
      id = this.options.remote.commits.get(id)!.parents[0] ?? null;
    }
    return Promise.resolve(head);
  }

  /** The branch's head at the remote now, without fetching anything (`ls-remote`). */
  remoteHead(): Promise<string | null> {
    this.stats.heads++;
    return Promise.resolve(this.options.remote.branches.get(this.options.branch) ?? null);
  }

  list(head: string): Promise<ReadonlyMap<string, string>> {
    const tree = this.commitOf(head).tree;
    const out = new Map<string, string>();
    for (const [path, blob] of tree) if (path.startsWith(this.root)) out.set(path, blob);
    return Promise.resolve(out);
  }

  sizes(head: string, paths: readonly string[]): Promise<ReadonlyMap<string, number>> {
    const tree = this.commitOf(head).tree;
    const out = new Map<string, number>();
    for (const path of paths) {
      const blob = tree.get(path);
      if (blob !== undefined) out.set(path, this.options.remote.blobs.get(blob)?.byteLength ?? 0);
    }
    return Promise.resolve(out);
  }

  changed(from: string, to: string): Promise<readonly string[] | null> {
    if (!this.known.has(from) || !this.options.remote.commits.has(from)) {
      return Promise.resolve(null);
    }
    const a = this.commitOf(from).tree;
    const b = this.commitOf(to).tree;
    const out = new Set<string>();
    for (const [path, blob] of a) if (b.get(path) !== blob) out.add(path);
    for (const [path, blob] of b) if (a.get(path) !== blob) out.add(path);
    return Promise.resolve([...out].filter((path) => path.startsWith(this.root)).sort());
  }

  read(head: string, paths: readonly string[]): Promise<ReadonlyMap<string, Uint8Array>> {
    this.stats.reads += paths.length;
    const tree = this.commitOf(head).tree;
    const out = new Map<string, Uint8Array>();
    for (const path of paths) {
      const blob = tree.get(path);
      if (blob !== undefined) out.set(path, this.options.remote.blobs.get(blob)!);
    }
    return Promise.resolve(out);
  }

  async commit(
    head: string | null,
    changes: ReadonlyMap<string, Uint8Array | null>,
    message: string,
  ): Promise<string | null> {
    for (const path of changes.keys()) {
      if (!path.startsWith(this.root)) {
        throw new GitTransportError(
          'git',
          `Refusing to write outside ${this.root || '/'}: ${path}`,
        );
      }
    }
    const before = head ? this.commitOf(head).tree : new Map<string, string>();
    const tree = new Map(before);
    for (const [path, bytes] of changes) {
      if (bytes === null) tree.delete(path);
      else tree.set(path, await this.options.remote.putBlob(bytes));
    }
    if (head && sameTree(before, tree)) return null;
    const id = await this.options.remote.putCommit(
      head,
      tree,
      message,
      this.options.author,
      this.options.clock?.() ?? 0,
    );
    this.known.add(id);
    this.stats.commits++;
    return id;
  }

  async push(commit: string): Promise<PushOutcome> {
    await this.beforePush?.(commit);
    const remote = this.options.remote;
    if (remote.refuse) {
      throw new GitTransportError(remote.refuse.code, remote.refuse.message, remote.refuse.message);
    }
    this.stats.pushes++;
    const head = remote.branches.get(this.options.branch) ?? null;
    const parent = this.commitOf(commit).parents[0] ?? null;
    if (parent !== head) {
      this.stats.rejected++;
      return 'rejected';
    }
    remote.branches.set(this.options.branch, commit);
    await this.afterPush?.(commit);
    return 'pushed';
  }

  log(
    options: { readonly paths?: readonly string[]; readonly limit?: number } = {},
  ): Promise<CommitInfo[]> {
    const out: CommitInfo[] = [];
    const head = this.options.remote.branches.get(this.options.branch) ?? null;
    const touches = (commit: StoredCommit) => {
      const parent: ReadonlyMap<string, string> = commit.parents[0]
        ? this.commitOf(commit.parents[0]).tree
        : new Map<string, string>();
      const prefixes = options.paths ?? [this.root];
      const differs = (path: string) => parent.get(path) !== commit.tree.get(path);
      for (const path of new Set([...parent.keys(), ...commit.tree.keys()])) {
        if (prefixes.some((prefix) => path.startsWith(prefix)) && differs(path)) return true;
      }
      return false;
    };
    for (let id = head; id;) {
      const commit = this.commitOf(id);
      if (touches(commit)) {
        out.push({
          id: commit.id,
          parents: commit.parents,
          author: commit.author,
          at: commit.at,
          message: commit.message,
        });
        if (options.limit !== undefined && out.length >= options.limit) break;
      }
      id = commit.parents[0] ?? null;
    }
    return Promise.resolve(out);
  }

  readAt(commit: string, path: string): Promise<Uint8Array | null> {
    return Promise.resolve(this.options.remote.read(commit, path));
  }

  private commitOf(id: string): StoredCommit {
    const commit = this.options.remote.commits.get(id);
    if (!commit) throw new GitTransportError('git', `Unknown commit ${id}`);
    return commit;
  }
}

function sameTree(a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [path, blob] of a) if (b.get(path) !== blob) return false;
  return true;
}
