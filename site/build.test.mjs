// The docs' Content-Security-Policy step of site/build.mjs (P14): `pnpm --filter @penmoss/site test`.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import {
  docsPolicy,
  hashOf,
  inlineScripts,
  latestRelease,
  releaseInfo,
  withDocsHeaders,
  writeHeaders,
  writeRelease,
} from './build.mjs';

const dir = mkdtempSync(path.join(tmpdir(), 'penmoss-site-build-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const BASE =
  "/*\n  Content-Security-Policy: default-src 'none'\n  X-Content-Type-Options: nosniff\n";

/** A dist/ folder with the given pages. @param {string} name @param {Record<string, string>} pages */
function dist(name, pages) {
  const root = path.join(dir, name);
  for (const [file, html] of Object.entries(pages)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), html);
  }
  writeFileSync(path.join(root, '_headers'), BASE);
  return root;
}

describe('the docs policy', () => {
  it('finds inline scripts, not external ones', () => {
    const html =
      '<script>a()</script><script type="module" src="/x.js"></script><script type="module">b()</script>';
    assert.deepEqual(inlineScripts(html), ['a()', 'b()']);
  });

  it('hashes a script as the browser does: SHA-256 of its exact text, in base64', () => {
    const expected = createHash('sha256').update('a()').digest('base64');
    assert.equal(hashOf('a()'), `'sha256-${expected}'`);
  });

  it('allows only this site, WebAssembly and the hashed scripts, in a stable order', () => {
    const policy = docsPolicy(["'sha256-b'", "'sha256-a'", "'sha256-b'"]);
    assert.match(
      policy,
      /^default-src 'none'; script-src 'self' 'wasm-unsafe-eval' 'sha256-a' 'sha256-b';/,
    );
    assert.match(policy, /connect-src 'self'/);
    assert.match(policy, /frame-ancestors 'none'/);
    assert.doesNotMatch(policy, /https?:/);
  });

  it('detaches the site-wide policy for the docs and their search, and keeps the rest', () => {
    const headers = withDocsHeaders(BASE, 'P');
    assert.ok(headers.startsWith(BASE.trimEnd()));
    for (const route of ['/docs', '/docs/*', '/pagefind/*']) {
      assert.ok(
        headers.includes(`\n${route}\n  ! Content-Security-Policy\n  Content-Security-Policy: P\n`),
        route,
      );
    }
  });

  it('writes the hashes of every docs page into dist/_headers', () => {
    const root = dist('ok', {
      'index.html': '<main>No script</main>',
      'docs/index.html': '<script>one()</script>',
      'docs/install/mac/index.html': '<script>one()</script><script>two()</script>',
    });
    assert.deepEqual(writeHeaders(root), { pages: 3, hashes: 2 });
    const headers = readFileSync(path.join(root, '_headers'), 'utf8');
    assert.ok(headers.includes(hashOf('one()')));
    assert.ok(headers.includes(hashOf('two()')));
  });

  it('fails a build whose brochure page runs a script', () => {
    const inline = dist('inline', { 'index.html': '<script>x()</script>' });
    assert.throws(() => writeHeaders(inline), /\/index.html runs a script/);
    const external = dist('external', { 'privacy/index.html': '<script src="/a.js"></script>' });
    assert.throws(() => writeHeaders(external), /\/privacy\/index.html runs a script/);
  });
});

describe('the download cards (R3, T80.12)', () => {
  const RELEASE = {
    tag_name: 'v0.2.0',
    published_at: '2026-11-20T18:04:00Z',
    assets: [
      { name: 'Penmoss.dmg', size: 241_600_000 },
      { name: 'Penmoss.apk', size: 31_400_000 },
      { name: 'SHA256SUMS.txt', size: 400 },
    ],
  };

  it('takes the version from the tag, the day it was published, and each size in MB', () => {
    assert.deepEqual(releaseInfo(RELEASE), {
      version: '0.2.0',
      tag: 'v0.2.0',
      date: '20 November 2026',
      mac: 242,
      android: 31,
    });
  });

  it('gives a file the release lacks no size', () => {
    const info = releaseInfo({ ...RELEASE, assets: [{ name: 'Penmoss.dmg', size: 2_000_000 }] });
    assert.equal(info.mac, 2);
    assert.equal(info.android, null);
  });

  it('reads the latest release, or a tagged one, from GitHub', async () => {
    /** @type {string[]} */
    const asked = [];
    /** @type {typeof fetch} */
    const fetchImpl = async (url) => {
      asked.push(String(url));
      return new Response(JSON.stringify(RELEASE), { status: 200 });
    };
    assert.equal((await latestRelease({ fetchImpl, token: '' }))?.version, '0.2.0');
    await latestRelease({ fetchImpl, tag: 'v0.2.0-rc.1', token: '' });
    assert.deepEqual(asked, [
      'https://api.github.com/repos/htxryan/penmoss/releases/latest',
      'https://api.github.com/repos/htxryan/penmoss/releases/tags/v0.2.0-rc.1',
    ]);
  });

  it('shows no version when GitHub has no stable release or cannot be reached', async () => {
    const missing = async () => new Response('{}', { status: 404 });
    assert.equal(await latestRelease({ fetchImpl: missing, token: '' }), null);
    const down = async () => {
      throw new Error('offline');
    };
    assert.equal(await latestRelease({ fetchImpl: down, token: '' }), null);
  });

  it('writes what it found, or null, to src/data/release.json', () => {
    const root = path.join(dir, 'release');
    writeRelease(releaseInfo(RELEASE), root);
    const written = JSON.parse(readFileSync(path.join(root, 'src/data/release.json'), 'utf8'));
    assert.equal(written.release.tag, 'v0.2.0');
    writeRelease(null, root);
    assert.deepEqual(JSON.parse(readFileSync(path.join(root, 'src/data/release.json'), 'utf8')), {
      release: null,
    });
  });
});
