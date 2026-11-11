// Builds penmoss.app into dist/ (P9, P14, R3): the latest stable release's version, date and sizes
// into src/data/release.json, then `astro build`, then the docs' Content-Security-Policy.
// The brochure pages run no script and keep the site-wide policy in public/_headers. Starlight's
// pages under /docs run a few inline scripts of their own, so their policy allows exactly those
// (by hash, computed from the built pages) and Pagefind's WebAssembly; nothing loads from
// anywhere but penmoss.app. `node build.mjs` is `task site:build`.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** The repository whose releases the download cards describe (D65: the public one). */
export const REPOSITORY = process.env['PENMOSS_SITE_REPO'] ?? 'htxryan/penmoss';

/** The files the download cards link to on every stable release (P2). */
export const DOWNLOAD_FILES = { mac: 'Penmoss.dmg', android: 'Penmoss.apk' };

/**
 * What the download cards show (R3), from a GitHub release: its version, the day it was
 * published, and each file's size in MB. A file the release lacks has no size.
 * @param {{ tag_name: string, published_at: string | null, assets?: { name: string, size: number }[] }} release
 */
export function releaseInfo(release) {
  const sizeOf = (/** @type {string} */ name) => {
    const asset = (release.assets ?? []).find((a) => a.name === name);
    return asset ? Math.round(asset.size / 1_000_000) : null;
  };
  const published = release.published_at ? new Date(release.published_at) : null;
  return {
    version: release.tag_name.replace(/^v/, ''),
    tag: release.tag_name,
    date: published
      ? published.toLocaleDateString('en-GB', {
          day: 'numeric',
          month: 'long',
          year: 'numeric',
          timeZone: 'UTC',
        })
      : null,
    mac: sizeOf(DOWNLOAD_FILES.mac),
    android: sizeOf(DOWNLOAD_FILES.android),
  };
}

/**
 * The latest stable release, or the one tagged `tag` (a rehearsal, T80.12), from GitHub's API.
 * Null when it can't be reached or there is none yet: the cards then keep their links and drop
 * the version line. `GH_TOKEN` or `GITHUB_TOKEN` is used when set (a private repository).
 * @param {{ tag?: string, fetchImpl?: typeof fetch, token?: string }} [options]
 */
export async function latestRelease(options = {}) {
  const { tag, fetchImpl = fetch } = options;
  const token = options.token ?? process.env['GH_TOKEN'] ?? process.env['GITHUB_TOKEN'];
  const url = `https://api.github.com/repos/${REPOSITORY}/releases/${tag ? `tags/${encodeURIComponent(tag)}` : 'latest'}`;
  try {
    const response = await fetchImpl(url, {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'penmoss-site-build',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      console.warn(`site: ${url} answered ${response.status}; the download cards show no version`);
      return null;
    }
    return releaseInfo(await response.json());
  } catch (error) {
    console.warn(`site: ${url} failed (${String(error)}); the download cards show no version`);
    return null;
  }
}

/** Writes src/data/release.json, which the download cards read. @param {unknown} info */
export function writeRelease(info, root = here) {
  const dir = path.join(root, 'src', 'data');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'release.json'), `${JSON.stringify({ release: info }, null, 2)}\n`);
}

/**
 * Where a stable release's `release-notes.json` is (PEN-111): the latest's, or the one tagged
 * `tag`. GitHub redirects both to the file.
 * @param {string} [tag]
 */
export function notesUrl(tag) {
  return tag
    ? `https://github.com/${REPOSITORY}/releases/download/${encodeURIComponent(tag)}/release-notes.json`
    : `https://github.com/${REPOSITORY}/releases/latest/download/release-notes.json`;
}

/**
 * The release notes the docs' Release notes page lists (PEN-111, RN13): the latest stable
 * release's `release-notes.json`, the file the apps read. Null when it can't be reached or doesn't
 * read: the page then says when notes start.
 * @param {{ tag?: string, fetchImpl?: typeof fetch }} [options]
 */
export async function latestNotes(options = {}) {
  const { tag, fetchImpl = fetch } = options;
  const url = notesUrl(tag);
  try {
    const response = await fetchImpl(url, {
      headers: { 'user-agent': 'penmoss-site-build' },
      redirect: 'follow',
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      console.warn(`site: ${url} answered ${response.status}; the Release notes page has none`);
      return null;
    }
    const file = /** @type {{ schema?: unknown, notes?: unknown, releases?: unknown }} */ (
      await response.json()
    );
    if (file?.schema !== 1 || !Array.isArray(file.notes) || !Array.isArray(file.releases)) {
      console.warn(`site: ${url} is not a schema 1 notes file; the Release notes page has none`);
      return null;
    }
    return { schema: 1, notes: file.notes, releases: file.releases };
  } catch (error) {
    console.warn(`site: ${url} failed (${String(error)}); the Release notes page has none`);
    return null;
  }
}

/** Writes src/data/release-notes.json (the file, or null). @param {unknown} notes */
export function writeNotes(notes, root = here) {
  const dir = path.join(root, 'src', 'data');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'release-notes.json'),
    `${JSON.stringify(notes ?? null, null, 2)}\n`,
  );
}

/** The paths that serve the docs and their search, which get the docs' policy. */
export const DOCS_PATHS = ['/docs', '/docs/*', '/pagefind/*'];

/**
 * The text of every inline script in a page (those with no `src`), as the browser hashes it.
 * @param {string} html
 * @returns {string[]}
 */
export function inlineScripts(html) {
  const found = [];
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const attributes = match[1] ?? '';
    if (/\bsrc\s*=/i.test(attributes)) continue;
    found.push(match[2] ?? '');
  }
  return found;
}

/** A CSP source for a script's text. @param {string} text */
export function hashOf(text) {
  return `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;
}

/**
 * The docs' policy (P14) for the given script hashes, sorted so a build is reproducible.
 * @param {Iterable<string>} hashes
 */
export function docsPolicy(hashes) {
  const scripts = [...new Set(hashes)].sort();
  return [
    "default-src 'none'",
    `script-src 'self' 'wasm-unsafe-eval'${scripts.length ? ` ${scripts.join(' ')}` : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "worker-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}

/**
 * public/_headers with the docs' rules added: each detaches the site-wide policy (`!`) and sets
 * its own. The other headers of the `/*` rule still apply.
 * @param {string} base
 * @param {string} policy
 */
export function withDocsHeaders(base, policy) {
  const rules = DOCS_PATHS.map(
    (route) => `${route}\n  ! Content-Security-Policy\n  Content-Security-Policy: ${policy}\n`,
  ).join('\n');
  return `${base.trimEnd()}\n\n# The docs (P14), written by site/build.mjs from the built pages.\n${rules}`;
}

/** Every .html file under `dir`. @param {string} dir @returns {string[]} */
export function htmlFiles(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.html'))
    .map((entry) => path.join(entry.parentPath, entry.name))
    .sort();
}

/**
 * Writes the docs' policy into `dist/_headers`, and checks that the brochure pages run no script.
 * @param {string} dist
 */
export function writeHeaders(dist) {
  const hashes = [];
  for (const file of htmlFiles(dist)) {
    const route = `/${path.relative(dist, file).split(path.sep).join('/')}`;
    const scripts = inlineScripts(readFileSync(file, 'utf8'));
    const external = /<script\b[^>]*\bsrc\s*=/i.test(readFileSync(file, 'utf8'));
    if (route.startsWith('/docs/')) {
      hashes.push(...scripts.map(hashOf));
    } else if (scripts.length > 0 || external) {
      throw new Error(`${route} runs a script, but the brochure pages ship none (P9)`);
    }
  }
  const headers = path.join(dist, '_headers');
  const policy = docsPolicy(hashes);
  writeFileSync(headers, withDocsHeaders(readFileSync(headers, 'utf8'), policy));
  return { pages: htmlFiles(dist).length, hashes: new Set(hashes).size };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // PENMOSS_SITE_RELEASE: a tag to describe instead of the latest (a rehearsal), or `none` to
  // skip the API (offline, and the tests of the built site).
  const wanted = process.env['PENMOSS_SITE_RELEASE'];
  const info = wanted === 'none' ? null : await latestRelease({ tag: wanted || undefined });
  writeRelease(info);
  console.log(info ? `site: download cards show ${info.tag} (${info.date})` : 'site: no release');
  const notes = wanted === 'none' ? null : await latestNotes({ tag: wanted || undefined });
  writeNotes(notes);
  console.log(
    notes ? `site: release notes for ${notes.releases.length} releases` : 'site: no release notes',
  );
  const built = spawnSync('pnpm', ['exec', 'astro', 'build'], { cwd: here, stdio: 'inherit' });
  if (built.status !== 0) process.exit(built.status ?? 1);
  const { pages, hashes } = writeHeaders(path.join(here, 'dist'));
  console.log(`site: ${pages} pages; the docs' policy allows ${hashes} inline scripts by hash`);
}
