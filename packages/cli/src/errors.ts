/**
 * Exit codes (documented in `penmoss --help` and docs/cli.md) and the errors
 * that carry them. A refusal from a notebook's notes API keeps its code,
 * message and details, so `--json` can pass them on to an agent.
 */
import { LocalError } from '@penmoss/git-notebook/local';

export const EXIT = {
  /** Done. */
  OK: 0,
  /** Anything unexpected: git failed, the repository's host could not be reached. */
  ERROR: 1,
  /** The command line does not fit the command. */
  USAGE: 2,
  /** Not allowed (403), the git host refused the credentials, or they cannot be read safely. */
  AUTH: 3,
  /** No such note, folder, heading, text or version. */
  NOT_FOUND: 4,
  /** The note changed since the edit's base version, is in Trash, or holds newer content (409). */
  CONFLICT: 5,
  /** A title, heading or text matches more than once. */
  AMBIGUOUS: 6,
  /** Refused for another reason (400, 413, 422, 428): the request, or the repository's host. */
  REFUSED: 7,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export class CliError extends Error {
  constructor(
    readonly exitCode: ExitCode,
    message: string,
    readonly code: string = 'error',
    readonly details?: Record<string, unknown>,
    /** Lines printed after the message for people (not in `--json`). */
    readonly hints: readonly string[] = [],
  ) {
    super(message);
  }
}

/** The exit code for a refusal from a notebook's notes API. */
export function exitCodeFor(status: number, code: string): ExitCode {
  if (status === 401 || status === 403) return EXIT.AUTH;
  if (code.endsWith('_ambiguous')) return EXIT.AMBIGUOUS;
  if (status === 404 || code.endsWith('_not_found')) return EXIT.NOT_FOUND;
  if (status === 409) return EXIT.CONFLICT;
  if (status >= 400 && status < 500) return EXIT.REFUSED;
  return EXIT.ERROR;
}

/** A refusal from a notebook's notes API (a `LocalError`): its status, code, message and details. */
export class ApiError extends CliError {
  constructor(
    readonly status: number,
    code: string,
    message: string,
    details?: Record<string, unknown>,
    hints: readonly string[] = [],
  ) {
    super(exitCodeFor(status, code), message, code, details, hints);
  }
}

/**
 * The notes API's refusals as the CLI's: every other error is left as it is. What in the markdown
 * the notebook could not store (A172) is also said for people; `--json` carries it in details.
 */
export function apiErrorOf(error: unknown): unknown {
  if (!(error instanceof LocalError)) return error;
  const details = error.details;
  const hints =
    error.code === 'unsupported_markdown' && typeof details?.['problem'] === 'string'
      ? [details['problem']]
      : [];
  return new ApiError(error.status, error.code, error.message, details, hints);
}
