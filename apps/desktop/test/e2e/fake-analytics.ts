/**
 * Usage analytics in the Mac app's suite (PEN-137): a stand-in for its endpoint (t.penmoss.app in
 * production), which a spec starts on loopback and hands the app as `PENMOSS_ANALYTICS_URL`
 * (`launch({ env })`); main's hook that sends what waits now; the page's record, status and
 * seeding through the bridge; and the canary notebook's strings (test/fixtures/canary-notebook),
 * none of which may leave the Mac or reach the record (AC14).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ElectronApplication, Page } from '@playwright/test';
import type { DesktopAnalyticsStatus, PageEvent } from '../../../web/src/desktop/bridge';

/** An event as a batch carries it (core's AnalyticsEvent, as JSON). */
export interface WireEvent {
  readonly session: string;
  readonly seq: number;
  readonly at: number;
  readonly client: string;
  readonly actor: string;
  readonly kind: string;
  readonly name: string;
  readonly props: Readonly<Record<string, unknown>>;
}

interface Batch {
  readonly v: number;
  readonly install: string;
  readonly events: readonly WireEvent[];
}

export interface FakeAnalytics {
  /** The origin to hand the app as `PENMOSS_ANALYTICS_URL`. */
  readonly url: string;
  /** Every request, as `METHOD /path`, in order. */
  readonly requests: string[];
  /** Each POST /v1/batch body, byte for byte. */
  readonly bodies: string[];
  readonly batches: Batch[];
  /** Each POST /v1/forget's install. */
  readonly forgets: string[];
  /** While true, POST /v1/batch answers 503: the app keeps the events and tries later. */
  down: boolean;
  /** Every event taken so far, in the order the batches came. */
  events(): WireEvent[];
  close(): Promise<void>;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Starts the stand-in on 127.0.0.1 (a free port): POST /v1/batch takes every event (202, as the
 * ingest Worker answers) and POST /v1/forget answers 200; anything else is 404.
 */
export async function fakeAnalytics(): Promise<FakeAnalytics> {
  const state = {
    requests: [] as string[],
    bodies: [] as string[],
    batches: [] as Batch[],
    forgets: [] as string[],
    down: false,
  };
  const server = createServer((request, response) => {
    void (async () => {
      const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      const body = await readBody(request);
      state.requests.push(`${request.method ?? 'GET'} ${path}`);
      const answer = (status: number, value: unknown) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(value));
      };
      if (request.method === 'POST' && path === '/v1/batch') {
        if (state.down) return answer(503, { error: 'unavailable' });
        state.bodies.push(body);
        const batch = JSON.parse(body) as Batch;
        state.batches.push(batch);
        return answer(202, { accepted: batch.events.length, dropped: 0, refused: [] });
      }
      if (request.method === 'POST' && path === '/v1/forget') {
        state.forgets.push((JSON.parse(body) as { install: string }).install);
        return answer(200, { ok: true });
      }
      return answer(404, { error: 'not found' });
    })();
  });
  await new Promise<void>((listening) => server.listen(0, '127.0.0.1', () => listening()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests: state.requests,
    bodies: state.bodies,
    batches: state.batches,
    forgets: state.forgets,
    get down() {
      return state.down;
    },
    set down(value: boolean) {
      state.down = value;
    },
    events: () => state.batches.flatMap((batch) => batch.events),
    close: () =>
      new Promise<void>((closed) => {
        server.closeAllConnections();
        server.close(() => closed());
      }),
  };
}

/**
 * The app's environment for a spec with the stand-in: its address, and nothing in the suite's
 * own environment (DO_NOT_TRACK, PENMOSS_ANALYTICS=off) keeping the app's events on the Mac.
 */
export const analyticsEnv = (endpoint: Pick<FakeAnalytics, 'url'>) => ({
  PENMOSS_ANALYTICS_URL: endpoint.url,
  DO_NOT_TRACK: '0',
  PENMOSS_ANALYTICS: 'on',
});

/** Main's test hooks for analytics (main.ts, `penmossDesktop`). */
interface AnalyticsHooks {
  penmossDesktop: {
    analyticsSend(): Promise<{ kind: string } | null>;
    logFile(): string;
  };
}

/** Sends what waits now, as the minute's timer would (nothing without consent). */
export const sendNow = (app: ElectronApplication): Promise<string | null> =>
  app.evaluate(async () => {
    const outcome = await (globalThis as unknown as AnalyticsHooks).penmossDesktop.analyticsSend();
    return outcome?.kind ?? null;
  });

/** The log file main writes (`PENMOSS_LOG_DIR`'s penmoss.log). */
export const logFilePath = (app: ElectronApplication): Promise<string> =>
  app.evaluate(() => (globalThis as unknown as AnalyticsHooks).penmossDesktop.logFile());

/** Usage analytics' status as Settings → Privacy reads it. */
export const analyticsStatus = (page: Page): Promise<DesktopAnalyticsStatus> =>
  page.evaluate(() => window.penmossDesktop!.analytics!.status());

/** How many events the record on this Mac holds, whatever their state. */
export const recordTotal = (page: Page): Promise<number> =>
  page.evaluate(async () => (await window.penmossDesktop!.analytics!.page({ limit: 1 })).total);

/**
 * Puts `count` events in the record, as the page records them (catalogued screens, one a second
 * back from now, so the newest stay the newest), in messages of at most 200 (main's limit).
 */
export async function seedEvents(page: Page, count: number): Promise<void> {
  await page.evaluate((total) => {
    const now = Date.now();
    const all: PageEvent[] = Array.from({ length: total }, (_each, index) => ({
      kind: 'screen',
      name: index % 2 === 0 ? 'graph' : 'tags',
      props: {},
      at: now - (index + 1) * 1000,
    }));
    for (let from = 0; from < all.length; from += 200) {
      window.penmossDesktop!.analytics!.record(all.slice(from, from + 200));
    }
  }, count);
}

// --- the canary notebook (AC14) ---

interface Canaries {
  readonly pattern: string;
  readonly notebook: string;
  readonly search: string;
  readonly notes: readonly { readonly path: string; readonly title: string }[];
  readonly folders: readonly string[];
  readonly tags: readonly string[];
  readonly links: readonly string[];
  readonly body: readonly string[];
  readonly strings: readonly string[];
}

export const CANARIES = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL('../../../../test/fixtures/canary-notebook/canaries.json', import.meta.url),
    ),
    'utf8',
  ),
) as Canaries;

/**
 * Which canary strings `text` holds: exact, in any case, or URL-encoded (`%20` or `+` for a
 * space). `also` adds more to look for (the pattern `canary` itself, where nothing may hold it).
 */
export function canaryHits(text: string, also: readonly string[] = []): string[] {
  const lower = text.toLowerCase();
  return [...CANARIES.strings, ...also].filter((canary) => {
    const encoded = encodeURIComponent(canary);
    return [canary, encoded, encoded.replaceAll('%20', '+')].some((form) =>
      lower.includes(form.toLowerCase()),
    );
  });
}

/** Every file under `dir` (none for a folder that isn't there). */
function filesUnder(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    const path = join(dir, name);
    const info = statSync(path, { throwIfNoEntry: false });
    if (!info) return [];
    return info.isDirectory() ? filesUnder(path) : info.isFile() ? [path] : [];
  });
}

/**
 * The files under `dir` whose bytes hold a canary, with which. Read as Latin-1, so a binary
 * file (SQLite's pages, its WAL) is searched byte for byte: every canary is ASCII.
 */
export function canaryFiles(
  dir: string,
  also: readonly string[] = [],
): { file: string; hits: string[] }[] {
  return filesUnder(dir).flatMap((file) => {
    const hits = canaryHits(readFileSync(file).toString('latin1'), also);
    return hits.length > 0 ? [{ file, hits }] : [];
  });
}
