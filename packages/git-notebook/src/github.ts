/**
 * A git notebook over GitHub's REST API (T55, D48): what the relay uses where there is no git to
 * run (a Cloudflare Worker). Every `GitTransport` call maps onto the Git Data API: a ref for
 * `fetch`, a recursive tree for `list` and `sizes`, blobs for `read`, a new tree and commit for
 * `commit`, and a ref update without force for `push`. GitHub refuses a non-fast-forward, which is
 * exactly `rejected`, and the engine fetches and builds again (A822).
 *
 * Platform-free: only `fetch`, `atob` and `btoa`. Blobs are content-addressed, so what one call
 * read is kept by id for the next.
 */
import {
  GitTransportError,
  type CommitInfo,
  type GitErrorCode,
  type GitTransport,
  type PushOutcome,
} from './transport';

export interface GitHubAuthor {
  readonly name: string;
  readonly email: string;
}

export interface GitHubTransportOptions {
  /** `owner/name` of the notes repository. */
  readonly repository: string;
  readonly branch: string;
  /** The notebook's directory in the repository: '' or `docs/notes/`. */
  readonly root: string;
  /** A token that can read and write the repository's contents (asked before every call). */
  readonly token: () => Promise<string>;
  /** Who commits: asked before each commit. */
  readonly author: GitHubAuthor | (() => Promise<GitHubAuthor>);
  /** The API's origin (default `https://api.github.com`; tests point it at a fake). */
  readonly api?: string;
  /** The fetch to call (default the global one; tests pass a fake GitHub). */
  readonly fetch?: typeof fetch;
  /** Blob reads at once (default 8). */
  readonly concurrency?: number;
  readonly clock?: () => number;
}

/** GitHub's compare lists at most this many files; at it, the list may be cut short. */
export const COMPARE_FILE_LIMIT = 300;
/** Commits one `log` call reads at most when it is given no limit. */
export const LOG_MAX_COMMITS = 1000;
const PAGE = 100;
const OLD_TREES = 16;

interface TreeEntry {
  readonly path: string;
  readonly type: string;
  readonly sha: string;
  readonly size?: number;
}

interface Listed {
  readonly head: string;
  readonly tree: string;
  /** Every blob under `root`: path → id and size. */
  readonly files: ReadonlyMap<string, { readonly sha: string; readonly size: number }>;
}

const encodePath = (path: string) => path.split('/').map(encodeURIComponent).join('/');

export function toBase64(bytes: Uint8Array): string {
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(text);
}

export function fromBase64(text: string): Uint8Array {
  const raw = atob(text.replace(/\s/g, ''));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export class GitHubTransport implements GitTransport {
  readonly root: string;
  private readonly api: string;
  private readonly call: typeof fetch;
  private readonly blobs = new Map<string, Uint8Array>();
  private listed: Listed | null = null;
  private readonly trees = new Map<string, string>();
  /** Recent trees History read (tree id → path → blob id), newest last. */
  private readonly oldTrees = new Map<string, ReadonlyMap<string, string>>();
  readonly stats = { requests: 0, blobReads: 0 };

  constructor(private readonly options: GitHubTransportOptions) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(options.repository)) {
      throw new GitTransportError('not_found', `Not a GitHub repository: ${options.repository}`);
    }
    if (options.root && !options.root.endsWith('/')) {
      throw new GitTransportError('git', `A notebook directory ends with /: ${options.root}`);
    }
    this.root = options.root;
    this.api = (options.api ?? 'https://api.github.com').replace(/\/$/, '');
    this.call = options.fetch ?? ((input, init) => fetch(input, init));
  }

  private get repo(): string {
    return `${this.api}/repos/${this.options.repository}`;
  }

  /** One API call: the response when its status is in `ok`, else a typed error. */
  private async request(
    path: string,
    init: { method?: string; body?: unknown; accept?: string } = {},
    ok: readonly number[] = [200, 201],
  ): Promise<Response> {
    const token = await this.options.token();
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      accept: init.accept ?? 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'penmoss-relay',
    };
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    let response: Response;
    this.stats.requests++;
    try {
      response = await this.call(path.startsWith('http') ? path : `${this.repo}${path}`, {
        method: init.method ?? 'GET',
        headers,
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      });
    } catch (error) {
      throw new GitTransportError(
        'network',
        `GitHub could not be reached: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (ok.includes(response.status)) return response;
    throw await this.failure(response);
  }

  private async failure(response: Response): Promise<GitTransportError> {
    const text = await response.text().catch(() => '');
    let message = text;
    try {
      const parsed = JSON.parse(text) as { message?: unknown };
      if (typeof parsed.message === 'string') message = parsed.message;
    } catch {
      // Not JSON: keep the text.
    }
    const said = message.slice(0, 500);
    let code: GitErrorCode = 'git';
    if (response.status === 401) code = 'auth';
    else if (response.status === 403 && /rate limit/i.test(message)) code = 'network';
    else if (response.status === 403) code = 'auth';
    else if (response.status === 404) code = 'not_found';
    else if (response.status >= 500) code = 'network';
    else if (/protected branch/i.test(message)) code = 'protected';
    else if (/rule|secret/i.test(message)) code = 'rules';
    return new GitTransportError(code, `GitHub answered ${response.status}: ${said}`, said);
  }

  private async json<T>(path: string): Promise<T> {
    return (await (await this.request(path)).json()) as T;
  }

  async fetch(): Promise<string | null> {
    // 409: the repository has no commits yet. 404: no such branch (or no access: the next call
    // that needs the repository says which).
    const response = await this.request(
      `/git/ref/heads/${encodePath(this.options.branch)}`,
      {},
      [200, 404, 409],
    );
    if (response.status !== 200) {
      await response.body?.cancel();
      // The repository itself must be there: a 404 for it is `not_found`, thrown here.
      if (response.status === 404) await (await this.request('')).body?.cancel();
      return null;
    }
    const ref = (await response.json()) as { object?: { sha?: unknown } };
    return typeof ref.object?.sha === 'string' ? ref.object.sha : null;
  }

  private async treeOf(commit: string): Promise<string> {
    const known = this.trees.get(commit);
    if (known) return known;
    const data = await this.json<{ tree: { sha: string } }>(`/git/commits/${commit}`);
    this.trees.set(commit, data.tree.sha);
    return data.tree.sha;
  }

  private async listing(head: string): Promise<Listed> {
    if (this.listed?.head === head) return this.listed;
    const tree = await this.treeOf(head);
    const data = await this.json<{ tree: TreeEntry[]; truncated?: boolean }>(
      `/git/trees/${tree}?recursive=1`,
    );
    if (data.truncated) {
      throw new GitTransportError(
        'git',
        'The repository is too large for GitHub to list in one call; the relay cannot serve it.',
      );
    }
    const files = new Map<string, { sha: string; size: number }>();
    for (const entry of data.tree) {
      if (entry.type === 'blob' && entry.path.startsWith(this.root)) {
        files.set(entry.path, { sha: entry.sha, size: entry.size ?? 0 });
      }
    }
    this.listed = { head, tree, files };
    return this.listed;
  }

  async list(head: string): Promise<ReadonlyMap<string, string>> {
    const { files } = await this.listing(head);
    return new Map([...files].map(([path, file]) => [path, file.sha]));
  }

  async sizes(head: string, paths: readonly string[]): Promise<ReadonlyMap<string, number>> {
    const { files } = await this.listing(head);
    const out = new Map<string, number>();
    for (const path of paths) {
      const file = files.get(path);
      if (file) out.set(path, file.size);
    }
    return out;
  }

  async changed(from: string, to: string): Promise<readonly string[] | null> {
    const response = await this.request(
      `/compare/${from}...${to}?per_page=${PAGE}`,
      {},
      [200, 404],
    );
    if (response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    const data = (await response.json()) as {
      status?: string;
      files?: { filename: string; previous_filename?: string }[];
    };
    // Only a straight line from `from` to `to` lists the right files; a list GitHub may have cut
    // short is not trusted either. Null makes the engine compare the trees itself.
    if (data.status !== 'ahead' && data.status !== 'identical') return null;
    const files = data.files ?? [];
    if (files.length >= COMPARE_FILE_LIMIT) return null;
    const out = new Set<string>();
    for (const file of files) {
      out.add(file.filename);
      if (file.previous_filename) out.add(file.previous_filename);
    }
    return [...out].filter((path) => path.startsWith(this.root)).sort();
  }

  private async blob(sha: string): Promise<Uint8Array> {
    const held = this.blobs.get(sha);
    if (held) return held;
    this.stats.blobReads++;
    const data = await this.json<{ content: string; encoding: string }>(`/git/blobs/${sha}`);
    const bytes =
      data.encoding === 'base64'
        ? fromBase64(data.content)
        : new TextEncoder().encode(data.content);
    this.blobs.set(sha, bytes);
    return bytes;
  }

  async read(head: string, paths: readonly string[]): Promise<ReadonlyMap<string, Uint8Array>> {
    const { files } = await this.listing(head);
    const wanted = paths.flatMap((path) => {
      const file = files.get(path);
      return file ? [[path, file.sha] as const] : [];
    });
    const out = new Map<string, Uint8Array>();
    let next = 0;
    const worker = async () => {
      while (next < wanted.length) {
        const [path, sha] = wanted[next++]!;
        out.set(path, await this.blob(sha));
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(this.options.concurrency ?? 8, wanted.length) }, worker),
    );
    return out;
  }

  async commit(
    head: string | null,
    changes: ReadonlyMap<string, Uint8Array | null>,
    message: string,
  ): Promise<string | null> {
    for (const path of changes.keys()) {
      if (!path.startsWith(this.root) || path.split('/').some((p) => p === '..' || p === '')) {
        throw new GitTransportError(
          'git',
          `Refusing to write outside ${this.root || '/'}: ${path}`,
        );
      }
    }
    const before = head ? await this.listing(head) : null;
    const entries: { path: string; mode: string; type: string; sha: string | null }[] = [];
    for (const [path, bytes] of changes) {
      if (bytes === null) {
        // Removing a path the tree does not have is refused by GitHub: nothing to do.
        if (before?.files.has(path))
          entries.push({ path, mode: '100644', type: 'blob', sha: null });
        continue;
      }
      const made = (await (
        await this.request('/git/blobs', {
          method: 'POST',
          body: { content: toBase64(bytes), encoding: 'base64' },
        })
      ).json()) as { sha: string };
      this.blobs.set(made.sha, bytes.slice());
      if (before?.files.get(path)?.sha === made.sha) continue;
      entries.push({ path, mode: '100644', type: 'blob', sha: made.sha });
    }
    if (head && entries.length === 0) return null;
    const tree = (await (
      await this.request('/git/trees', {
        method: 'POST',
        body: { ...(before ? { base_tree: before.tree } : {}), tree: entries },
      })
    ).json()) as { sha: string };
    if (before && tree.sha === before.tree) return null;
    const author =
      typeof this.options.author === 'function' ? await this.options.author() : this.options.author;
    const commit = (await (
      await this.request('/git/commits', {
        method: 'POST',
        body: {
          message,
          tree: tree.sha,
          parents: head ? [head] : [],
          author: {
            name: author.name,
            email: author.email,
            date: new Date((this.options.clock ?? Date.now)()).toISOString(),
          },
        },
      })
    ).json()) as { sha: string };
    this.trees.set(commit.sha, tree.sha);
    return commit.sha;
  }

  async push(commit: string): Promise<PushOutcome> {
    const branch = encodePath(this.options.branch);
    const update = await this.request(
      `/git/refs/heads/${branch}`,
      { method: 'PATCH', body: { sha: commit, force: false } },
      [200, 422],
    );
    if (update.status === 200) {
      await update.body?.cancel();
      return 'pushed';
    }
    const refusal = await this.failure(update);
    if (/fast.?forward/i.test(refusal.message)) return 'rejected';
    if (!/reference does not exist|not found/i.test(refusal.message)) throw refusal;
    // A new branch: make it, unless someone else made it first.
    const made = await this.request(
      '/git/refs',
      { method: 'POST', body: { ref: `refs/heads/${this.options.branch}`, sha: commit } },
      [201, 422],
    );
    if (made.status === 201) {
      await made.body?.cancel();
      return 'pushed';
    }
    const exists = await this.failure(made);
    if (/already exists/i.test(exists.message)) return 'rejected';
    throw exists;
  }

  async log(
    options: { readonly paths?: readonly string[]; readonly limit?: number } = {},
  ): Promise<CommitInfo[]> {
    const head = await this.fetch();
    if (!head) return [];
    const limit = options.limit ?? LOG_MAX_COMMITS;
    const paths = options.paths ?? (this.root ? [this.root.slice(0, -1)] : [undefined]);
    const seen = new Map<string, CommitInfo>();
    for (const path of paths) {
      for (let page = 1; (page - 1) * PAGE < limit; page++) {
        const query = new URLSearchParams({
          sha: head,
          per_page: String(Math.min(PAGE, limit)),
          page: String(page),
        });
        if (path) query.set('path', path);
        const commits = await this.json<
          {
            sha: string;
            parents: { sha: string }[];
            commit: { author: { name: string; email: string; date: string }; message: string };
          }[]
        >(`/commits?${query}`);
        for (const each of commits) {
          seen.set(each.sha, {
            id: each.sha,
            parents: each.parents.map((parent) => parent.sha),
            author: { name: each.commit.author.name, email: each.commit.author.email },
            at: Date.parse(each.commit.author.date),
            message: each.commit.message.trimEnd(),
          });
        }
        if (commits.length < Math.min(PAGE, limit)) break;
      }
    }
    return [...seen.values()].sort((a, b) => b.at - a.at).slice(0, limit);
  }

  async readAt(commit: string, path: string): Promise<Uint8Array | null> {
    const tree = await this.treeOf(commit);
    let files = this.oldTrees.get(tree);
    if (!files) {
      const data = await this.json<{ tree: TreeEntry[] }>(`/git/trees/${tree}?recursive=1`);
      files = new Map(data.tree.filter((e) => e.type === 'blob').map((e) => [e.path, e.sha]));
      this.oldTrees.set(tree, files);
      if (this.oldTrees.size > OLD_TREES) this.oldTrees.delete(this.oldTrees.keys().next().value!);
    }
    const sha = files.get(path);
    return sha ? this.blob(sha) : null;
  }

  /** Whether GitHub says the repository is private (A841: a public one is never written to). */
  async isPrivate(): Promise<boolean> {
    const data = await this.json<{ private?: unknown }>('');
    return data.private === true;
  }
}
