/**
 * The last client errors, for Send feedback's sixth group (T49, A791): an in-memory ring of the
 * last 10 uncaught errors, unhandled rejections and errors the app logged, with a stack trimmed
 * to the app's own frames. Nothing leaves the page from here: the form reads the ring when it
 * opens, redacts each entry (core `redactText`) and drops any that quotes the open note's text.
 */
import { FEEDBACK_LIMITS } from '@penmoss/core/feedback';

export interface RecentError {
  readonly at: number;
  readonly message: string;
  /** App frames only, at most MAX_FRAMES. */
  readonly stack: string;
}

const MAX_FRAMES = 6;
/** Frames from browser extensions and other origins are not the app's. */
const FOREIGN = /(chrome|moz|safari)-extension:\/\/|\bnode_modules\b/;
const FRAME = /^\s*(at\s|\S*@)/;

/** The app's own frames of `stack` (`at …` or `fn@…` lines from this origin), the first few. */
export function appFrames(stack: string, origin: string): string {
  const frames = stack
    .split('\n')
    .filter((line) => FRAME.test(line))
    .filter((line) => !FOREIGN.test(line))
    .filter((line) => !/https?:\/\//.test(line) || (origin !== '' && line.includes(origin)))
    .map((line) => line.trim().replace(origin, ''));
  return frames.slice(0, MAX_FRAMES).join('\n');
}

const MAX_MESSAGE = 500;
const MAX_DETAIL = 4000;

/** An error's message and stack, trimmed; anything else is named by its type only (review N3). */
export function describeClientError(error: unknown): { message: string; detail: string } {
  if (error instanceof Error) {
    return {
      message: `${error.name}: ${error.message}`.slice(0, MAX_MESSAGE),
      detail: (error.stack ?? '').slice(0, MAX_DETAIL),
    };
  }
  // A rejected value may be a note or a body: its contents are never kept.
  let text: string;
  if (typeof error === 'string') text = error;
  else if (error === null || typeof error !== 'object') text = `Non-error ${String(error)}`;
  else text = `Non-error object (${error.constructor?.name ?? 'Object'})`;
  return { message: (text || 'Unknown error').slice(0, MAX_MESSAGE), detail: '' };
}

export class ErrorRing {
  private readonly entries: RecentError[] = [];
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly origin: string = typeof location === 'undefined' ? '' : location.origin,
    private readonly size: number = FEEDBACK_LIMITS.recent,
  ) {}

  /** Records `error` (anything thrown or rejected, or what the app logged). */
  push(error: unknown, at: number = Date.now()): void {
    const { message, detail } = describeClientError(error);
    this.entries.push({ at, message, stack: appFrames(detail, this.origin) });
    while (this.entries.length > this.size) this.entries.shift();
    for (const listener of this.listeners) listener();
  }

  /** The entries, newest first. */
  recent(): RecentError[] {
    return [...this.entries].reverse();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Records uncaught errors, unhandled rejections and `console.error` calls on `target` (the
   * page's own `console.error` still runs). Returns the uninstaller.
   */
  install(
    target: Pick<Window, 'addEventListener' | 'removeEventListener'>,
    log: Pick<Console, 'error'> = console,
  ): () => void {
    const onError = (event: Event) => {
      const uncaught = event as ErrorEvent;
      this.push(uncaught.error ?? uncaught.message);
    };
    const onRejection = (event: Event) => this.push((event as PromiseRejectionEvent).reason);
    target.addEventListener('error', onError);
    target.addEventListener('unhandledrejection', onRejection);
    const original = log.error.bind(log);
    const wrapped = (...args: unknown[]) => {
      try {
        this.push(loggedError(args));
      } catch {
        // Recording must never stop the log.
      }
      original(...args);
    };
    log.error = wrapped;
    return () => {
      target.removeEventListener('error', onError);
      target.removeEventListener('unhandledrejection', onRejection);
      if (log.error === wrapped) log.error = original;
    };
  }
}

/** The app's own `console.error` calls start with their area's tag: `[notes] …`. */
const APP_TAG = /^\[[a-z][a-z0-9 -]*\]/;

/**
 * What a `console.error(…)` call logged, as one error: the first Error's name and message, with
 * that Error's stack, and the call's string arguments only when the call is the app's own (it
 * starts with an area tag, `[notes] …`); a library's or React's words are named `(text)`, as
 * anything else is named by its type only, as the error reporter does (a value may be a note).
 */
export function loggedError(args: readonly unknown[]): Error {
  const words: string[] = [];
  let cause: Error | null = null;
  const own = typeof args[0] === 'string' && APP_TAG.test(args[0]);
  for (const arg of args) {
    if (typeof arg === 'string') words.push(own ? arg : '(text)');
    else if (arg instanceof Error) {
      cause ??= arg;
      words.push(`${arg.name}: ${arg.message}`);
    } else if (arg === null || typeof arg !== 'object') words.push(String(arg));
    else words.push(`(${arg.constructor?.name ?? 'Object'})`);
  }
  const error = new Error(words.join(' '));
  error.name = 'Logged';
  error.stack = cause?.stack ?? '';
  return error;
}

/** The app's ring (main.tsx installs it on the window). */
export const errorRing = new ErrorRing();
