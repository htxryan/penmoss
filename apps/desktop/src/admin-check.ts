/**
 * The Mac's own check that it is its owner (T41, D34, A504, A855): Touch ID, or the Mac's
 * password when Touch ID is unavailable or locked out; never a plain confirmation.
 *
 * Main's owner checks guard git notebooks (T50, A855: removing a notebook from this Mac, Delete
 * for good in one) and connecting an agent (A993). They ask with
 * words main makes (`confirmOwn`), never the page's. Where the Mac has Touch ID they ask Touch ID
 * itself (Electron's `systemPreferences.promptTouchID`); elsewhere, a small signed helper in the
 * app (`native/penmoss-auth.swift`, LocalAuthentication's deviceOwnerAuthentication policy), whose
 * exit code alone counts. A missing helper, one that fails to run or one that takes too long
 * refuses the change and says why. One check runs at a time, so a page cannot queue up prompts.
 *
 * What it guards against: a person at an unlocked Mac, and code running in the page.
 */
import { spawn } from 'node:child_process';

/** What the page is told: done, or not done and why (shown as is). */
export type AdminCheckAnswer =
  { readonly ok: true } | { readonly ok: false; readonly message: string };

/** How a run of the helper ended. */
export type HelperOutcome =
  | { readonly kind: 'exit'; readonly code: number | null }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'error'; readonly error: Error };

/** Runs `helper` with the reason as its one argument, killing it after `timeoutMs`. */
export type HelperRunner = (
  helper: string,
  reason: string,
  timeoutMs: number,
) => Promise<HelperOutcome>;

/** The helper's exit codes (native/penmoss-auth.swift). */
export const HELPER_EXIT = { confirmed: 0, refused: 1, unavailable: 2, usage: 64 } as const;

/** Long enough to type a password after a failed finger; the prompt is closed after it. */
export const CHECK_TIMEOUT_MS = 120_000;

export const MESSAGES = {
  refused: 'Not done: this Mac did not confirm it was you.',
  unavailable:
    'Not done: this Mac cannot check it is you (no Touch ID and no password to ask for).',
  missing:
    'Not done: Penmoss could not ask this Mac to check it is you (its check is missing or would not run). Reinstall Penmoss.',
  notMac: 'Not done: this change needs macOS to check it is you.',
  timeout: 'Not done: the check that it is you took too long.',
  busy: 'Not done: another check is already open.',
  unknown: 'Not done: Penmoss does not know that change.',
} as const;

const refuse = (message: string): AdminCheckAnswer => ({ ok: false, message });

/** Touch ID through Electron (`systemPreferences`), where the Mac has it. */
export interface TouchId {
  /** Whether Touch ID can be asked now (enrolled, not locked out). */
  can(): boolean;
  /** Resolves when the finger matched; rejects when it did not, or was cancelled. */
  prompt(reason: string): Promise<void>;
}

export class AdminCheck {
  private running: Promise<AdminCheckAnswer> | null = null;
  /**
   * A Touch ID prompt still on screen. Electron cannot close it, so after a check runs out of
   * time no other check opens until it ends: a finger on it must not seem to answer another one.
   */
  private prompting: Promise<void> | null = null;

  constructor(
    private readonly options: {
      /** The helper's path; null where there is none (not macOS). */
      readonly helper: string | null;
      readonly run: HelperRunner;
      readonly timeoutMs?: number;
      /** Touch ID for main's own checks; absent, or unable, they use the helper. */
      readonly touchId?: TouchId | null;
    },
  ) {}

  /**
   * One of main's own checks (A855): `words` come from main, never from the page. Touch ID where
   * the Mac has it, else the helper (Touch ID or the password). One check at a time, as `confirm`.
   */
  confirmOwn(words: string): Promise<AdminCheckAnswer> {
    if (typeof words !== 'string' || words.trim() === '') {
      return Promise.resolve(refuse(MESSAGES.unknown));
    }
    if (this.running || this.prompting) return Promise.resolve(refuse(MESSAGES.busy));
    const touchId = this.options.touchId;
    let usable: boolean;
    try {
      usable = touchId?.can() === true;
    } catch {
      usable = false;
    }
    if (usable && touchId) {
      this.running = this.askTouchId(touchId, words).finally(() => {
        this.running = null;
      });
      return this.running;
    }
    if (!this.options.helper) return Promise.resolve(refuse(MESSAGES.notMac));
    this.running = this.ask(this.options.helper, words).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async askTouchId(touchId: TouchId, words: string): Promise<AdminCheckAnswer> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let prompt: Promise<void>;
    try {
      prompt = touchId.prompt(words);
    } catch {
      return refuse(MESSAGES.refused);
    }
    const ended = prompt.then(
      () => undefined,
      () => undefined,
    );
    this.prompting = ended;
    void ended.then(() => {
      if (this.prompting === ended) this.prompting = null;
    });
    try {
      const timeout = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), this.options.timeoutMs ?? CHECK_TIMEOUT_MS);
      });
      const answer = await Promise.race([prompt.then(() => 'ok' as const), timeout]);
      return answer === 'ok' ? { ok: true } : refuse(MESSAGES.timeout);
    } catch {
      return refuse(MESSAGES.refused);
    } finally {
      clearTimeout(timer);
    }
  }

  private async ask(helper: string, words: string): Promise<AdminCheckAnswer> {
    let outcome: HelperOutcome;
    try {
      outcome = await this.options.run(helper, words, this.options.timeoutMs ?? CHECK_TIMEOUT_MS);
    } catch (error) {
      outcome = { kind: 'error', error: error instanceof Error ? error : new Error(String(error)) };
    }
    return answerOf(outcome);
  }
}

/** The page's answer for how the helper ended: only exit code 0 is a yes. */
export function answerOf(outcome: HelperOutcome): AdminCheckAnswer {
  if (outcome.kind === 'timeout') return refuse(MESSAGES.timeout);
  if (outcome.kind === 'error') return refuse(MESSAGES.missing);
  switch (outcome.code) {
    case HELPER_EXIT.confirmed:
      return { ok: true };
    case HELPER_EXIT.refused:
      return refuse(MESSAGES.refused);
    case HELPER_EXIT.unavailable:
      return refuse(MESSAGES.unavailable);
    default:
      // A crash, a signal, a usage error: the check did not happen.
      return refuse(MESSAGES.missing);
  }
}

/** Runs the helper as a child process: no shell, no environment from the page, no input. */
export const runHelper: HelperRunner = (helper, reason, timeoutMs) =>
  new Promise((resolve) => {
    let settled = false;
    const settle = (outcome: HelperOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(helper, [reason], { stdio: ['ignore', 'ignore', 'pipe'], shell: false });
    } catch (error) {
      resolve({ kind: 'error', error: error instanceof Error ? error : new Error(String(error)) });
      return;
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      settle({ kind: 'timeout' });
    }, timeoutMs);
    child.stderr?.on('data', (chunk: Buffer) => {
      console.warn(`[penmoss] owner check: ${chunk.toString().trim()}`);
    });
    child.on('error', (error) => settle({ kind: 'error', error }));
    child.on('exit', (code) => settle({ kind: 'exit', code }));
  });
