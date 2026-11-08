/**
 * The client of a git notebook's local API (T50, A820; T59, A1050): the REST shapes the MCP tools
 * and the CLI share, served in this process by `@penmoss/git-notebook`'s local notebook over the
 * session's own fetch. Nothing goes over a network: the base is `http://notebook.invalid`, which
 * never resolves. Every reply is JSON; a refusal is `{ error: { code, message, details? } }` and
 * becomes an `ApiError` with an exit code.
 *
 * Nothing is retried: the API is in this process, so a request either answered or threw. A create
 * still carries an `Idempotency-Key` (A135), which the local notebook remembers for this process.
 */
import { ApiError, CliError, EXIT } from './errors';
import type { FetchLike } from './io';
import { VERSION } from './version';

export interface RequestOptions {
  readonly query?: Record<string, string | number | undefined>;
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
}

export class Client {
  constructor(
    readonly base: string,
    private readonly fetch: FetchLike,
  ) {}

  get<T>(path: string, query?: RequestOptions['query']): Promise<T> {
    return this.request<T>('GET', path, query ? { query } : {});
  }

  async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const url = new URL(path, this.base);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'User-Agent': `penmoss-cli/${VERSION}`,
      ...options.headers,
    };
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await this.fetch(url.toString(), {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
    });
    return this.reply<T>(response.status, await response.text());
  }

  private reply<T>(status: number, text: string): T {
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = undefined;
    }
    if (status >= 200 && status < 300) {
      if (body === undefined) {
        throw new CliError(EXIT.ERROR, 'The notebook answered with something other than JSON.');
      }
      return body as T;
    }
    const error = (body as { error?: { code?: unknown; message?: unknown; details?: unknown } })
      ?.error;
    if (error && typeof error.code === 'string') {
      const details =
        typeof error.details === 'object' && error.details !== null
          ? (error.details as Record<string, unknown>)
          : undefined;
      // What in the markdown the notebook could not store (A172); --json carries it in details.
      const hints =
        error.code === 'unsupported_markdown' && typeof details?.['problem'] === 'string'
          ? [details['problem']]
          : [];
      throw new ApiError(
        status,
        error.code,
        typeof error.message === 'string' ? error.message : error.code,
        details,
        hints,
      );
    }
    throw new ApiError(status, 'http_error', `The notebook answered ${status}.`);
  }
}
