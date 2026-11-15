/**
 * What every client's engine host shares (T50 G3, G7; A822, A825, A859, A1013): the Mac's
 * `GitEngineHost` (apps/web) and Android's `AndroidGitHost` (apps/android/editor) run the same
 * cadence, with the same bounds, retries and words for a failure. Each host keeps its own
 * transport, store and status; this is the part that does not depend on the platform.
 */
import { NotebookError, type GitNotebookEngine } from '../engine';
import { GitRefused, GitTransportError, privateEmailAdvice } from '../transport';

/** The longest one sync may take before it is stopped and counted as offline (A859). */
export const SYNC_LIMIT_MS = 90_000;
/**
 * As the window closes, the app quits or leaves the screen (A825, #170 F8, #174 review): how long
 * a push may take, one already running included. A sync on a slow Mac takes longer than the 2.5 s
 * it once had, so the push was left to the next launch.
 */
export const CLOSING_SYNC_MS = 10_000;
/**
 * How long the network must stay up after an `online` event before the backoff is reset and a
 * sync runs (#174 review): a network that flaps is not chased on every event.
 */
export const ONLINE_SETTLE_MS = 2000;
/** Failures back off from this, doubling to `RETRY_MAX_MS`. */
export const RETRY_MIN_MS = 30_000;
export const RETRY_MAX_MS = 10 * 60_000;
/** Coming to the front (a focus, the app shown) pulls at most this often. */
export const FRONT_PULL_GAP_MS = 30_000;
/** Edits that keep coming are pushed at least this many push delays after the first. */
export const MAX_PUSH_DELAYS = 5;
/**
 * The sync cadence (A1013): push 12 s after edits settle, pull every minute while the app is in
 * front. Each notebook may have its own; these are the defaults.
 */
export const PUSH_DELAY_S = 12;
export const PULL_EVERY_MIN = 1;

/** A sync that ran out of time (A859). */
export class SyncTimeout extends Error {
  constructor(ms: number) {
    super(`The git host did not answer within ${Math.round(ms / 1000)} s.`);
    this.name = 'SyncTimeout';
  }
}

/** What the engine has not pushed yet: its marked notes, and the WorkspaceDoc (`workspace`). */
export function pendingOf(engine: GitNotebookEngine): string[] {
  const state = engine.replica.state;
  return [...Object.keys(state.dirty), ...(state.workspaceDirty ? ['workspace'] : [])];
}

/** A client's words in a failure: where changes wait, and where its settings are. */
export interface FailureWords {
  /** Said after most failures: `Changes stay on this device and go once it syncs.` */
  readonly kept: string;
  /** What to check when the host does not sign in, ending with where (`… in Settings → Notebooks`). */
  readonly signIn: string;
  /** Where to set the commit email when the host refuses a private one (`privateEmailAdvice`). */
  readonly email: string;
}

/** How a failed sync shows: offline or stopped, why, and what the host said. */
export interface SyncFailure {
  readonly phase: 'offline' | 'stopped';
  readonly code: string;
  readonly detail: string;
  readonly hostMessage: string | null;
}

/**
 * A failure as the status says it (A824, A859): offline, or stopped, saying why and what to do,
 * in the client's `words`; `log` when it is not one the person can act on.
 */
export function describeFailure(
  error: unknown,
  host: string,
  words: FailureWords,
): { status: SyncFailure; log: boolean } {
  const { kept } = words;
  if (error instanceof SyncTimeout) {
    return {
      status: {
        phase: 'offline',
        code: 'timeout',
        detail: `${error.message} ${kept}`,
        hostMessage: null,
      },
      log: false,
    };
  }
  if (error instanceof GitRefused) {
    return {
      status: {
        phase: 'stopped',
        code: error.code,
        detail: error.message,
        hostMessage: error.hostMessage ?? null,
      },
      log: false,
    };
  }
  if (error instanceof GitTransportError) {
    const hostMessage = error.hostMessage ?? null;
    switch (error.code) {
      case 'network':
      case 'timeout':
        return {
          status: {
            phase: 'offline',
            code: error.code,
            detail: `Can't reach ${host}. ${kept}`,
            hostMessage,
          },
          log: false,
        };
      case 'auth':
        return {
          status: {
            phase: 'stopped',
            code: 'auth',
            detail: `Can't sign in to ${host}. ${words.signIn}. ${kept}`,
            hostMessage,
          },
          log: false,
        };
      case 'protected':
      case 'rules':
      case 'refused':
        return {
          status: {
            phase: 'stopped',
            code: error.code,
            detail:
              privateEmailAdvice(hostMessage ?? error.message, words.email) ??
              `${host} refused the push${hostMessage ? `: ${hostMessage}` : '.'} ${kept}`,
            hostMessage,
          },
          log: false,
        };
      default:
        return {
          status: {
            phase: 'stopped',
            code: error.code,
            detail: `${error.message} ${kept}`,
            hostMessage,
          },
          log: error.code === 'git',
        };
    }
  }
  if (error instanceof NotebookError) {
    return {
      status: { phase: 'stopped', code: error.code, detail: error.message, hostMessage: null },
      log: false,
    };
  }
  return {
    status: {
      phase: 'stopped',
      code: 'error',
      detail: `${error instanceof Error ? error.message : String(error)} ${kept}`,
      hostMessage: null,
    },
    log: true,
  };
}

/**
 * `navigator.storage.persist()` (A886): true once the stores are kept under low storage, false
 * when refused, null where the page cannot ask (no StorageManager: Node in the tests, an old
 * WebView).
 */
export async function persistStorage(): Promise<boolean | null> {
  const storage = (globalThis as { navigator?: { storage?: StorageManager } }).navigator?.storage;
  if (!storage || typeof storage.persist !== 'function') return null;
  try {
    if (typeof storage.persisted === 'function' && (await storage.persisted())) return true;
    return await storage.persist();
  } catch {
    return null;
  }
}
