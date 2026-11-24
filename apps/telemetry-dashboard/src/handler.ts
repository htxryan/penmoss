/**
 * Usage analytics' dashboard Worker (PEN-137) on stats.penmoss.app, its requests (index.ts is the
 * entry, which may export nothing but the handler). Every request, the page's
 * files included, needs a valid Cloudflare Access JWT (access.ts), or it gets 403. Then
 * GET /api/<view> answers JSON from the named queries (api.ts), cached for 5 minutes, and
 * anything else is the page's static files. It only reads: GET and HEAD, nothing else.
 */
import { dayOf } from '@penmoss/telemetry/day';
import type { AccessEnv, AccessVerifier } from './access';
import { BadRequest, VIEWS, freshness, readFilters, viewData, type View } from './api';

export interface DashboardEnv extends AccessEnv {
  readonly DB: D1Database;
  readonly ASSETS: Fetcher;
}

export interface Deps {
  readonly verifier: AccessVerifier;
  readonly now: () => number;
  /** The Cache API's cache, or null for none. */
  readonly cache: Cache | null;
}

/** How long an answer is kept in the Cache API. */
export const CACHE_SECONDS = 300;

const headers = {
  'cache-control': 'private, no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

const json = (body: unknown, status = 200) => Response.json(body, { status, headers });
const forbidden = () => new Response('Forbidden', { status: 403, headers });

/**
 * The page's own rules: its files only, nothing from elsewhere. A session's Playback (PEN-178)
 * draws its frame in an iframe of the page's own, /player (player.html, which wrangler serves
 * without its extension), so the page may frame itself.
 */
const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
  "connect-src 'self'; frame-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/** The replay's frame: the one response the page itself may frame, and nothing else may. */
export const FRAME_PATH = '/player';
const FRAME_CSP = CSP.replace("frame-ancestors 'none'", "frame-ancestors 'self'");

async function api(
  url: URL,
  env: DashboardEnv,
  ctx: ExecutionContext,
  deps: Deps,
): Promise<Response> {
  const view = url.pathname.slice('/api/'.length);
  if (!(VIEWS as readonly string[]).includes(view)) return json({ error: 'No such view.' }, 404);
  let filters;
  try {
    filters = readFilters(url, view as View);
  } catch (error) {
    if (error instanceof BadRequest) return json({ error: error.message }, 400);
    throw error;
  }
  // The cache is keyed by the URL alone, with its parameters in one order; it is reached only
  // after Access let the request through.
  const key = new URL(url.pathname, url.origin);
  for (const [name, value] of [...url.searchParams].sort(([a], [b]) => a.localeCompare(b))) {
    key.searchParams.append(name, value);
  }
  const cacheKey = new Request(key.toString(), { method: 'GET' });
  const hit = await deps.cache?.match(cacheKey);
  if (hit) {
    const body = await hit.text();
    return new Response(body, {
      headers: { ...headers, 'content-type': 'application/json', 'x-dashboard-cache': 'hit' },
    });
  }
  const now = deps.now();
  const [data, fresh] = await Promise.all([
    viewData(env.DB, view as View, filters, now),
    freshness(env.DB, now),
  ]);
  const body = JSON.stringify({
    view,
    filters,
    today: dayOf(now),
    // When this answer was made (it is cached up to CACHE_SECONDS), the newest event, the rollup.
    asOf: now,
    ...fresh,
    ...data,
  });
  if (deps.cache) {
    const stored = new Response(body, {
      headers: { 'content-type': 'application/json', 'cache-control': `max-age=${CACHE_SECONDS}` },
    });
    ctx.waitUntil(deps.cache.put(cacheKey, stored));
  }
  return new Response(body, { headers: { ...headers, 'content-type': 'application/json' } });
}

/** Answers one request. */
export async function handle(
  request: Request,
  env: DashboardEnv,
  ctx: ExecutionContext,
  deps: Deps,
): Promise<Response> {
  if (!(await deps.verifier.verify(request, env, deps.now()))) return forbidden();
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method Not Allowed', {
      status: 405,
      headers: { ...headers, allow: 'GET, HEAD' },
    });
  }
  const url = new URL(request.url);
  if (url.pathname.startsWith('/api/')) return api(url, env, ctx, deps);
  const asset = await env.ASSETS.fetch(request);
  const response = new Response(asset.body, asset);
  for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
  const frame = url.pathname === FRAME_PATH;
  response.headers.set('content-security-policy', frame ? FRAME_CSP : CSP);
  response.headers.set('x-frame-options', frame ? 'SAMEORIGIN' : 'DENY');
  return response;
}
