/**
 * A fake GitHub REST API over a `MemoryRemote` (T55): the Git Data endpoints `GitHubTransport`
 * calls, with GitHub's answers where the transport depends on them (409 for an empty repository,
 * 422 for a push that is not a fast-forward or a branch that exists, compare's status and its
 * file cap). A `MemoryTransport` clone of the same remote is another writer, as a Mac would be.
 */
import { fromBase64, toBase64 } from '../../src/github';
import type { MemoryRemote } from '../../src';

export const FAKE_API = 'https://api.github.test';
export const FAKE_REPO = 'ryan/notes';
export const FAKE_TOKEN = 'fake-installation-token';

interface Options {
  /** Answer `GET /repos/:repo` with this visibility (default private). */
  private?: boolean;
  /** Cap compare's file list (GitHub's is 300). */
  compareLimit?: number;
}

export function fakeGitHub(remote: MemoryRemote, options: Options = {}) {
  const trees = new Map<string, ReadonlyMap<string, string>>();
  const calls: string[] = [];
  const settings = { private: options.private ?? true, token: FAKE_TOKEN };

  async function treeId(tree: ReadonlyMap<string, string>): Promise<string> {
    const text = JSON.stringify([...tree].sort());
    const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(`tree ${text}`));
    const id = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
    trees.set(id, tree);
    return id;
  }

  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  const problem = (status: number, message: string) => json(status, { message });

  /** Whether `ancestor` is on `of`'s first-parent line. */
  function isAncestor(ancestor: string, of: string): boolean {
    for (let id: string | null = of; id;) {
      if (id === ancestor) return true;
      id = remote.commits.get(id)?.parents[0] ?? null;
    }
    return false;
  }

  function touches(commit: string, path: string): boolean {
    const own = remote.commits.get(commit)!;
    const parent = own.parents[0]
      ? remote.commits.get(own.parents[0])!.tree
      : new Map<string, string>();
    const under = (p: string) => p === path || p.startsWith(`${path}/`);
    for (const [p, blob] of own.tree) if (under(p) && parent.get(p) !== blob) return true;
    for (const p of parent.keys()) if (under(p) && !own.tree.has(p)) return true;
    return false;
  }

  const handler = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    const method = init.method ?? 'GET';
    calls.push(`${method} ${url.pathname}${url.search}`);
    const auth = new Headers(init.headers).get('authorization');
    if (auth !== `Bearer ${settings.token}`) return problem(401, 'Bad credentials');
    const prefix = `/repos/${FAKE_REPO}`;
    if (!url.pathname.startsWith(prefix)) return problem(404, 'Not Found');
    const path = url.pathname.slice(prefix.length);
    const body = init.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : {};
    let match: RegExpExecArray | null;

    if (path === '' && method === 'GET') return json(200, { private: settings.private });

    if ((match = /^\/git\/ref\/heads\/(.+)$/.exec(path)) && method === 'GET') {
      if (remote.branches.size === 0) return problem(409, 'Git Repository is empty.');
      const head = remote.branches.get(decodeURIComponent(match[1]!));
      return head ? json(200, { object: { sha: head } }) : problem(404, 'Not Found');
    }
    if ((match = /^\/git\/commits\/([0-9a-f]+)$/.exec(path)) && method === 'GET') {
      const commit = remote.commits.get(match[1]!);
      if (!commit) return problem(404, 'Not Found');
      return json(200, { sha: commit.id, tree: { sha: await treeId(commit.tree) } });
    }
    if ((match = /^\/git\/trees\/([0-9a-f]+)$/.exec(path)) && method === 'GET') {
      const tree = trees.get(match[1]!);
      if (!tree) return problem(404, 'Not Found');
      return json(200, {
        sha: match[1],
        truncated: false,
        tree: [...tree].map(([p, sha]) => ({
          path: p,
          type: 'blob',
          sha,
          size: remote.blobs.get(sha)!.byteLength,
        })),
      });
    }
    if ((match = /^\/git\/blobs\/([0-9a-f]+)$/.exec(path)) && method === 'GET') {
      const bytes = remote.blobs.get(match[1]!);
      if (!bytes) return problem(404, 'Not Found');
      return json(200, { sha: match[1], content: toBase64(bytes), encoding: 'base64' });
    }
    if (path === '/git/blobs' && method === 'POST') {
      const sha = await remote.putBlob(fromBase64(String(body['content'])));
      return json(201, { sha });
    }
    if (path === '/git/trees' && method === 'POST') {
      const base = body['base_tree'] ? trees.get(body['base_tree'] as string) : new Map();
      if (!base) return problem(422, 'Invalid tree info');
      const tree = new Map(base);
      for (const entry of body['tree'] as { path: string; sha: string | null }[]) {
        if (entry.sha === null) {
          if (!tree.has(entry.path)) return problem(422, 'GitRPC::BadObjectState');
          tree.delete(entry.path);
        } else tree.set(entry.path, entry.sha);
      }
      return json(201, { sha: await treeId(tree) });
    }
    if (path === '/git/commits' && method === 'POST') {
      const tree = trees.get(String(body['tree']));
      if (!tree) return problem(422, 'Tree not found');
      const parents = body['parents'] as string[];
      const author = body['author'] as { name: string; email: string; date: string };
      const id = await remote.putCommit(
        parents[0] ?? null,
        tree,
        String(body['message']),
        { name: author.name, email: author.email },
        Date.parse(author.date),
      );
      return json(201, { sha: id });
    }
    if ((match = /^\/git\/refs\/heads\/(.+)$/.exec(path)) && method === 'PATCH') {
      const branch = decodeURIComponent(match[1]!);
      if (remote.refuse) return problem(422, 'Protected branch update failed for refs/heads/main.');
      const head = remote.branches.get(branch);
      if (!head) return problem(422, 'Reference does not exist');
      const sha = String(body['sha']);
      if (!isAncestor(head, sha)) return problem(422, 'Update is not a fast forward');
      remote.branches.set(branch, sha);
      return json(200, { object: { sha } });
    }
    if (path === '/git/refs' && method === 'POST') {
      const branch = String(body['ref']).replace(/^refs\/heads\//, '');
      if (remote.branches.has(branch)) return problem(422, 'Reference already exists');
      remote.branches.set(branch, String(body['sha']));
      return json(201, { object: { sha: body['sha'] } });
    }
    if ((match = /^\/compare\/([0-9a-f]+)\.\.\.([0-9a-f]+)$/.exec(path)) && method === 'GET') {
      const [from, to] = [match[1]!, match[2]!];
      const a = remote.commits.get(from);
      const b = remote.commits.get(to);
      if (!a || !b) return problem(404, 'Not Found');
      const status = from === to ? 'identical' : isAncestor(from, to) ? 'ahead' : 'diverged';
      const files = new Set<string>();
      for (const [p, blob] of a.tree) if (b.tree.get(p) !== blob) files.add(p);
      for (const [p, blob] of b.tree) if (a.tree.get(p) !== blob) files.add(p);
      const listed = [...files].sort().slice(0, options.compareLimit ?? 300);
      return json(200, { status, files: listed.map((filename) => ({ filename })) });
    }
    if (path === '/commits' && method === 'GET') {
      const start = url.searchParams.get('sha');
      const only = url.searchParams.get('path');
      const perPage = Number(url.searchParams.get('per_page') ?? 30);
      const page = Number(url.searchParams.get('page') ?? 1);
      const line: string[] = [];
      for (let id = start; id; id = remote.commits.get(id)?.parents[0] ?? null) {
        if (!only || touches(id, only)) line.push(id);
      }
      return json(
        200,
        line.slice((page - 1) * perPage, page * perPage).map((id) => {
          const commit = remote.commits.get(id)!;
          return {
            sha: id,
            parents: commit.parents.map((sha) => ({ sha })),
            commit: {
              author: { ...commit.author, date: new Date(commit.at).toISOString() },
              message: commit.message,
            },
          };
        }),
      );
    }
    return problem(404, `Not Found: ${method} ${path}`);
  };

  return { fetch: handler, calls, settings };
}
