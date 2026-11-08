/**
 * The bundled web app on `app://penmoss/…` (T29). Files come from the
 * app's own `web` directory and nowhere else: paths are decoded and
 * normalised, and anything resolving outside the directory is refused.
 * Paths without a file extension are app routes (`/notes/<id>`) and get
 * index.html. Every page carries the app's Content Security Policy (csp.ts),
 * so scripts run only from the bundle and connect nowhere else.
 */
import { readFile, stat } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, sep } from 'node:path';
import { APP_HOST } from './config';
import { contentSecurityPolicy } from './csp';

const TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json',
};

/** The file under `root` that `pathname` names, or null when it would leave `root`. */
export function resolveAsset(root: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return null;
  const file = join(root, decoded);
  const inside = relative(root, file);
  if (inside === '' || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    return inside === '' ? join(root, 'index.html') : null;
  }
  return file;
}

/** Headers every response carries; pages also get the CSP. */
export function securityHeaders(type: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': type,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-cache',
  };
  if (type.startsWith('text/html')) {
    headers['Content-Security-Policy'] = contentSecurityPolicy();
  }
  return headers;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** Answers one `app://` request from the bundle in `root`. */
export async function serveAsset(root: string, request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.host !== APP_HOST) return new Response('Not found', { status: 404 });
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method not allowed', { status: 405 });
  }
  let file = resolveAsset(root, url.pathname);
  if (!file) return new Response('Not found', { status: 404 });
  if (!(await isFile(file))) {
    // An app route (no extension): the app itself decides what it shows.
    if (extname(url.pathname) !== '') return new Response('Not found', { status: 404 });
    file = join(root, 'index.html');
  }
  const type = TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';
  const body = request.method === 'HEAD' ? null : await readFile(file);
  return new Response(body, { status: 200, headers: securityHeaders(type) });
}
