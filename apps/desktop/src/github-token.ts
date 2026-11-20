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

/** One GitHub account kept on this Mac (A1617): what the page may know of it. */
export interface GitHubAccountStatus {
  readonly login: string | null;
  /** The first account: Send Feedback files with it. */
  readonly primary: boolean;
  readonly signedIn: boolean;
  readonly problem: string | null;
}

/** What the page may know of the token. */
export interface GitHubTokenStatus {
  /** Every account kept, the first (Send Feedback's) first (A1617). */
  readonly accounts: readonly GitHubAccountStatus[];
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

interface Account {
  readonly sealed: string;
  readonly login: string | null;
  readonly problem: string | null;
  readonly signedIn?: boolean;
}

/**
 * `github-token.json`: the first account where the one account always was, so a Mac signed in
 * before A1617 reads the same; the others beside it, keyed by login.
 */
interface Stored extends Account {
  readonly others?: readonly Account[];
}

/** An account and its token, unsealed for this process. */
interface Kept {
  readonly token: string;
  readonly account: Account;
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
  /** The accounts, the first (Send Feedback's) first; tokens that would not unseal are left out. */
  private cache: Kept[] | null = null;
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

  private async load(): Promise<Kept[]> {
    if (this.cache) return this.cache;
    const accountOf = (value: unknown): Account | null => {
      const parsed = (value ?? {}) as Partial<Account>;
      if (typeof parsed.sealed !== 'string') return null;
      return {
        sealed: parsed.sealed,
        login: typeof parsed.login === 'string' ? parsed.login : null,
        problem: typeof parsed.problem === 'string' ? parsed.problem : null,
        signedIn: parsed.signedIn === true,
      };
    };
    let accounts: Account[];
    try {
      const parsed = JSON.parse(await readFile(this.tokenFile, 'utf8')) as Partial<Stored>;
      const first = accountOf(parsed);
      const others = Array.isArray(parsed.others) ? parsed.others.map(accountOf) : [];
      accounts = [first, ...others].filter((each): each is Account => each !== null);
    } catch {
      accounts = [];
    }
    const kept: Kept[] = [];
    for (const account of accounts) {
      const token = await this.options.unseal(account.sealed).catch(() => null);
      if (token) kept.push({ token, account });
    }
    this.cache = kept;
    return kept;
  }

  /** Writes the accounts, the first in the old place and the rest beside it. */
  private async keepAll(kept: Kept[]): Promise<void> {
    const [first, ...others] = kept;
    const stored: Stored | Record<string, never> = first
      ? {
          ...first.account,
          ...(others.length ? { others: others.map((each) => each.account) } : {}),
        }
      : {};
    await this.write(this.tokenFile, stored);
    this.cache = kept;
  }

  /** The kept account for `login`; the first with none given. */
  private find(kept: readonly Kept[], login?: string | null): Kept | undefined {
    if (login === undefined) return kept[0];
    return kept.find((each) => (each.account.login ?? null) === login);
  }

  /**
   * Keeps `token` for `account.login`: in its place when that account is kept already (signing in
   * again renews it), else as the first when there is none, else beside the others (A1617).
   */
  private async keepAccount(token: string, account: Account): Promise<void> {
    const kept = [...(await this.load())];
    const at = kept.findIndex(
      (each) => account.login !== null && each.account.login === account.login,
    );
    if (at >= 0) kept[at] = { token, account };
    else if (kept.length === 0 || (account.login === null && kept[0]!.account.login === null)) {
      kept[0] = { token, account };
    } else kept.push({ token, account });
    await this.keepAll(kept);
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

  /**
   * A token, for this process only: the first account's (Send Feedback's) with no `login`, else
   * that account's (A1617).
   */
  async token(login?: string | null): Promise<string | null> {
    return this.find(await this.load(), login)?.token ?? null;
  }

  /**
   * The logins kept, first first, read from the file without unsealing a token: what the log
   * file's scrubber replaces (PEN-137).
   */
  async logins(): Promise<string[]> {
    try {
      const parsed = JSON.parse(await readFile(this.tokenFile, 'utf8')) as Partial<Stored>;
      const others = Array.isArray(parsed.others) ? (parsed.others as unknown[]) : [];
      return [parsed, ...others]
        .map((each) => (each as { login?: unknown } | null)?.login)
        .filter((login): login is string => typeof login === 'string' && login !== '');
    } catch {
      return [];
    }
  }

  async status(): Promise<GitHubTokenStatus> {
    const kept = await this.load();
    const first = kept[0]?.account ?? null;
    return {
      accounts: kept.map(({ account }, at) => ({
        login: account.login,
        primary: at === 0,
        signedIn: account.signedIn === true,
        problem: account.problem,
      })),
      saved: first !== null,
      login: first?.login ?? null,
      problem: first?.problem ?? null,
      keychain: await this.keychain(),
      signedIn: first?.signedIn === true,
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
    await this.keepAccount(token, { sealed, login: check.login, problem: null });
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
    await this.keepAccount(token, { sealed, login, problem: null, signedIn: true });
    this.options.log?.(`GitHub sign-in saved${login ? ` for ${login}` : ''}`);
    this.options.onChange?.();
    return true;
  }

  /**
   * GitHub refused an account's token when browsing (401): Settings says so, and the step offers
   * Sign in again. The first account's with no `login`.
   */
  async refused(login?: string | null): Promise<void> {
    await this.noteProblem('GitHub refused this token. Sign in again, or paste a new one.', login);
  }

  /**
   * Forgets one account (the first with no `login`): removing the first makes the next one
   * Send Feedback's (A1617). Notebooks added with it keep their own copy of its token (A1171).
   */
  async remove(login?: string | null): Promise<GitHubTokenStatus> {
    const kept = await this.load();
    const gone = this.find(kept, login);
    if (gone) await this.keepAll(kept.filter((each) => each !== gone));
    this.options.onChange?.();
    return this.status();
  }

  /** Makes `login`'s account the first: Send Feedback files with it (A1617). */
  async makePrimary(login: unknown): Promise<GitHubTokenStatus> {
    const kept = await this.load();
    const chosen = typeof login === 'string' ? this.find(kept, login) : undefined;
    if (chosen && chosen !== kept[0]) {
      await this.keepAll([chosen, ...kept.filter((each) => each !== chosen)]);
      this.options.onChange?.();
    }
    return this.status();
  }

  /** Remembers what GitHub last refused an account's token for, so Settings says it too. */
  private async noteProblem(problem: string | null, login?: string | null): Promise<void> {
    const kept = await this.load();
    const was = this.find(kept, login);
    if (!was || was.account.problem === problem) return;
    const next = kept.map((each) =>
      each === was ? { token: each.token, account: { ...each.account, problem } } : each,
    );
    await this.keepAll(next).catch(() => undefined);
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
