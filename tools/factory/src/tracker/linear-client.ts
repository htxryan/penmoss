/**
 * A small client for Linear's GraphQL API, over `fetch`. The factory acts as its own OAuth app
 * (LD4): its token comes from the host-only `linear.env`, through the client-credentials grant
 * or as a token pasted there, and never enters a sandbox. Errors name what failed, never a token.
 */
import { loadEnvFile } from '../secrets.ts';

export const LINEAR_API = 'https://api.linear.app/graphql';
export const LINEAR_TOKEN_URL = 'https://api.linear.app/oauth/token';

/** The names `linear.env` may hold. It is read on the host alone, never passed to a sandbox. */
export const LINEAR_KEYS = {
  LINEAR_CLIENT_ID: "the factory app's OAuth client ID",
  LINEAR_CLIENT_SECRET: "the factory app's OAuth client secret",
  LINEAR_APP_TOKEN: "an access token for the factory app, instead of the client's ID and secret",
} as const;

export type LinearKey = keyof typeof LINEAR_KEYS;

export class LinearError extends Error {
  /** Linear's error code, such as `RATELIMITED` or `AUTHENTICATION_ERROR`. */
  readonly code: string | undefined;
  constructor(message: string, code?: string) {
    super(message);
    this.name = 'LinearError';
    this.code = code;
  }
}

/** Linear refused for its rate limit; nothing is retried before `resetAt` (ms since the epoch). */
export class LinearRateLimited extends LinearError {
  readonly resetAt: number;
  constructor(resetAt: number) {
    super(`Linear's rate limit: try again after ${new Date(resetAt).toISOString()}`, 'RATELIMITED');
    this.name = 'LinearRateLimited';
    this.resetAt = resetAt;
  }
}

export interface LinearClient {
  request<T>(query: string, variables?: Readonly<Record<string, unknown>>): Promise<T>;
}

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

export interface ClientOptions {
  /** The token for each request: an OAuth access token, or a personal key (`lin_api_…`). */
  readonly token: () => Promise<string>;
  readonly fetcher?: Fetcher;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** The longest the client waits out a rate limit before it gives up on the request. */
  readonly maxWaitMs?: number;
}

/** A personal API key goes as it is; an OAuth token as a bearer token. */
export function authorization(token: string): string {
  return token.startsWith('lin_api_') ? token : `Bearer ${token}`;
}

interface Body<T> {
  readonly data?: T;
  readonly errors?: readonly {
    readonly message: string;
    readonly extensions?: { readonly code?: string };
  }[];
}

export function createLinearClient(options: ClientOptions): LinearClient {
  const fetcher = options.fetcher ?? ((url, init) => fetch(url, init));
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const maxWait = options.maxWaitMs ?? 120_000;
  // Once limited, every request waits for the reset rather than spend more of the budget.
  let limitedUntil = 0;

  const once = async <T>(query: string, variables: Readonly<Record<string, unknown>>) => {
    const res = await fetcher(LINEAR_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authorization(await options.token()),
      },
      body: JSON.stringify({ query, variables }),
    });
    const body = (await res.json().catch(() => ({}))) as Body<T>;
    const limited =
      res.status === 429 || body.errors?.some((e) => e.extensions?.code === 'RATELIMITED');
    if (limited) {
      const reset = Number(
        res.headers.get('x-ratelimit-requests-reset') ??
          res.headers.get('x-ratelimit-complexity-reset'),
      );
      return { limited: Number.isFinite(reset) && reset > now() ? reset : now() + 60_000 };
    }
    if (!res.ok || body.errors?.length) {
      const first = body.errors?.[0];
      throw new LinearError(
        `Linear API: ${body.errors?.map((e) => e.message).join('; ') || `HTTP ${res.status}`}`,
        first?.extensions?.code,
      );
    }
    if (body.data === undefined) throw new LinearError('Linear API: the response had no data');
    return { data: body.data };
  };

  return {
    async request<T>(query: string, variables: Readonly<Record<string, unknown>> = {}) {
      for (let attempt = 0; ; attempt++) {
        const wait = limitedUntil - now();
        if (wait > 0) {
          if (wait > maxWait || attempt > 1) throw new LinearRateLimited(limitedUntil);
          await sleep(wait);
        }
        const result = await once<T>(query, variables);
        if ('data' in result) return result.data;
        limitedUntil = result.limited;
        if (attempt >= 1) throw new LinearRateLimited(limitedUntil);
      }
    },
  };
}

export type LinearCredentials = Readonly<Partial<Record<LinearKey, string>>>;

/** `linear.env`: the app's client ID and secret, or an app token; mode 600 like factory.env. */
export function loadLinearCredentials(
  path: string,
): { ok: true; credentials: LinearCredentials } | { ok: false; error: string } {
  const loaded = loadEnvFile(path, LINEAR_KEYS);
  if (!loaded.ok) return loaded;
  const c = loaded.secrets;
  if (!c.LINEAR_APP_TOKEN && !(c.LINEAR_CLIENT_ID && c.LINEAR_CLIENT_SECRET))
    return {
      ok: false,
      error: `${path} needs LINEAR_CLIENT_ID and LINEAR_CLIENT_SECRET, or LINEAR_APP_TOKEN`,
    };
  return { ok: true, credentials: c };
}

/**
 * The app's token. With a client ID and secret it comes from the client-credentials grant, so
 * the factory acts as the app itself, and is renewed a day before it expires.
 */
export function appToken(
  credentials: LinearCredentials,
  fetcher: Fetcher = (url, init) => fetch(url, init),
  now: () => number = Date.now,
): () => Promise<string> {
  const fixed = credentials.LINEAR_APP_TOKEN;
  if (fixed) return () => Promise.resolve(fixed);
  let cached: { token: string; until: number } | undefined;
  return async () => {
    if (cached && cached.until > now()) return cached.token;
    const res = await fetcher(LINEAR_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: credentials.LINEAR_CLIENT_ID ?? '',
        client_secret: credentials.LINEAR_CLIENT_SECRET ?? '',
        scope: 'read,write',
      }).toString(),
    });
    const body = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      expires_in?: number;
      error?: string;
    };
    if (!res.ok || !body.access_token)
      throw new LinearError(
        `Linear's token endpoint refused the factory app: ${body.error ?? `HTTP ${res.status}`}`,
      );
    const lifetime = (body.expires_in ?? 86_400) * 1000;
    cached = {
      token: body.access_token,
      until: now() + Math.max(lifetime - 86_400_000, lifetime / 2),
    };
    return cached.token;
  };
}
