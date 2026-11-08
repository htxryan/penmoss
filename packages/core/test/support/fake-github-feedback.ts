/**
 * A fake of the GitHub that in-app feedback calls (T49, A793): attachment uploads at
 * `/user-attachments/assets` and issue creation at `/repos/{owner}/{repo}/issues`, on one base
 * (`GITHUB_FEEDBACK_API` points both there). Strict where GitHub is: a bearer token and a
 * User-Agent are required, the upload's `repository_id` must be the repository's, its
 * `Content-Type` must be an image type matching the name's extension (GitHub answers
 * `application/octet-stream` with a 422), and `Content-Length` must match the bytes. Tests can
 * fail the next calls to a path and read every call, upload and issue.
 *
 * Used by core's filer tests, the Worker's tests (installed as `fetch`) and by
 * `apps/server/scripts/fake-github-feedback.ts`, the local server the e2e suites run (the Mac
 * app's main process files there, A1010), so it imports nothing and uses only syntax Node strips.
 * It also answers the token check (A1012): `GET /user` and `GET /repos/{owner}/{repo}`.
 */

export interface FakeUpload {
  readonly name: string;
  readonly repositoryId: string;
  readonly contentType: string;
  readonly contentLength: number;
  readonly bytes: Uint8Array;
  readonly url: string;
}

export interface FakeIssue {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly labels: readonly string[];
  readonly url: string;
  readonly createdAt: number;
}

export interface FakeFeedbackCall {
  readonly method: string;
  readonly path: string;
  readonly status: number;
}

interface Failure {
  readonly path: string;
  readonly status: number;
  readonly body: unknown;
  readonly headers: Record<string, string>;
  /** Only this method's calls fail (any, when absent). */
  readonly method?: string;
  /** Do the call, then answer the failure: GitHub filed it, but the answer was lost. */
  readonly after?: boolean;
  times: number;
}

const EXTENSIONS: Record<string, readonly string[]> = {
  'image/png': ['png'],
  'image/jpeg': ['jpg', 'jpeg'],
  'image/gif': ['gif'],
  'image/webp': ['webp'],
};

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });

export interface FakeFeedbackOptions {
  readonly base?: string;
  readonly token?: string;
  readonly owner?: string;
  readonly repo?: string;
  readonly repositoryId?: string;
}

export class FakeFeedbackGitHub {
  readonly base: string;
  readonly token: string;
  readonly owner: string;
  readonly repo: string;
  readonly repositoryId: string;
  readonly uploads: FakeUpload[] = [];
  readonly issues: FakeIssue[] = [];
  readonly calls: FakeFeedbackCall[] = [];
  private failures: Failure[] = [];
  private counter = 0;
  /** What `GET /repos/{owner}/{repo}` says the account may do (A1012). */
  permissions = { admin: true, maintain: true, push: true, triage: true, pull: true };
  /** Whether the repository is private. Anyone signed in can open an issue in a public one. */
  isPrivate = true;

  constructor(options: FakeFeedbackOptions = {}) {
    this.base = (options.base ?? 'https://github-feedback.test').replace(/\/+$/, '');
    this.token = options.token ?? 'fake-feedback-token';
    this.owner = options.owner ?? 'htxryan';
    this.repo = options.repo ?? 'penmoss';
    this.repositoryId = options.repositoryId ?? '1450019106';
  }

  /** The next `times` calls whose path starts with `path` answer `status`. */
  fail(
    path: string,
    status: number,
    times = 1,
    body: unknown = { message: 'Failing on purpose' },
    headers: Record<string, string> = {},
    options: { readonly method?: string; readonly after?: boolean } = {},
  ): void {
    this.failures.push({ path, status, body, headers, times, ...options });
  }

  reset(): void {
    this.uploads.length = 0;
    this.issues.length = 0;
    this.calls.length = 0;
    this.failures = [];
    this.permissions = { admin: true, maintain: true, push: true, triage: true, pull: true };
    this.isPrivate = true;
  }

  /** An account outside the project on the public repository (T80.3): it can read and open issues. */
  outsider(): void {
    this.isPrivate = false;
    this.permissions = { admin: false, maintain: false, push: false, triage: false, pull: true };
  }

  /** Whether this fake answers `url`. */
  owns(url: string): boolean {
    return url.startsWith(`${this.base}/`);
  }

  /** `fetch` for the Worker under test. */
  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    return this.handle(request);
  };

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const answer = await this.answer(request, url);
    this.calls.push({ method: request.method, path, status: answer.status });
    return answer;
  }

  private async answer(request: Request, url: URL, real = false): Promise<Response> {
    const path = url.pathname;
    if (real) return this.route(request, url);
    const failure = this.failures.find(
      (f) => f.times > 0 && path.startsWith(f.path) && (!f.method || f.method === request.method),
    );
    if (failure) {
      failure.times--;
      if (failure.after) await this.answer(request, url, true);
      return json(failure.status, failure.body, failure.headers);
    }
    if (request.headers.get('Authorization') !== `Bearer ${this.token}`) {
      return json(401, { message: 'Bad credentials' });
    }
    if (!request.headers.get('User-Agent')) {
      return json(403, { message: 'Request forbidden by administrative rules (no User-Agent)' });
    }
    return this.route(request, url);
  }

  private route(request: Request, url: URL): Promise<Response> | Response {
    const path = url.pathname;
    if (request.method === 'GET' && path === '/user') {
      return json(200, { login: this.owner, id: 1 });
    }
    if (request.method === 'GET' && path === `/repos/${this.owner}/${this.repo}`) {
      return json(200, {
        id: Number(this.repositoryId),
        full_name: `${this.owner}/${this.repo}`,
        private: this.isPrivate,
        permissions: this.permissions,
      });
    }
    if (request.method === 'GET' && path === `/repos/${this.owner}/${this.repo}/issues`) {
      return this.list(url);
    }
    if (request.method === 'POST' && path === '/user-attachments/assets') {
      return this.upload(request, url);
    }
    if (request.method === 'POST' && path === `/repos/${this.owner}/${this.repo}/issues`) {
      return this.issue(request);
    }
    return json(404, { message: 'Not Found' });
  }

  /** `GET /repos/{owner}/{repo}/issues`: labels (all of them), since, newest first, pages. */
  private list(url: URL): Response {
    const labels = (url.searchParams.get('labels') ?? '')
      .split(',')
      .map((label) => label.trim())
      .filter(Boolean);
    const since = Date.parse(url.searchParams.get('since') ?? '') || 0;
    const perPage = Math.min(100, Number(url.searchParams.get('per_page') ?? 30) || 30);
    const page = Math.max(1, Number(url.searchParams.get('page') ?? 1) || 1);
    const matching = this.issues
      .filter((issue) => labels.every((label) => issue.labels.includes(label)))
      .filter((issue) => issue.createdAt >= since)
      .sort((a, b) => b.number - a.number)
      .slice((page - 1) * perPage, page * perPage);
    return json(
      200,
      matching.map((issue) => ({
        number: issue.number,
        title: issue.title,
        body: issue.body,
        html_url: issue.url,
        labels: issue.labels.map((name) => ({ name })),
        created_at: new Date(issue.createdAt).toISOString(),
      })),
    );
  }

  private async upload(request: Request, url: URL): Promise<Response> {
    const repositoryId = url.searchParams.get('repository_id') ?? '';
    const name = url.searchParams.get('name') ?? '';
    if (repositoryId !== this.repositoryId) return json(404, { message: 'Not Found' });
    const contentType = (request.headers.get('Content-Type') ?? '').toLowerCase();
    const extension = name.split('.').pop()?.toLowerCase() ?? '';
    if (!EXTENSIONS[contentType]?.includes(extension)) {
      return json(422, {
        message: 'Validation Failed',
        errors: [{ message: 'content_type is not included in the list of allowed content types' }],
      });
    }
    const bytes = new Uint8Array(await request.arrayBuffer());
    const contentLength = Number(request.headers.get('Content-Length') ?? NaN);
    if (contentLength !== bytes.byteLength) {
      return json(400, { message: 'Content-Length does not match the body' });
    }
    this.counter++;
    const id = `00000000-0000-4000-8000-${String(this.counter).padStart(12, '0')}`;
    const upload: FakeUpload = {
      name,
      repositoryId,
      contentType,
      contentLength,
      bytes,
      url: `https://github.com/user-attachments/assets/${id}`,
    };
    this.uploads.push(upload);
    return json(201, {
      id: this.counter,
      name,
      size: bytes.byteLength,
      content_type: contentType,
      url: upload.url,
    });
  }

  private async issue(request: Request): Promise<Response> {
    let body: { title?: unknown; body?: unknown; labels?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return json(400, { message: 'Problems parsing JSON' });
    }
    if (typeof body.title !== 'string' || body.title.trim() === '') {
      return json(422, { message: 'Validation Failed', errors: [{ code: 'missing_field' }] });
    }
    // GitHub drops, without an error, the labels of an account that cannot triage.
    const labels =
      Array.isArray(body.labels) && (this.permissions.push || this.permissions.triage)
        ? body.labels.filter((label): label is string => typeof label === 'string')
        : [];
    const number = 100 + this.issues.length + 1;
    const issue: FakeIssue = {
      number,
      title: body.title,
      body: typeof body.body === 'string' ? body.body : '',
      labels,
      url: `https://github.com/${this.owner}/${this.repo}/issues/${number}`,
      createdAt: Date.now(),
    };
    this.issues.push(issue);
    return json(201, {
      number,
      title: issue.title,
      html_url: issue.url,
      labels: labels.map((name) => ({ name })),
    });
  }
}
