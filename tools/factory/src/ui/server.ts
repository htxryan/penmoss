/**
 * The Factory UI's server (F20, #276): 127.0.0.1 only, a token kept in the state folder across
 * restarts (`ui-token`, A1264), and `Host` and `Origin` checks so no other site (or a
 * DNS-rebinding page) can read it. GET the page, the view as JSON, or a stream of views over
 * server-sent events; POST /action for Ryan's writes (F21).
 */
import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { parseAction, type Writer } from './actions.ts';
import type { FactoryView } from './model.ts';

export interface UiOptions {
  readonly port: number;
  readonly token: string;
  readonly page: () => string;
  readonly view: () => Promise<FactoryView>;
  /** Ryan's writes (F21); without it the UI is read-only. */
  readonly writer?: Writer;
  /** How often the event stream checks for a changed view. */
  readonly refreshMs?: number;
  /**
   * Tailnet names Ryan serves this UI on over HTTPS with `tailscale serve`, as `host:port`
   * (`tailnetHosts`). Their Host and `https://` Origin are accepted too; the token still is not
   * optional.
   */
  readonly remote?: readonly string[];
}

const COOKIE = 'penmoss-factory-ui';

function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function cookie(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return undefined;
}

/** Whether a request may be answered: a local or served Host, no foreign Origin, the token. */
export function allowed(
  req: IncomingMessage,
  port: number,
  token: string,
  remote: readonly string[] = [],
): { ok: true; viaQuery: boolean } | { ok: false; why: string } {
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  // HTTPS on 443 arrives without its port in Host and Origin.
  const served = remote.flatMap((r) => (r.endsWith(':443') ? [r, r.slice(0, -4)] : [r]));
  if (![...hosts, ...served].includes(req.headers.host ?? ''))
    return { ok: false, why: 'unexpected Host' };
  const origin = req.headers.origin;
  if (
    origin !== undefined &&
    !hosts.some((h) => origin === `http://${h}`) &&
    !served.some((h) => origin === `https://${h}`)
  )
    return { ok: false, why: 'foreign Origin' };
  const url = new URL(req.url ?? '/', `http://${hosts[0]}`);
  const query = url.searchParams.get('token');
  if (query !== null && sameToken(query, token)) return { ok: true, viaQuery: true };
  const held = cookie(req, COOKIE);
  if (held !== undefined && sameToken(held, token)) return { ok: true, viaQuery: false };
  return { ok: false, why: 'no token' };
}

function send(res: ServerResponse, status: number, type: string, body: string): void {
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'content-security-policy':
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  });
  res.end(body);
}

export function createUiServer(options: UiOptions): Server {
  const refresh = options.refreshMs ?? 5000;
  return createServer((req, res) => {
    // The port the request actually reached (options.port may be 0 in tests).
    const check = allowed(
      req,
      req.socket.localPort ?? options.port,
      options.token,
      options.remote ?? [],
    );
    if (!check.ok) {
      send(
        res,
        403,
        'text/plain; charset=utf-8',
        `Forbidden (${check.why}). Open the link factory:ui printed.\n`,
      );
      return;
    }
    if (req.method === 'POST' && req.url === '/action' && options.writer) {
      handleAction(req, res, options.writer);
      return;
    }
    if (req.method !== 'GET') {
      send(res, 405, 'text/plain; charset=utf-8', 'Not allowed.\n');
      return;
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (check.viaQuery) {
      // Swap the link's token for a cookie, so it leaves the address bar and history. Not with a
      // redirect: a link tapped in another app or site starts a cross-site navigation, and the
      // browser keeps the strict cookie off every hop of it, so the redirect's target got 403
      // "no token" (the tailnet link from Ryan's phone, A1249). The page's own navigation is
      // same-site. The browser never sends the fragment (a notification's #issue-n); the page
      // keeps it.
      url.searchParams.delete('token');
      const target = JSON.stringify(url.pathname + url.search).replaceAll('<', '\\u003c');
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        // A year: the token outlives restarts now (A1264), so a device signs in once.
        'set-cookie': `${COOKIE}=${options.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'x-frame-options': 'DENY',
        'referrer-policy': 'no-referrer',
        'content-security-policy':
          "default-src 'none'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      });
      res.end(
        `<!doctype html><meta charset="utf-8"><title>Penmoss Factory</title><script>location.replace(${target} + location.hash)</script>\n`,
      );
      return;
    }
    if (url.pathname === '/') {
      send(res, 200, 'text/html; charset=utf-8', options.page());
      return;
    }
    if (url.pathname === '/view.json') {
      options
        .view()
        .then((v) => send(res, 200, 'application/json', JSON.stringify(v)))
        .catch((error: unknown) =>
          send(
            res,
            500,
            'text/plain; charset=utf-8',
            error instanceof Error ? error.message : String(error),
          ),
        );
      return;
    }
    if (url.pathname === '/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      });
      let last = '';
      let closed = false;
      const push = async () => {
        try {
          const json = JSON.stringify(await options.view());
          // updatedAt and the status's age change every time; compare the rest.
          const key = json.replace(/"updatedAt":"[^"]*",/, '').replace(/"ageSeconds":\d+/, '');
          if (!closed && key !== last) {
            last = key;
            res.write(`data: ${json}\n\n`);
          } else if (!closed) res.write(': still\n\n');
        } catch (error) {
          if (!closed) res.write(`event: problem\ndata: ${JSON.stringify(String(error))}\n\n`);
        }
      };
      void push();
      const timer = setInterval(() => void push(), refresh);
      req.on('close', () => {
        closed = true;
        clearInterval(timer);
      });
      return;
    }
    send(res, 404, 'text/plain; charset=utf-8', 'Not found.\n');
  });
}

const MAX_BODY = 32 * 1024;

/**
 * A write. Beyond the token: the page's own Origin must be present (a form or a foreign page
 * can't send it), and the body must be JSON.
 */
function handleAction(req: IncomingMessage, res: ServerResponse, writer: Writer): void {
  const json = (status: number, body: object) =>
    send(res, status, 'application/json', JSON.stringify(body));
  if (req.headers.origin === undefined) return json(403, { error: 'no Origin' });
  if (!(req.headers['content-type'] ?? '').startsWith('application/json'))
    return json(415, { error: 'JSON only' });
  let body = '';
  let tooBig = false;
  req.on('data', (chunk: Buffer) => {
    body += chunk.toString();
    if (body.length > MAX_BODY) {
      tooBig = true;
      req.destroy();
    }
  });
  req.on('end', () => {
    if (tooBig) return json(413, { error: 'too large' });
    let raw: unknown;
    try {
      raw = JSON.parse(body);
    } catch {
      return json(400, { error: 'not JSON' });
    }
    const parsed = parseAction(raw);
    if (!parsed.ok) return json(400, { error: parsed.error });
    writer
      .perform(parsed.action)
      .then((done) => json(200, { ok: true, done }))
      .catch((error: unknown) =>
        json(502, { error: error instanceof Error ? error.message : String(error) }),
      );
  });
}

/** Listens on 127.0.0.1 only. */
export function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      resolve(typeof address === 'object' && address ? address.port : port);
    });
  });
}
