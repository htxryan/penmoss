/**
 * A fake of the GitHub calls repository browsing makes (T81, A1164): `GET /user`,
 * `/user/repos` (Link paging), `/user/orgs`, a branch's recursive tree, blobs, and
 * `POST /user/repos` / `/orgs/{org}/repos`. One token is accepted. Sign in with GitHub's device
 * flow (T82, A1172) too: `POST /login/device/code` and `/login/oauth/access_token`, scripted. The core is `handle`, so the
 * same fake answers as a `fetch` (unit tests, the web E2E's stand-in Mac) and over HTTP (`serve`,
 * the Electron E2E).
 */
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { BrowseFetch } from '../../src/github-browse';

export interface FakeBrowseRepo {
  readonly owner: string;
  readonly name: string;
  readonly visibility?: 'private' | 'public' | 'internal';
  readonly defaultBranch?: string;
  readonly pushedAt?: string | null;
  readonly canPush?: boolean;
  /** Defaults to `https://github.com/<owner>/<name>.git`. */
  readonly cloneUrl?: string;
  /**
   * The branch's files (path → text), read at each request; null or empty: no commit yet (409).
   * A function lets the web E2E read them from a real bare repository.
   */
  readonly files?:
    Readonly<Record<string, string>> | null | (() => Readonly<Record<string, string>> | null);
  /** GitHub's `size`; default 0 for an empty one, else 1. */
  readonly size?: number;
  readonly truncated?: boolean;
}

/** What a poll of the device flow answers: GitHub's errors, or the token. */
export type DevicePoll = 'pending' | 'slow_down' | 'denied' | 'expired' | 'token';

export interface FakeAnswer {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

export interface FakeRequest {
  readonly method: string;
  readonly path: string;
  readonly auth: string | null;
  readonly body: unknown;
}

const sha = (text: string) => createHash('sha1').update(text).digest('hex');

export class FakeGitHubBrowse {
  readonly requests: FakeRequest[] = [];
  repos: FakeBrowseRepo[] = [];
  orgs: string[] = [];
  /** The next answer, whatever is asked (a 401, a rate limit, a 422). */
  failNext: FakeAnswer | null = null;
  /** Makes a created repository's clone address (the web E2E makes a bare repository). */
  onCreate: ((owner: string, name: string) => string) | null = null;
  private blobs = new Map<string, string>();
  /** The device flow (A1172): the app's client id, the code shown, and what polls answer. */
  readonly device = {
    clientId: 'Iv1.e2e0penmoss',
    userCode: 'WDJB-MJHT',
    deviceCode: 'device-code-e2e',
    /** Seconds between polls GitHub asks for; the suites ask for very little. */
    interval: 0.05,
    expiresIn: 900,
    /** Answers for the next polls, in order; then `pending` until `approved`. */
    polls: [] as DevicePoll[],
    approved: false,
    codes: 0,
  };

  constructor(readonly options: { token: string; login: string; base?: string }) {}

  get base(): string {
    return this.options.base ?? 'https://api.github.test';
  }

  reset(): void {
    this.requests.length = 0;
    this.repos = [];
    this.orgs = [];
    this.failNext = null;
    this.blobs.clear();
    this.device.polls = [];
    this.device.approved = false;
    this.device.codes = 0;
  }

  /** The person approves the sign-in on GitHub: the next poll gets the token. */
  approve(): void {
    this.device.approved = true;
  }

  private deviceAnswer(path: string, origin: string, body: unknown): FakeAnswer | null {
    const json = (status: number, value: unknown): FakeAnswer => ({
      status,
      headers: {},
      body: value,
    });
    const form = new URLSearchParams(typeof body === 'string' ? body : '');
    if (path === '/login/device/code') {
      if (form.get('client_id') !== this.device.clientId) {
        return json(401, { error: 'incorrect_client_credentials' });
      }
      this.device.codes++;
      return json(200, {
        device_code: this.device.deviceCode,
        user_code: this.device.userCode,
        verification_uri: `${origin}/login/device`,
        expires_in: this.device.expiresIn,
        interval: this.device.interval,
      });
    }
    if (path === '/login/oauth/access_token') {
      if (
        form.get('client_id') !== this.device.clientId ||
        form.get('device_code') !== this.device.deviceCode ||
        form.get('grant_type') !== 'urn:ietf:params:oauth:grant-type:device_code'
      ) {
        return json(200, { error: 'incorrect_device_code' });
      }
      const next = this.device.polls.shift() ?? (this.device.approved ? 'token' : 'pending');
      switch (next) {
        case 'token':
          return json(200, {
            access_token: this.options.token,
            token_type: 'bearer',
            scope: 'repo,read:org',
          });
        case 'pending':
          return json(200, { error: 'authorization_pending' });
        case 'slow_down':
          return json(200, { error: 'slow_down', interval: this.device.interval + 0.05 });
        case 'denied':
          return json(200, { error: 'access_denied' });
        case 'expired':
          return json(200, { error: 'expired_token' });
      }
    }
    return null;
  }

  private filesOf(repo: FakeBrowseRepo): Readonly<Record<string, string>> | null {
    const files = typeof repo.files === 'function' ? repo.files() : repo.files;
    return files && Object.keys(files).length > 0 ? files : null;
  }

  private apiRepo(repo: FakeBrowseRepo) {
    const files = this.filesOf(repo);
    return {
      full_name: `${repo.owner}/${repo.name}`,
      name: repo.name,
      owner: { login: repo.owner },
      private: (repo.visibility ?? 'private') !== 'public',
      visibility: repo.visibility ?? 'private',
      default_branch: repo.defaultBranch ?? 'main',
      clone_url: repo.cloneUrl ?? `https://github.com/${repo.owner}/${repo.name}.git`,
      pushed_at: repo.pushedAt ?? null,
      size: repo.size ?? (files ? 1 : 0),
      permissions: { admin: false, push: repo.canPush ?? true, pull: true },
    };
  }

  /** One request, as GitHub would answer it. */
  handle(method: string, url: string, auth: string | null, raw: unknown): FakeAnswer {
    const parsed = new URL(url);
    const path = parsed.pathname;
    if (method === 'POST' && path.startsWith('/login/')) {
      this.requests.push({ method, path, auth, body: raw });
      return this.deviceAnswer(path, parsed.origin, raw) ?? { status: 404, headers: {}, body: {} };
    }
    // The API takes JSON: a body arrives as its text.
    const body: unknown = typeof raw === 'string' ? (raw ? JSON.parse(raw) : null) : raw;
    this.requests.push({ method, path: `${path}${parsed.search}`, auth, body });
    if (this.failNext) {
      const answer = this.failNext;
      this.failNext = null;
      return answer;
    }
    const json = (
      status: number,
      value: unknown,
      headers: Record<string, string> = {},
    ): FakeAnswer => ({
      status,
      headers,
      body: value,
    });
    if (auth !== `Bearer ${this.options.token}`) return json(401, { message: 'Bad credentials' });
    if (method === 'GET' && path === '/user') return json(200, { login: this.options.login });
    if (method === 'GET' && path === '/user/orgs')
      return json(
        200,
        this.orgs.map((login) => ({ login })),
      );
    if (method === 'GET' && path === '/user/repos') {
      const perPage = Number(parsed.searchParams.get('per_page') ?? 30);
      const page = Number(parsed.searchParams.get('page') ?? 1);
      const sorted = [...this.repos].sort((a, b) =>
        (b.pushedAt ?? '').localeCompare(a.pushedAt ?? ''),
      );
      const slice = sorted.slice((page - 1) * perPage, page * perPage);
      const headers: Record<string, string> = {};
      if (page * perPage < sorted.length) {
        const next = new URL(url);
        next.searchParams.set('page', String(page + 1));
        headers['link'] = `<${next.toString()}>; rel="next"`;
      }
      return json(
        200,
        slice.map((repo) => this.apiRepo(repo)),
        headers,
      );
    }
    if (method === 'POST' && (path === '/user/repos' || /^\/orgs\/[^/]+\/repos$/.test(path))) {
      const owner = path === '/user/repos' ? this.options.login : path.split('/')[2]!;
      if (owner !== this.options.login && !this.orgs.includes(owner))
        return json(404, { message: 'Not Found' });
      const name = (body as { name?: unknown } | null)?.name;
      if (typeof name !== 'string') return json(422, { message: 'Validation Failed' });
      if (
        this.repos.some(
          (repo) => repo.owner === owner && repo.name.toLowerCase() === name.toLowerCase(),
        )
      ) {
        return json(422, {
          message: 'Repository creation failed.',
          errors: [
            {
              resource: 'Repository',
              code: 'custom',
              field: 'name',
              message: 'name already exists on this account',
            },
          ],
        });
      }
      const repo: FakeBrowseRepo = {
        owner,
        name,
        visibility: 'private',
        pushedAt: new Date().toISOString(),
        canPush: true,
        files: null,
        ...(this.onCreate ? { cloneUrl: this.onCreate(owner, name) } : {}),
      };
      this.repos.push(repo);
      return json(201, this.apiRepo(repo));
    }
    const tree = /^\/repos\/([^/]+)\/([^/]+)\/git\/trees\/(.+)$/.exec(path);
    if (method === 'GET' && tree) {
      const repo = this.repos.find((each) => each.owner === tree[1] && each.name === tree[2]);
      if (!repo) return json(404, { message: 'Not Found' });
      const files = this.filesOf(repo);
      if (!files) return json(409, { message: 'Git Repository is empty.' });
      if (decodeURIComponent(tree[3]!) !== (repo.defaultBranch ?? 'main'))
        return json(404, { message: 'Not Found' });
      const entries: Array<{ path: string; type: string; sha: string }> = [];
      const dirs = new Set<string>();
      for (const [file, content] of Object.entries(files)) {
        const id = sha(content);
        this.blobs.set(id, content);
        entries.push({ path: file, type: 'blob', sha: id });
        const parts = file.split('/');
        for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
      }
      for (const dir of dirs) entries.push({ path: dir, type: 'tree', sha: sha(`tree:${dir}`) });
      return json(200, { sha: sha('root'), tree: entries, truncated: repo.truncated === true });
    }
    const blob = /^\/repos\/[^/]+\/[^/]+\/git\/blobs\/([0-9a-f]+)$/.exec(path);
    if (method === 'GET' && blob) {
      const content = this.blobs.get(blob[1]!);
      if (content === undefined) return json(404, { message: 'Not Found' });
      return json(200, { content: Buffer.from(content).toString('base64'), encoding: 'base64' });
    }
    return json(404, { message: 'Not Found' });
  }

  /** The fake as a fetch. */
  readonly fetch: BrowseFetch = (url, init) => {
    const answer = this.handle(
      init.method ?? 'GET',
      url,
      init.headers['Authorization'] ?? null,
      init.body ?? null,
    );
    const headers = new Map(Object.entries(answer.headers).map(([k, v]) => [k.toLowerCase(), v]));
    return Promise.resolve({
      status: answer.status,
      headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
      json: () => Promise.resolve(answer.body),
    });
  };

  /** The fake over HTTP on loopback; resolves to its origin and a close. */
  async serve(port = 0): Promise<{ origin: string; close: () => Promise<void> }> {
    const server: Server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        const origin = `http://${request.headers.host ?? '127.0.0.1'}`;
        const answer = this.handle(
          request.method ?? 'GET',
          `${origin}${request.url ?? '/'}`,
          request.headers['authorization'] ?? null,
          text,
        );
        response.writeHead(answer.status, {
          'content-type': 'application/json',
          ...answer.headers,
        });
        response.end(JSON.stringify(answer.body));
      });
    });
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    return {
      origin: `http://127.0.0.1:${address.port}`,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }
}
