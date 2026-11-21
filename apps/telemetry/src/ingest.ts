/**
 * The ingest Worker's two routes (PEN-137): POST /v1/batch writes a shared batch's valid events
 * to D1, POST /v1/forget deletes everything an install shared. Everything else is 404: there is
 * no route that reads events back out.
 *
 * Each event is checked again here against the format and the catalogue (core's validateBatch),
 * so a name that isn't catalogued, or a prop that could hold free text, never reaches D1. The
 * caller's IP address is only the rate limiter's key: no table has a column for it.
 */
import {
  BATCH_VERSION,
  INSTALL_PATTERN,
  MAX_BATCH_BYTES,
  validateBatch,
  type AnalyticsEvent,
} from '@penmoss/core/analytics';
import { dayOf } from './day';

export interface TelemetryEnv {
  readonly DB: D1Database;
  /** 60 batches a minute per install (PEN-177: typing sends about 5 a minute). */
  readonly INSTALL_LIMIT: RateLimit;
  /** 240 requests a minute per IP address (PEN-177). */
  readonly IP_LIMIT: RateLimit;
  /** 5 forgets a minute per IP address. */
  readonly FORGET_LIMIT: RateLimit;
}

/** What a batch's answer says (202): the clients mark the refused indexes refused. */
export interface BatchAnswer {
  readonly accepted: number;
  readonly dropped: number;
  /** The index in the batch of each event dropped. */
  readonly refused: readonly number[];
}

/** Seconds a client waits after a 429 or a 503. */
export const RETRY_AFTER_SECONDS = 60;

const json = (body: unknown, status: number, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store', ...headers } });

const notFound = () => json({ error: 'Not found.' }, 404);
const tooMany = () =>
  json({ error: 'Too many requests.' }, 429, { 'retry-after': String(RETRY_AFTER_SECONDS) });
const unavailable = () =>
  json({ error: 'Try again later.' }, 503, { 'retry-after': String(RETRY_AFTER_SECONDS) });

/** The body as text, or null when it is over `max` bytes (read no further than that). */
async function readLimited(request: Request, max: number): Promise<string | null> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) return null;
  if (!request.body) return '';
  const reader = (request.body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The rate limiter's key for the caller: its IP address, kept nowhere else. */
const ipKey = (request: Request) => request.headers.get('cf-connecting-ip') ?? 'unknown';

const INSERT_EVENT = `INSERT OR IGNORE INTO events
  (received_at, day, install, session, seq, at, client, actor, version, channel, os, os_version,
   size_class, kind, name, props)
  VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)`;

const COUNT_BATCH = `INSERT INTO ingest_daily (day, batches, accepted, dropped)
  VALUES (?1, 1, ?2, ?3)
  ON CONFLICT (day) DO UPDATE SET batches = batches + 1, accepted = accepted + excluded.accepted,
    dropped = dropped + excluded.dropped`;

const COUNT_WRITTEN = `UPDATE ingest_daily SET written = written + ?2 WHERE day = ?1`;

/** One event's INSERT OR IGNORE, received at `now`. */
export function insertEvent(db: D1Database, install: string, event: AnalyticsEvent, now: number) {
  // An event's day is its own, never later than when it arrived (a clock set ahead).
  const day = dayOf(Math.min(event.at, now));
  return db
    .prepare(INSERT_EVENT)
    .bind(
      now,
      day,
      install,
      event.session,
      event.seq,
      event.at,
      event.client,
      event.actor,
      event.version,
      event.channel,
      event.os,
      event.osVersion,
      event.sizeClass ?? null,
      event.kind,
      event.name,
      JSON.stringify(event.props),
    );
}

async function batch(request: Request, env: TelemetryEnv, now: number): Promise<Response> {
  const text = await readLimited(request, MAX_BATCH_BYTES);
  if (text === null) return json({ error: 'A batch is at most 64 KB.' }, 413);
  const checked = validateBatch(parse(text));
  if (!checked) return json({ error: 'Not a batch.' }, 400);
  const { install, valid, refused } = checked;
  if (!(await env.INSTALL_LIMIT.limit({ key: install })).success) return tooMany();
  const today = dayOf(now);
  const answer: BatchAnswer = { accepted: valid.length, dropped: refused.length, refused };
  const count = env.DB.prepare(COUNT_BATCH).bind(today, valid.length, refused.length);
  try {
    if (valid.length === 0) {
      await count.run();
      return json({ error: 'No valid events.', ...answer }, 400);
    }
    // One batch: D1 runs it as one transaction, so a batch is written whole or not at all.
    const results = await env.DB.batch([
      ...valid.map((event) => insertEvent(env.DB, install, event, now)),
      count,
    ]);
    const written = results
      .slice(0, valid.length)
      .reduce((sum, result) => sum + (result.meta.changes ?? 0), 0);
    if (written > 0) await env.DB.prepare(COUNT_WRITTEN).bind(today, written).run();
  } catch {
    return unavailable();
  }
  return json(answer, 202);
}

async function forget(request: Request, env: TelemetryEnv, now: number): Promise<Response> {
  if (!(await env.FORGET_LIMIT.limit({ key: ipKey(request) })).success) return tooMany();
  const text = await readLimited(request, 1024);
  if (text === null) return json({ error: 'Too large.' }, 413);
  const body = parse(text) as { v?: unknown; install?: unknown } | undefined;
  const install = body?.install;
  if (body?.v !== BATCH_VERSION || typeof install !== 'string' || !INSTALL_PATTERN.test(install)) {
    return json({ error: 'Not a forget request.' }, 400);
  }
  try {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM events WHERE install = ?1').bind(install),
      env.DB.prepare('DELETE FROM daily_installs WHERE install = ?1').bind(install),
      env.DB.prepare(
        `INSERT INTO ingest_daily (day, forgets) VALUES (?1, 1)
         ON CONFLICT (day) DO UPDATE SET forgets = forgets + 1`,
      ).bind(dayOf(now)),
    ]);
  } catch {
    return unavailable();
  }
  return json({ forgotten: true }, 200);
}

/** Answers one request at time `now` (ms since the epoch). */
export async function handle(request: Request, env: TelemetryEnv, now: number): Promise<Response> {
  const { pathname } = new URL(request.url);
  const route =
    request.method === 'POST' && pathname === '/v1/batch'
      ? batch
      : request.method === 'POST' && pathname === '/v1/forget'
        ? forget
        : null;
  if (!route) return notFound();
  if (!(await env.IP_LIMIT.limit({ key: ipKey(request) })).success) return tooMany();
  return route(request, env, now);
}
