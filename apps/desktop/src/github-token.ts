/**
 * The person's own GitHub token on this Mac (T57, A1010–A1012, A1015), and Send feedback filed
 * with it from the main process.
 *
 * - **The token** is typed by the person in Settings → Status → GitHub Token and kept in
 *   `github-token.json`, sealed with `safeStorage` (the Keychain's "Penmoss Safe Storage" key),
 *   as git notebooks keep theirs (A853). It never goes back to a page: the page sees whether one
 *   is saved, the account it belongs to, and what GitHub said of it. Without the Keychain it is
 *   not kept at all.
 * - **Saving checks it** (`GET /user`, `GET /repos/htxryan/penmoss`): a token GitHub does not
 *   accept, or one that cannot open issues in the repository, is refused with plain words and not
 *   kept. One GitHub could not be asked about is kept, and the check is said to be pending.
 * - **Filing** runs core's `fileFeedback` (the Worker's checks, body, labels and footer) with
 *   this token, and a ledger in `feedback-ledger.json` so a retry never files twice (A1010).
 *   Screenshots are uploaded from here to GitHub's issue attachments (A1011).
 * Updates do not use it: they come from public GitHub Releases with no token (A1112, A1196).
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  FEEDBACK_REPO,
  FeedbackGitHub,
  fileFeedback,
  GITHUB_API,
  GITHUB_UPLOADS,
  TOKEN_MESSAGES,
  type FeedbackAnswer,
  type FeedbackLedger,
  type FeedbackLedgerEntry,
  type TokenCheck,
} from '@penmoss/core/feedback-github';

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** What the page may know of the token. */
export interface GitHubTokenStatus {
  readonly saved: boolean;
  /** The GitHub account it belongs to, when GitHub said. */
  readonly login: string | null;
  /** What GitHub last said is wrong with it, in plain words; null when nothing is. */
  readonly problem: string | null;
  /** This Mac can keep a token (the Keychain is there). */
  readonly keychain: boolean;
  /** It came from Sign in with GitHub (T82), not pasted. */
  readonly signedIn: boolean;
}

/** What Save answered. */
export type SaveAnswer =
  | { readonly ok: true; readonly status: GitHubTokenStatus; readonly note: string | null }
  | { readonly ok: false; readonly message: string };

interface Stored {
  readonly sealed: string;
  readonly login: string | null;
  readonly problem: string | null;
  readonly signedIn?: boolean;
}

export interface GitHubTokenOptions {
  readonly dir: string;
  /** Encrypts with the Keychain's key; null when it cannot (then nothing is kept). */
  readonly seal: (plain: string) => Promise<string | null>;
  readonly unseal: (sealed: string) => Promise<string | null>;
  readonly fetch: Fetch;
  /** A local fake GitHub for the Playwright suite (unpackaged builds only, config.ts). */
  readonly api?: string | null;
  readonly log?: (message: string) => void;
  readonly onChange?: () => void;
  readonly now?: () => number;
}

/** How many filed or tried submissions the ledger keeps (the outbox holds far fewer). */
const LEDGER_MAX = 200;
/** The longest token taken: GitHub's are 40 (classic) to about 93 (fine-grained) characters. */
const TOKEN_MAX = 255;

export class GitHubToken {
  private cache: { token: string | null; stored: Stored | null } | null = null;
  private ledgerLoaded: Map<string, FeedbackLedgerEntry> | null = null;
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly options: GitHubTokenOptions) {}

  private get tokenFile(): string {
    return join(this.options.dir, 'github-token.json');
  }

  private get ledgerFile(): string {
    return join(this.options.dir, 'feedback-ledger.json');
  }

  private github(token: string): FeedbackGitHub {
    const base = this.options.api ?? null;
    return new FeedbackGitHub(
      {
        api: base ?? GITHUB_API,
        uploads: base ?? GITHUB_UPLOADS,
        owner: FEEDBACK_REPO.owner,
        repo: FEEDBACK_REPO.repo,
        repoId: FEEDBACK_REPO.repoId,
        token,
      },
      this.options.fetch,
    );
  }

  private async load(): Promise<{ token: string | null; stored: Stored | null }> {
    if (this.cache) return this.cache;
    let stored: Stored | null = null;
    try {
      const parsed = JSON.parse(await readFile(this.tokenFile, 'utf8')) as Partial<Stored>;
      if (typeof parsed.sealed === 'string') {
        stored = {
          sealed: parsed.sealed,
          login: typeof parsed.login === 'string' ? parsed.login : null,
          problem: typeof parsed.problem === 'string' ? parsed.problem : null,
          signedIn: parsed.signedIn === true,
        };
      }
    } catch {
      stored = null;
    }
    const token = stored ? await this.options.unseal(stored.sealed).catch(() => null) : null;
    this.cache = { token: token || null, stored: token ? stored : null };
    return this.cache;
  }

  private async write(path: string, value: unknown): Promise<void> {
    await mkdir(this.options.dir, { recursive: true });
    const temp = `${path}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(value), { mode: 0o600 });
    await rename(temp, path);
  }

  private async keychain(): Promise<boolean> {
    return (await this.options.seal('check').catch(() => null)) !== null;
  }

  /** The token, for this process only (feedback). */
  async token(): Promise<string | null> {
    return (await this.load()).token;
  }

  async status(): Promise<GitHubTokenStatus> {
    const { token, stored } = await this.load();
    return {
      saved: token !== null,
      login: stored?.login ?? null,
      problem: stored?.problem ?? null,
      keychain: await this.keychain(),
      signedIn: token !== null && stored?.signedIn === true,
    };
  }

  /** Checks `value` with GitHub and keeps it if it can open issues (A1012). */
  async save(value: unknown): Promise<SaveAnswer> {
    const token = typeof value === 'string' ? value.trim() : '';
    if (!token || token.length > TOKEN_MAX || /\s/.test(token)) {
      return { ok: false, message: 'Paste a GitHub token: one line, no spaces.' };
    }
    const check: TokenCheck = await this.github(token).checkToken();
    if (!check.ok && check.problem !== 'unreachable') return { ok: false, message: check.message };
    const sealed = await this.options.seal(token).catch(() => null);
    if (sealed === null) {
      return {
        ok: false,
        message: 'Penmoss could not keep the token: the Keychain is not available.',
      };
    }
    const stored: Stored = { sealed, login: check.login, problem: null };
    await this.write(this.tokenFile, stored);
    this.cache = { token, stored };
    this.options.log?.(`GitHub token saved${check.login ? ` for ${check.login}` : ''}`);
    this.options.onChange?.();
    return {
      ok: true,
      status: await this.status(),
      note: check.ok ? null : `Saved, but GitHub could not be asked about it: ${check.message}`,
    };
  }

  /**
   * Keeps the token Sign in with GitHub got (T82, A1171), for `login`: without the feedback
   * repository check a pasted token gets (Send feedback says so itself if it can't file).
   */
  async saveSignedIn(token: string, login: string | null): Promise<boolean> {
    if (!token || token.length > TOKEN_MAX || /\s/.test(token)) return false;
    const sealed = await this.options.seal(token).catch(() => null);
    if (sealed === null) return false;
    const stored: Stored = { sealed, login, problem: null, signedIn: true };
    await this.write(this.tokenFile, stored);
    this.cache = { token, stored };
    this.options.log?.(`GitHub sign-in saved${login ? ` for ${login}` : ''}`);
    this.options.onChange?.();
    return true;
  }

  /** GitHub refused the token when browsing (401): Settings says so, and the step offers Sign in again. */
  async refused(): Promise<void> {
    await this.noteProblem('GitHub refused this token. Sign in again, or paste a new one.');
  }

  async remove(): Promise<GitHubTokenStatus> {
    await this.write(this.tokenFile, {});
    this.cache = { token: null, stored: null };
    this.options.onChange?.();
    return this.status();
  }

  /** Remembers what GitHub last refused the token for, so Settings says it too. */
  private async noteProblem(problem: string | null): Promise<void> {
    const { token, stored } = await this.load();
    if (!token || !stored || stored.problem === problem) return;
    const next = { ...stored, problem };
    await this.write(this.tokenFile, next).catch(() => undefined);
    this.cache = { token, stored: next };
    this.options.onChange?.();
  }

  // --- the ledger (A1010) ---

  private async ledgerRows(): Promise<Map<string, FeedbackLedgerEntry>> {
    if (this.ledgerLoaded) return this.ledgerLoaded;
    const rows = new Map<string, FeedbackLedgerEntry>();
    try {
      const parsed = JSON.parse(await readFile(this.ledgerFile, 'utf8')) as Record<
        string,
        FeedbackLedgerEntry
      >;
      for (const [id, entry] of Object.entries(parsed)) {
        if (entry && typeof entry.createdAt === 'number') rows.set(id, entry);
      }
    } catch {
      // None yet.
    }
    this.ledgerLoaded = rows;
    return rows;
  }

  private readonly ledger: FeedbackLedger = {
    get: async (id) => (await this.ledgerRows()).get(id) ?? null,
    set: async (id, entry) => {
      const rows = await this.ledgerRows();
      rows.delete(id);
      rows.set(id, entry);
      while (rows.size > LEDGER_MAX) rows.delete(rows.keys().next().value!);
      const snapshot = Object.fromEntries(rows);
      this.writing = this.writing
        .then(() => this.write(this.ledgerFile, snapshot))
        .catch((error: unknown) =>
          this.options.log?.(`feedback ledger not saved: ${String(error)}`),
        );
      await this.writing;
    },
  };

  /**
   * Files one submission (A1010): the page's `payload` part and its screenshots. Answers the
   * Worker's shape; with no token, status 0 `no_github_token`, which the outbox keeps waiting.
   */
  async file(
    payload: unknown,
    screenshots: ReadonlyArray<{ readonly type: string; readonly bytes: Uint8Array }>,
  ): Promise<FeedbackAnswer> {
    const token = await this.token();
    if (!token) {
      return {
        status: 0,
        body: { error: { code: 'no_github_token', message: TOKEN_MESSAGES.missing } },
      };
    }
    const answer = await fileFeedback({
      github: this.github(token),
      ledger: this.ledger,
      payload: typeof payload === 'string' ? payload : '',
      screenshots: screenshots.map((shot) => ({
        type: shot.type,
        blob: new Blob([shot.bytes as Uint8Array<ArrayBuffer>], { type: shot.type }),
      })),
      client: 'mac',
      ...(this.options.now ? { now: this.options.now } : {}),
    });
    const refused =
      'error' in answer.body && answer.body.error.code === 'token_cannot_file'
        ? answer.body.error.message
        : null;
    if (refused || answer.status < 300) await this.noteProblem(refused);
    return answer;
  }
}

/**
 * A request as Chromium's network stack takes it (`net.fetch`): it refuses a `Content-Length`
 * set by hand and sets it itself from the body, so the header core sends for the attachment
 * upload (A1011) is left to it.
 */
export function chromiumInit(init: RequestInit | undefined): RequestInit | undefined {
  if (!init?.headers) return init;
  const headers = new Headers(init.headers);
  headers.delete('content-length');
  return { ...init, headers };
}

/** The screenshots the page sent, checked for shape (core checks the bytes). */
export function screenshotsOf(
  value: unknown,
): Array<{ readonly type: string; readonly bytes: Uint8Array }> | null {
  if (!Array.isArray(value) || value.length > 6) return null;
  const out: Array<{ type: string; bytes: Uint8Array }> = [];
  for (const item of value as unknown[]) {
    if (typeof item !== 'object' || item === null) return null;
    const { type, bytes } = item as { type?: unknown; bytes?: unknown };
    if (typeof type !== 'string' || !(bytes instanceof Uint8Array)) return null;
    out.push({ type, bytes });
  }
  return out;
}
