/**
 * Filing Send feedback on GitHub (T49, A793, A794; T57, A1010–A1013). The Worker did this with its
 * own token until D48; the Mac app now does it in its main process with the person's own GitHub
 * token, and Android ports the same steps to Kotlin. Both answer in the Worker's shape
 * (`POST /api/feedback`'s statuses and `{ issue }` / `{ error: { code, message } }`), so the
 * clients' outboxes sort an answer the same way whoever filed it.
 *
 * The GitHub calls, one of which is not in GitHub's REST reference:
 *
 * - **Attachments:** `POST https://uploads.github.com/user-attachments/assets?repository_id=…&name=…`
 *   with the image's bytes, as `gh issue create --attach` sends them (gh 2.99.0, cli/cli#14180).
 *   `Content-Type` must be the image's own type and match the name's extension; GitHub answers
 *   `application/octet-stream` with a 422. It answers 201 `{ url }`, a private
 *   `https://github.com/user-attachments/assets/<uuid>` address. A personal token can do this
 *   when it may write the repository's contents (A1011).
 * - **Issues:** `POST /repos/{owner}/{repo}/issues` with a title, a body and labels, and
 *   `GET /repos/{owner}/{repo}/issues` (newest first; not by label, since GitHub drops the labels of
 *   an account that cannot triage) to find the issue an earlier attempt filed before its answer
 *   was lost (A792).
 *
 * Failures become `FeedbackGitHubError`s whose messages never hold the token: `retryable` when
 * trying again later may work (GitHub's 5xx, a primary or secondary rate limit, no answer),
 * otherwise a refusal that only a change of token or request fixes (a 401, 403, 404 or 422).
 */
import { isUlid } from './ids';
import {
  contextWithoutSecrets,
  feedbackIssueBody,
  feedbackLabels,
  FEEDBACK_IMAGE_TYPES,
  FEEDBACK_LIMITS,
  FEEDBACK_TYPES,
  parseFeedbackContext,
  redactSecrets,
  type FeedbackClient,
  type FeedbackContext,
  type FeedbackPriority,
  type FeedbackType,
} from './feedback';

/** The repository feedback is filed in (D41), and the id the attachment upload names it by. */
export const FEEDBACK_REPO = { owner: 'htxryan', repo: 'penmoss', repoId: '1450019106' } as const;
export const GITHUB_API = 'https://api.github.com';
export const GITHUB_UPLOADS = 'https://uploads.github.com';

export interface FeedbackGitHubConfig {
  /** `https://api.github.com`, or a local fake. */
  readonly api: string;
  /** `https://uploads.github.com`, or the same local fake. */
  readonly uploads: string;
  readonly owner: string;
  readonly repo: string;
  /** The repository's numeric id, which the attachment upload names it by. */
  readonly repoId: string;
  readonly token: string;
}

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class FeedbackGitHubError extends Error {
  constructor(
    message: string,
    /** GitHub's status, or 0 when it never answered. */
    readonly status: number,
    readonly retryable: boolean,
    /** GitHub's Retry-After, in seconds, when it gave one. */
    readonly retryAfter: number | null = null,
  ) {
    super(message);
    this.name = 'FeedbackGitHubError';
  }

  /** A refusal of the token itself: it is not valid, or may not do this to the repository. */
  get tokenRefused(): boolean {
    return !this.retryable && [401, 403, 404].includes(this.status);
  }
}

/** How long each GitHub call may take. */
const TIMEOUT_MS = 20_000;

export interface FiledIssue {
  readonly number: number;
  readonly url: string;
}

export class FeedbackGitHub {
  constructor(
    private readonly config: FeedbackGitHubConfig,
    private readonly fetcher: Fetch = (input, init) => fetch(input, init),
  ) {}

  private headers(extra: Record<string, string>): Record<string, string> {
    return {
      Authorization: `Bearer ${this.config.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      // GitHub refuses requests without one.
      'User-Agent': 'penmoss-feedback',
      ...extra,
    };
  }

  private async send(what: string, url: string, init: RequestInit): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetcher(url, {
        ...init,
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.name : 'error';
      throw new FeedbackGitHubError(`${what}: GitHub did not answer (${reason})`, 0, true);
    }
    if (response.status < 200 || response.status >= 300) {
      const detail = await reasonOf(response);
      const after = Number(response.headers.get('retry-after'));
      const retryAfter = Number.isFinite(after) && after > 0 ? Math.ceil(after) : null;
      // A primary limit (remaining 0), or a secondary one: a 403 or 429 with Retry-After, or
      // GitHub's "secondary rate limit" message.
      const limited =
        response.status === 429 ||
        (response.status === 403 &&
          (response.headers.get('x-ratelimit-remaining') === '0' ||
            retryAfter !== null ||
            /secondary rate limit|abuse/i.test(detail)));
      const retryable = response.status >= 500 || limited;
      const hint =
        !retryable &&
        (response.status === 401 || response.status === 403 || response.status === 404)
          ? ' (the token cannot write to the repository)'
          : '';
      throw new FeedbackGitHubError(
        `${what}: GitHub answered ${response.status}${detail ? ` (${detail})` : ''}${hint}`,
        response.status,
        retryable,
        retryAfter,
      );
    }
    try {
      return await response.json();
    } catch {
      throw new FeedbackGitHubError(`${what}: GitHub's answer was not JSON`, response.status, true);
    }
  }

  /** Uploads one image as an issue attachment, streamed as received; answers its address. */
  async uploadImage(name: string, contentType: string, image: Blob): Promise<string> {
    const url = new URL(`${this.config.uploads}/user-attachments/assets`);
    url.searchParams.set('repository_id', this.config.repoId);
    url.searchParams.set('name', name);
    const body = (await this.send(`Uploading ${name}`, url.toString(), {
      method: 'POST',
      headers: this.headers({
        'Content-Type': contentType,
        'Content-Length': String(image.size),
      }),
      body: image,
    })) as { url?: unknown } | null;
    const address = typeof body?.url === 'string' ? body.url : '';
    if (!/^https?:\/\/\S+$/.test(address)) {
      throw new FeedbackGitHubError(`Uploading ${name}: GitHub gave no address`, 201, true);
    }
    return address;
  }

  /** Opens the issue; answers its number and web address. */
  async createIssue(issue: {
    readonly title: string;
    readonly body: string;
    readonly labels: readonly string[];
  }): Promise<FiledIssue> {
    const { owner, repo } = this.config;
    const body = (await this.send(
      'Opening the issue',
      `${this.config.api}/repos/${owner}/${repo}/issues`,
      {
        method: 'POST',
        headers: this.headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(issue),
      },
    )) as { number?: unknown; html_url?: unknown } | null;
    if (typeof body?.number !== 'number' || typeof body.html_url !== 'string') {
      throw new FeedbackGitHubError('Opening the issue: GitHub gave no number', 201, false);
    }
    return { number: body.number, url: body.html_url };
  }

  /**
   * The issues updated since `since` (epoch ms), newest first, 100 a page: listed, not searched,
   * because the search index lags behind a just-filed issue. Not filtered by the `in-app
   * feedback` label, which GitHub drops when the account filing cannot triage (T80.3).
   */
  async listFeedbackIssues(since: number, page: number): Promise<ListedIssue[]> {
    const { owner, repo } = this.config;
    const url = new URL(`${this.config.api}/repos/${owner}/${repo}/issues`);
    url.searchParams.set('state', 'all');
    url.searchParams.set('sort', 'created');
    url.searchParams.set('direction', 'desc');
    url.searchParams.set('since', new Date(since).toISOString());
    url.searchParams.set('per_page', '100');
    url.searchParams.set('page', String(page));
    const list = await this.send('Looking for an issue already filed', url.toString(), {
      method: 'GET',
      headers: this.headers({}),
    });
    if (!Array.isArray(list)) {
      throw new FeedbackGitHubError('Looking for an issue already filed: not a list', 200, true);
    }
    return (list as Array<{ number?: unknown; html_url?: unknown; body?: unknown }>)
      .filter(
        (item): item is { number: number; html_url: string; body?: unknown } =>
          typeof item.number === 'number' && typeof item.html_url === 'string',
      )
      .map((item) => ({
        number: item.number,
        url: item.html_url,
        body: typeof item.body === 'string' ? item.body : '',
      }));
  }

  /**
   * What the token may do here (A1012): who it is, and whether it can see the repository. Checked
   * when it is saved, so a token for the wrong account or repository is said at once rather
   * than at the first Send. A token that sees the repository may still lack Issues or Contents
   * write; GitHub says so only when they are used, and the filer says it then.
   */
  async checkToken(): Promise<TokenCheck> {
    const { owner, repo } = this.config;
    let login: string | null = null;
    try {
      const user = (await this.send('Checking the token', `${this.config.api}/user`, {
        method: 'GET',
        headers: this.headers({}),
      })) as { login?: unknown } | null;
      login = typeof user?.login === 'string' ? user.login : null;
    } catch (error) {
      if (error instanceof FeedbackGitHubError && error.status === 401) {
        return { ok: false, login: null, problem: 'invalid', message: TOKEN_MESSAGES.invalid };
      }
      if (error instanceof FeedbackGitHubError && error.retryable) {
        return { ok: false, login: null, problem: 'unreachable', message: error.message };
      }
      // A fine-grained token with no account permissions may not read /user: carry on.
    }
    try {
      const found = (await this.send(
        'Checking the repository',
        `${this.config.api}/repos/${owner}/${repo}`,
        { method: 'GET', headers: this.headers({}) },
      )) as { private?: unknown; permissions?: { push?: unknown; triage?: unknown } } | null;
      const permissions = found?.permissions;
      // The account's permissions: in a private repository, an account that cannot write cannot
      // file, whatever the token. Anyone signed in can open an issue in a public one (T80.3);
      // GitHub drops the labels of an account that cannot triage. (A private repository the
      // token may not see answers 404, below.)
      if (
        found?.private !== false &&
        permissions &&
        permissions.push === false &&
        permissions.triage === false
      ) {
        return { ok: false, login, problem: 'cannot_file', message: TOKEN_MESSAGES.cannotFile };
      }
      return { ok: true, login };
    } catch (error) {
      if (error instanceof FeedbackGitHubError && error.retryable) {
        return { ok: false, login, problem: 'unreachable', message: error.message };
      }
      if (error instanceof FeedbackGitHubError && error.status === 401) {
        return { ok: false, login: null, problem: 'invalid', message: TOKEN_MESSAGES.invalid };
      }
      return { ok: false, login, problem: 'cannot_file', message: TOKEN_MESSAGES.cannotFile };
    }
  }
}

/** What a token check found (A1012). */
export type TokenCheck =
  | { readonly ok: true; readonly login: string | null }
  | {
      readonly ok: false;
      readonly login: string | null;
      readonly problem: 'invalid' | 'cannot_file' | 'unreachable';
      readonly message: string;
    };

const REPO_NAME = `${FEEDBACK_REPO.owner}/${FEEDBACK_REPO.repo}`;

/** What the person is told about their token, in plain words (A1012). */
export const TOKEN_MESSAGES = {
  missing: 'Add your GitHub token in Settings → Status → GitHub Token to send it.',
  invalid: 'GitHub does not accept this token: it may have expired or been revoked.',
  cannotFile: `This GitHub token cannot open issues in ${REPO_NAME}. Use a classic token with the public_repo scope or, as a collaborator, a fine-grained token with Issues and Contents (read and write) on ${REPO_NAME}.`,
} as const;

/** The footer line that names a submission (core `feedbackIssueBody`). */
const footerOf = (submissionId: string) => `· submission ${submissionId}`;

export interface ListedIssue {
  readonly number: number;
  readonly url: string;
  readonly body: string;
}

/** How many pages of the newest issues `findIssue` reads. */
const FIND_PAGES = 3;

/**
 * The issue an earlier attempt filed for `submissionId`, found by its footer among the issues
 * updated since `since`; null when there is none.
 */
export async function findIssue(
  github: FeedbackGitHub,
  submissionId: string,
  since: number,
): Promise<FiledIssue | null> {
  const footer = footerOf(submissionId);
  for (let page = 1; page <= FIND_PAGES; page++) {
    const issues = await github.listFeedbackIssues(since, page);
    const found = issues.find((issue) =>
      issue.body.split('\n').some((line) => line.trimEnd().endsWith(footer)),
    );
    if (found) return { number: found.number, url: found.url };
    if (issues.length < 100) return null;
  }
  return null;
}

/** GitHub's own words for a refusal (`message`, and the first error's), cut short. */
async function reasonOf(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as {
      message?: unknown;
      errors?: Array<{ message?: unknown; code?: unknown }>;
    };
    const first = body.errors?.[0];
    const parts = [
      typeof body.message === 'string' ? body.message : '',
      typeof first?.message === 'string'
        ? first.message
        : typeof first?.code === 'string'
          ? first.code
          : '',
    ].filter(Boolean);
    return parts.join(': ').slice(0, 200);
  } catch {
    return '';
  }
}

// --- the submission, checked (the Worker's readSubmission, shared) ---

export interface FeedbackSubmission {
  readonly submissionId: string;
  readonly type: FeedbackType;
  readonly priority: FeedbackPriority;
  readonly title: string;
  readonly description: string;
  readonly version: string;
  readonly context: FeedbackContext;
}

export class FeedbackInvalid extends Error {
  constructor(
    message: string,
    readonly status: 400 | 413 = 400,
  ) {
    super(message);
    this.name = 'FeedbackInvalid';
  }
}

/** The `payload` part, checked; throws `FeedbackInvalid` naming the field. */
export function readFeedbackPayload(raw: unknown): FeedbackSubmission {
  if (typeof raw !== 'string')
    throw new FeedbackInvalid('payload is required (a JSON string part)');
  let payload: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error();
    payload = parsed as Record<string, unknown>;
  } catch {
    throw new FeedbackInvalid('payload must be a JSON object');
  }
  const { submissionId, type, priority, title, description, version, context } = payload;
  if (!isUlid(submissionId)) throw new FeedbackInvalid('submissionId must be a ULID');
  if (typeof type !== 'string' || !(FEEDBACK_TYPES as readonly string[]).includes(type)) {
    throw new FeedbackInvalid('type must be bug or feature');
  }
  if (typeof priority !== 'number' || ![1, 2, 3, 4].includes(priority)) {
    throw new FeedbackInvalid('priority must be 1, 2, 3 or 4');
  }
  const oneLine = typeof title === 'string' ? title.replace(/\s+/g, ' ').trim() : '';
  if (!oneLine) throw new FeedbackInvalid('title is required');
  if (oneLine.length > FEEDBACK_LIMITS.titleMax) {
    throw new FeedbackInvalid(`title must be ${FEEDBACK_LIMITS.titleMax} characters at most`);
  }
  if (description !== undefined && typeof description !== 'string') {
    throw new FeedbackInvalid('description must be a string');
  }
  if ((description ?? '').length > FEEDBACK_LIMITS.descriptionMax) {
    throw new FeedbackInvalid(
      `description must be ${FEEDBACK_LIMITS.descriptionMax} characters at most`,
      413,
    );
  }
  if (version !== undefined && typeof version !== 'string') {
    throw new FeedbackInvalid('version must be a string');
  }
  const checked =
    context === undefined || context === null ? { groups: [] } : parseFeedbackContext(context);
  if (!checked) throw new FeedbackInvalid('context is not a valid captured context');
  return {
    submissionId,
    type: type as FeedbackType,
    priority: priority as FeedbackPriority,
    title: oneLine,
    description: description ?? '',
    version: (version ?? '').replace(/\s+/g, ' ').trim().slice(0, FEEDBACK_LIMITS.versionMax),
    context: checked,
  };
}

/** Each image type's first bytes (a file's signature must match the type it claims). */
const SIGNATURES: Readonly<Record<string, (head: Uint8Array) => boolean>> = {
  'image/png': (b) => [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((x, i) => b[i] === x),
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/gif': (b) => String.fromCharCode(...b.slice(0, 6)).match(/^GIF8[79]a$/) !== null,
  'image/webp': (b) =>
    String.fromCharCode(...b.slice(0, 4)) === 'RIFF' &&
    String.fromCharCode(...b.slice(8, 12)) === 'WEBP',
};

/**
 * One screenshot's type, checked against its size and first 12 bytes; throws `FeedbackInvalid`.
 * Answers the plain type (`image/png`).
 */
export function checkFeedbackImage(type: string, size: number, head: Uint8Array): string {
  const kind = type.split(';')[0]!.trim().toLowerCase();
  if (!FEEDBACK_IMAGE_TYPES[kind]) {
    throw new FeedbackInvalid('Screenshots must be PNG, JPEG, GIF or WebP images');
  }
  if (size > FEEDBACK_LIMITS.screenshotBytes) {
    throw new FeedbackInvalid('Each screenshot must be 10 MB at most', 413);
  }
  if (size === 0) throw new FeedbackInvalid('A screenshot is empty');
  if (!SIGNATURES[kind]!(head))
    throw new FeedbackInvalid(`A screenshot is not the ${kind} it says it is`);
  return kind;
}

/** GitHub's limit on an issue body. */
export const FEEDBACK_BODY_MAX = 65_536;
/** The longest address an attachment is given, for checking the body's length before uploads. */
export const LONGEST_ASSET_URL = `https://github.com/user-attachments/assets/${'0'.repeat(36)}`;

// --- filing on the device (T57, A1010) ---

/**
 * What a device remembers of each submission it filed or tried to (the Worker's
 * `feedback_submissions` row, A792): enough that a retry never files twice.
 */
export interface FeedbackLedgerEntry {
  readonly createdAt: number;
  readonly status: 'pending' | 'failed' | 'sent';
  readonly issue?: FiledIssue;
  /** No new attempt before this (epoch ms): the last create may still be landing on GitHub. */
  readonly settleUntil?: number | null;
  readonly updatedAt: number;
}

export interface FeedbackLedger {
  get(submissionId: string): Promise<FeedbackLedgerEntry | null>;
  set(submissionId: string, entry: FeedbackLedgerEntry): Promise<void>;
}

/** An in-memory ledger (tests). */
export function memoryLedger(): FeedbackLedger & {
  readonly rows: Map<string, FeedbackLedgerEntry>;
} {
  const rows = new Map<string, FeedbackLedgerEntry>();
  return {
    rows,
    get: (id) => Promise.resolve(rows.get(id) ?? null),
    set: (id, entry) => {
      rows.set(id, entry);
      return Promise.resolve();
    },
  };
}

/** The Worker's answer shape (A792), whoever filed it. */
export interface FeedbackAnswer {
  readonly status: number;
  readonly body:
    | {
        readonly submissionId: string;
        readonly issue: FiledIssue;
        readonly duplicate: boolean;
      }
    | { readonly error: { readonly code: string; readonly message: string } };
  /** Seconds, when trying again should wait. */
  readonly retryAfter?: number;
}

/**
 * How long after a create that failed with a 5xx or no answer a retry waits: GitHub may still be
 * writing that issue, and the retry's lookup must find it.
 */
export const FEEDBACK_SETTLE_MS = 60 * 1000;
/** How far before a submission's first attempt the lookup starts (clocks, GitHub's own times). */
const LOOKUP_SLACK_MS = 10 * 60 * 1000;

export interface FileFeedbackInput {
  readonly github: FeedbackGitHub;
  readonly ledger: FeedbackLedger;
  /** The `payload` part, as the form sent it. */
  readonly payload: string;
  readonly screenshots: ReadonlyArray<{ readonly type: string; readonly blob: Blob }>;
  readonly client: FeedbackClient;
  readonly now?: () => number;
}

const refusal = (
  status: number,
  code: string,
  message: string,
  retryAfter?: number,
): FeedbackAnswer => ({
  status,
  body: { error: { code, message } },
  ...(retryAfter ? { retryAfter } : {}),
});

/** Runs one filing at a time per submission (a second asks while one runs: `in_progress`). */
const running = new Set<string>();

/**
 * Files one submission with the device's own token (A1010): the same checks, body, labels,
 * screenshots and footer as the Worker, and the same answers. A submission tried before is
 * looked up by its footer first and adopted, so a retry never files twice; the ledger keeps what
 * the Worker's row kept. Never throws: every outcome is an answer.
 */
export async function fileFeedback(input: FileFeedbackInput): Promise<FeedbackAnswer> {
  const now = input.now ?? Date.now;
  let submission: FeedbackSubmission;
  const shots: Array<{ type: string; blob: Blob }> = [];
  try {
    submission = readFeedbackPayload(input.payload);
    if (input.screenshots.length > FEEDBACK_LIMITS.screenshots) {
      throw new FeedbackInvalid(`At most ${FEEDBACK_LIMITS.screenshots} screenshots`);
    }
    for (const shot of input.screenshots) {
      const head = new Uint8Array(await shot.blob.slice(0, 12).arrayBuffer());
      shots.push({ type: checkFeedbackImage(shot.type, shot.blob.size, head), blob: shot.blob });
    }
  } catch (error) {
    if (error instanceof FeedbackInvalid) {
      return refusal(
        error.status,
        error.status === 413 ? 'too_large' : 'invalid_request',
        error.message,
      );
    }
    throw error;
  }
  const id = submission.submissionId;
  // No token reaches GitHub, whatever the form held (A791).
  const issueBody = (screenshots: ReadonlyArray<{ name: string; url: string }>) =>
    feedbackIssueBody({
      description: redactSecrets(submission.description),
      screenshots,
      context: contextWithoutSecrets(submission.context),
      client: input.client,
      version: submission.version,
      submissionId: id,
    });
  const names = shots.map(
    (shot, index) => `screenshot-${index + 1}.${FEEDBACK_IMAGE_TYPES[shot.type]}`,
  );
  const tooLong = () =>
    refusal(
      413,
      'too_large',
      'The description and context are longer than a GitHub issue allows; shorten them',
    );
  if (
    issueBody(names.map((name) => ({ name, url: LONGEST_ASSET_URL }))).length > FEEDBACK_BODY_MAX
  ) {
    return tooLong();
  }
  if (running.has(id)) {
    return refusal(409, 'in_progress', 'This feedback is being filed now; try again shortly');
  }
  running.add(id);
  try {
    const existing = await input.ledger.get(id);
    if (existing?.status === 'sent' && existing.issue) {
      return { status: 200, body: { submissionId: id, issue: existing.issue, duplicate: true } };
    }
    const at = now();
    if (existing?.settleUntil && at < existing.settleUntil) {
      return refusal(
        409,
        'in_progress',
        'GitHub may still be filing this feedback; try again shortly',
        Math.ceil((existing.settleUntil - at) / 1000),
      );
    }
    const createdAt = existing?.createdAt ?? at;
    const record = (entry: Omit<FeedbackLedgerEntry, 'createdAt' | 'updatedAt'>) =>
      input.ledger.set(id, { createdAt, ...entry, updatedAt: now() }).catch(() => undefined);
    await record({ status: 'pending' });
    let creating = false;
    try {
      // An earlier attempt's issue, filed before its answer was lost: adopted, never filed again.
      const earlier = existing
        ? await findIssue(input.github, id, createdAt - LOOKUP_SLACK_MS)
        : null;
      if (earlier) {
        await record({ status: 'sent', issue: earlier });
        return { status: 200, body: { submissionId: id, issue: earlier, duplicate: true } };
      }
      const uploaded: Array<{ name: string; url: string }> = [];
      for (const [index, shot] of shots.entries()) {
        const name = names[index]!;
        uploaded.push({ name, url: await input.github.uploadImage(name, shot.type, shot.blob) });
      }
      const body = issueBody(uploaded);
      if (body.length > FEEDBACK_BODY_MAX) {
        await record({ status: 'failed' });
        return tooLong();
      }
      creating = true;
      const issue = await input.github.createIssue({
        title: redactSecrets(submission.title),
        body,
        labels: feedbackLabels(submission.type, submission.priority),
      });
      await record({ status: 'sent', issue });
      return { status: 201, body: { submissionId: id, issue, duplicate: false } };
    } catch (error) {
      // A create that got a 5xx, no answer or an unreadable one may still land on GitHub's side.
      const landing =
        creating &&
        (!(error instanceof FeedbackGitHubError) ||
          error.status === 0 ||
          error.status >= 500 ||
          (error.status >= 200 && error.status < 300));
      await record({ status: 'failed', settleUntil: landing ? now() + FEEDBACK_SETTLE_MS : null });
      if (!(error instanceof FeedbackGitHubError)) {
        return refusal(503, 'github_failed', 'Filing it failed; it will be sent again');
      }
      if (error.tokenRefused) {
        const message = error.status === 401 ? TOKEN_MESSAGES.invalid : TOKEN_MESSAGES.cannotFile;
        return refusal(424, 'token_cannot_file', message);
      }
      if (!error.retryable) return refusal(424, 'github_refused', error.message);
      const wait = Math.max(error.retryAfter ?? 0, landing ? FEEDBACK_SETTLE_MS / 1000 : 0);
      return refusal(
        503,
        'github_failed',
        `${error.message}; it will be sent again`,
        wait || undefined,
      );
    }
  } finally {
    running.delete(id);
  }
}
