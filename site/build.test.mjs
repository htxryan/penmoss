// The docs' Content-Security-Policy step of site/build.mjs (P14): `pnpm --filter @penmoss/site test`.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  ANALYTICS,
  docsPolicy,
  hashOf,
  hostsOf,
  inlineScripts,
  latestNotes,
  latestRelease,
  notesUrl,
  releaseInfo,
  withDocsHeaders,
  writeHeaders,
  writeNotes,
  writeRelease,
} from './build.mjs';
import { BEFORE_NOTES, longDate, stableReleases, withEarlierReleases } from './src/releases.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
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

  it('allows only this site, WebAssembly, the analytics beacon and the hashed scripts, in a stable order', () => {
    const policy = docsPolicy(["'sha256-b'", "'sha256-a'", "'sha256-b'"]);
    assert.match(
      policy,
      /^default-src 'none'; script-src 'self' 'wasm-unsafe-eval' https:\/\/static\.cloudflareinsights\.com 'sha256-a' 'sha256-b';/,
    );
    assert.match(policy, /connect-src 'self' https:\/\/cloudflareinsights\.com;/);
    assert.match(policy, /frame-ancestors 'none'/);
  });

  it('reads the hosts each directive allows', () => {
    assert.deepEqual(
      hostsOf("default-src 'none'; script-src 'self' https://a.example 'sha256-x'; img-src data:"),
      { 'script-src': ['https://a.example'] },
    );
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

describe('Cloudflare Web Analytics in both policies (PEN-123)', () => {
  /** Exactly the beacon's script host, and exactly where it reports; no other host anywhere. */
  const ALLOWED = {
    'script-src': ['https://static.cloudflareinsights.com'],
    'connect-src': ['https://cloudflareinsights.com'],
  };

  it('names the two hosts Cloudflare documents for the beacon', () => {
    assert.deepEqual(ANALYTICS, {
      script: 'https://static.cloudflareinsights.com',
      connect: 'https://cloudflareinsights.com',
    });
  });

  it('the docs policy allows exactly these hosts', () => {
    assert.deepEqual(hostsOf(docsPolicy(["'sha256-a'"])), ALLOWED);
    assert.deepEqual(hostsOf(docsPolicy([])), ALLOWED);
  });

  it('the site-wide policy in public/_headers allows exactly these hosts', () => {
    const base = readFileSync(path.join(here, 'public', '_headers'), 'utf8');
    const policies = [...base.matchAll(/^\s*Content-Security-Policy:\s*(.+)$/gm)].map((m) => m[1]);
    assert.equal(policies.length, 1);
    assert.deepEqual(hostsOf(policies[0] ?? ''), ALLOWED);
  });

  it('the generated dist/_headers allows exactly these hosts in every policy', () => {
    const root = dist('analytics', {
      'index.html': '<main>No script</main>',
      'docs/index.html': '<script>one()</script>',
    });
    writeFileSync(
      path.join(root, '_headers'),
      readFileSync(path.join(here, 'public', '_headers'), 'utf8'),
    );
    writeHeaders(root);
    const headers = readFileSync(path.join(root, '_headers'), 'utf8');
    const policies = [...headers.matchAll(/^\s*Content-Security-Policy:\s*(.+)$/gm)].map(
      (m) => m[1] ?? '',
    );
    assert.equal(policies.length, 4, 'the site-wide policy and one for each docs path');
    for (const policy of policies) assert.deepEqual(hostsOf(policy), ALLOWED, policy);
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

  // A1245: `task site:deploy` (and every build) rewrites it, so a tracked copy left the
  // checkout modified after each deploy. It is ignored, and src/site.ts reads a missing one as
  // no release.
  it('leaves src/data/release.json out of git, so a build never dirties the checkout', () => {
    const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
    const tracked = execFileSync('git', ['ls-files', '--', 'site/src/data/release.json'], {
      cwd: repo,
      encoding: 'utf8',
    });
    assert.equal(tracked, '');
    assert.match(
      readFileSync(path.join(repo, '.gitignore'), 'utf8'),
      /^site\/src\/data\/release\.json$/m,
    );
  });
});

describe('the Release notes page (PEN-111, RN13)', () => {
  const FILE = {
    schema: 1,
    generated: '2026-11-20T00:00:00Z',
    head: 'abc',
    prs: [],
    releases: [
      { version: '0.2.1', tag: 'v0.2.1', build: 1180, date: '2026-11-20' },
      { version: '0.2.0', tag: 'v0.2.0', build: 1170, date: '2026-11-08' },
    ],
    notes: [
      { build: 1165, pr: 1, kind: 'fixed', platform: null, text: 'Before 0.2.0.' },
      { build: 1174, pr: 2, kind: 'new', platform: 'android', text: 'A What’s new screen.' },
      { build: 1176, pr: 3, kind: 'improved', platform: null, text: 'Search ranks titles first.' },
      { build: 1178, pr: 4, kind: 'new', platform: null, text: 'Release notes in the app.' },
      { build: 1185, pr: 5, kind: 'new', platform: null, text: 'Only on Alpha so far.' },
    ],
  };

  it("fetches the latest stable release's file, or a tagged one's, from beside its downloads", async () => {
    assert.equal(
      notesUrl(),
      'https://github.com/htxryan/penmoss/releases/latest/download/release-notes.json',
    );
    /** @type {string[]} */
    const asked = [];
    /** @type {typeof fetch} */
    const fetchImpl = async (url) => {
      asked.push(String(url));
      return new Response(JSON.stringify(FILE), { status: 200 });
    };
    const notes = await latestNotes({ fetchImpl });
    assert.deepEqual(notes, { schema: 1, notes: FILE.notes, releases: FILE.releases });
    await latestNotes({ fetchImpl, tag: 'v0.2.1' });
    assert.deepEqual(asked, [
      notesUrl(),
      'https://github.com/htxryan/penmoss/releases/download/v0.2.1/release-notes.json',
    ]);
  });

  it('has none when the file is missing, unreadable, of another schema or unreachable', async () => {
    for (const fetchImpl of [
      async () => new Response('Not Found', { status: 404 }),
      async () => new Response(JSON.stringify({ ...FILE, schema: 2 }), { status: 200 }),
      async () => new Response('{"schema":1}', { status: 200 }),
      async () => {
        throw new Error('offline');
      },
    ]) {
      assert.equal(await latestNotes({ fetchImpl }), null);
    }
  });

  it('writes the file, or null, to src/data/release-notes.json, which git ignores', () => {
    const root = path.join(dir, 'notes');
    writeNotes({ schema: 1, notes: [], releases: [] }, root);
    const at = path.join(root, 'src/data/release-notes.json');
    assert.deepEqual(JSON.parse(readFileSync(at, 'utf8')), { schema: 1, notes: [], releases: [] });
    writeNotes(null, root);
    assert.equal(JSON.parse(readFileSync(at, 'utf8')), null);
    const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
    const ignored = execFileSync('git', ['check-ignore', 'site/src/data/release-notes.json'], {
      cwd: repo,
      encoding: 'utf8',
    });
    assert.equal(ignored.trim(), 'site/src/data/release-notes.json');
  });

  it('lists each stable release, newest first, with its own notes grouped by kind', () => {
    const releases = stableReleases(FILE);
    assert.deepEqual(
      releases?.map((r) => [
        r.version,
        r.groups.map((g) => [g.label, g.notes.map((n) => [n.platform, n.text])]),
      ]),
      [
        [
          '0.2.1',
          [
            [
              'New',
              [
                ['android', 'A What’s new screen.'],
                [null, 'Release notes in the app.'],
              ],
            ],
            ['Improved', [[null, 'Search ranks titles first.']]],
          ],
        ],
        ['0.2.0', [['Fixed', [[null, 'Before 0.2.0.']]]]],
      ],
    );
    assert.equal(stableReleases(null), null);
    assert.equal(stableReleases({ ...FILE, schema: 2 }), null);
    assert.equal(longDate('2026-11-08'), '8 November 2026');
  });

  it('adds 0.2.0, from before notes began, unless the file lists it', () => {
    const summary = (/** @type {ReturnType<typeof withEarlierReleases>} */ blocks) =>
      blocks.map((r) => [r.version, r.groups.map((g) => g.label)]);
    // No file (offline, or no release carries one yet): 0.2.0 alone, from BEFORE_NOTES.
    assert.deepEqual(summary(withEarlierReleases(null)), [['0.2.0', ['New']]]);
    const [first] = withEarlierReleases(null);
    assert.equal(first?.tag, 'v0.2.0');
    assert.equal(first?.date, '2026-11-08');
    assert.deepEqual(
      first?.groups[0]?.notes.map((n) => n.platform),
      BEFORE_NOTES[0]?.notes.map((n) => n.platform),
    );
    // A file that starts at 0.2.1: 0.2.0 goes below it.
    const later = { ...FILE, releases: FILE.releases.filter((r) => r.tag !== 'v0.2.0') };
    assert.deepEqual(
      withEarlierReleases(stableReleases(later)).map((r) => r.version),
      ['0.2.1', '0.2.0'],
    );
    // A file that lists 0.2.0 itself wins: its notes, not BEFORE_NOTES'.
    assert.deepEqual(summary(withEarlierReleases(stableReleases(FILE))), [
      ['0.2.1', ['New', 'Improved']],
      ['0.2.0', ['Fixed']],
    ]);
    // Versions sort as numbers, not text.
    const tenth = { version: '0.10.0', tag: 'v0.10.0', date: '2027-01-01', groups: [] };
    assert.deepEqual(
      withEarlierReleases([tenth]).map((r) => r.version),
      ['0.10.0', '0.2.0'],
    );
  });
});
