// The rolling alpha prerelease (P4) against an in-memory Releases page: `task releases:test`.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { ALPHA, ALPHA_FEED, alphaState, publishAlpha } from './release-alpha.mjs';
import { FakeGh, dir, sha } from './release-fake-gh.mjs';
import { PUBLIC_APK, PUBLIC_DMG, SUMS, parseSums } from './release-files.mjs';

describe('publish-alpha (P4)', () => {
  /** A main build's APK and Mac files as CI hands them over: the feed is alpha-mac.yml. */
  const alphaOf = (/** @type {number} */ run, version = `0.2.0-alpha.${run}`) => {
    const out = path.join(dir, `alpha-${run}`);
    mkdirSync(out, { recursive: true });
    const files = {
      apk: path.join(out, 'app-release.apk'),
      dmg: path.join(out, `penmoss-mac-${run}.dmg`),
      zip: path.join(out, `penmoss-mac-${run}.zip`),
      feed: path.join(out, ALPHA_FEED),
    };
    writeFileSync(files.apk, `apk ${run}`);
    writeFileSync(files.dmg, `dmg ${run}`);
    writeFileSync(files.zip, `zip ${run}`);
    writeFileSync(
      files.feed,
      `version: ${version}\nfiles:\n  - url: penmoss-mac-${run}.zip\n    sha512: x\npath: penmoss-mac-${run}.zip\n`,
    );
    return { run, sha: sha(run), version, ...files };
  };
  /** @param {ReturnType<typeof alphaOf>} b */
  const androidPart = ({ run, sha, version, apk }) => ({ run, sha, version, apk });
  /** @param {ReturnType<typeof alphaOf>} b */
  const macPart = ({ run, sha, version, dmg, zip, feed }) => ({
    run,
    sha,
    version,
    dmg,
    zip,
    feed,
  });
  /** @param {FakeGh} gh */
  const alphaNames = (gh) =>
    gh
      .find(ALPHA)
      .assets.map((a) => a.name)
      .sort();
  const hash = (/** @type {string} */ text) => createHash('sha256').update(text).digest('hex');

  it('creates the alpha prerelease with the APK first, at the build commit, never Latest', async () => {
    const gh = new FakeGh();
    gh.latest = null;
    await publishAlpha(gh, androidPart(alphaOf(1510)));
    const alpha = gh.find(ALPHA);
    assert.equal(alpha.prerelease, true);
    assert.equal(gh.latest, null);
    assert.equal(gh.tagTargets.get(ALPHA), sha(1510));
    assert.deepEqual(alphaNames(gh), [PUBLIC_APK, SUMS]);
    assert.deepEqual(alphaState(alpha.body).android, {
      build: 1510,
      sha: sha(1510),
      version: '0.2.0-alpha.1510',
    });
    assert.match(alpha.body, /No Mac app yet/);
    assert.equal(gh.contents.get(`${ALPHA}/${PUBLIC_APK}`), 'apk 1510');
  });

  it("adds that build's Mac app: dmg, zip, checksums, and the feed last", async () => {
    const gh = new FakeGh();
    const b = alphaOf(1510);
    await publishAlpha(gh, androidPart(b));
    gh.calls = [];
    await publishAlpha(gh, macPart(b));
    assert.deepEqual(
      gh.calls.filter((c) => c.startsWith('upload')),
      [
        `upload ${ALPHA} ${PUBLIC_DMG}`,
        `upload ${ALPHA} penmoss-mac-1510.zip`,
        `upload ${ALPHA} ${SUMS}`,
        `upload ${ALPHA} ${ALPHA_FEED}`,
      ],
    );
    assert.deepEqual(
      alphaNames(gh),
      [ALPHA_FEED, PUBLIC_APK, PUBLIC_DMG, SUMS, 'penmoss-mac-1510.zip'].sort(),
    );
    const sums = parseSums(/** @type {string} */ (gh.contents.get(`${ALPHA}/${SUMS}`)));
    assert.deepEqual(
      [...sums.keys()].sort(),
      [ALPHA_FEED, PUBLIC_APK, PUBLIC_DMG, 'penmoss-mac-1510.zip'].sort(),
    );
    assert.equal(sums.get(PUBLIC_APK), hash('apk 1510'));
    assert.equal(sums.get(PUBLIC_DMG), hash('dmg 1510'));
    assert.equal(sums.get(ALPHA_FEED), hash(readFileSync(b.feed, 'utf8')));
    assert.equal(gh.tagTargets.get(ALPHA), sha(1510));
    const state = alphaState(gh.find(ALPHA).body);
    assert.equal(state.mac?.build, 1510);
    assert.equal(state.android?.build, 1510);
    assert.match(gh.find(ALPHA).body, /`Penmoss\.dmg`: version `0\.2\.0-alpha\.1510`/);
  });

  it('keeps the previous zip until the next build, then removes it after the new feed', async () => {
    const gh = new FakeGh();
    for (const run of [1510, 1511, 1512]) {
      const b = alphaOf(run);
      await publishAlpha(gh, androidPart(b));
      await publishAlpha(gh, macPart(b));
    }
    assert.deepEqual(
      alphaNames(gh).filter((n) => n.endsWith('.zip')),
      ['penmoss-mac-1511.zip', 'penmoss-mac-1512.zip'],
    );
    assert.ok(
      gh.calls.lastIndexOf(`upload ${ALPHA} ${ALPHA_FEED}`) <
        gh.calls.indexOf(`delete-asset ${ALPHA} penmoss-mac-1510.zip`),
    );
    const sums = parseSums(/** @type {string} */ (gh.contents.get(`${ALPHA}/${SUMS}`)));
    assert.ok(sums.has('penmoss-mac-1511.zip'), 'the kept zip stays listed');
    assert.ok(!sums.has('penmoss-mac-1510.zip'));
    assert.equal(gh.contents.get(`${ALPHA}/${PUBLIC_DMG}`), 'dmg 1512');
    assert.equal(gh.tagTargets.get(ALPHA), sha(1512));
  });

  it('never takes alpha back: an older build that finishes late changes nothing', async () => {
    const gh = new FakeGh();
    const newer = alphaOf(1512);
    await publishAlpha(gh, androidPart(newer));
    await publishAlpha(gh, macPart(newer));
    gh.calls = [];
    const older = alphaOf(1511);
    await publishAlpha(gh, androidPart(older));
    await publishAlpha(gh, macPart(older));
    assert.deepEqual(gh.calls, []);
    assert.equal(gh.contents.get(`${ALPHA}/${PUBLIC_APK}`), 'apk 1512');
    assert.equal(gh.tagTargets.get(ALPHA), sha(1512));
  });

  it('keeps the notes section publish-notes wrote when it rewrites the text (PEN-106)', async () => {
    const gh = new FakeGh();
    await publishAlpha(gh, androidPart(alphaOf(1510)));
    const section =
      "<!-- penmoss-notes -->\n### What's new since notes began\n<!-- /penmoss-notes -->";
    gh.find(ALPHA).body = `${section}\n\n${gh.find(ALPHA).body}`;
    await publishAlpha(gh, macPart(alphaOf(1510)));
    const body = gh.find(ALPHA).body;
    assert.ok(body.startsWith(`${section}\n\n`), body);
    assert.equal(body.split('<!-- penmoss-notes -->').length, 2, 'once, not twice');
    assert.equal(alphaState(body).mac?.build, 1510, "alpha's own record is still read");
  });

  it('an APK-only build moves the tag to its commit and keeps the older Mac app', async () => {
    const gh = new FakeGh();
    const first = alphaOf(1510);
    await publishAlpha(gh, androidPart(first));
    await publishAlpha(gh, macPart(first));
    await publishAlpha(gh, androidPart(alphaOf(1513)));
    assert.equal(gh.tagTargets.get(ALPHA), sha(1513));
    assert.equal(gh.contents.get(`${ALPHA}/${PUBLIC_DMG}`), 'dmg 1510');
    const sums = parseSums(/** @type {string} */ (gh.contents.get(`${ALPHA}/${SUMS}`)));
    assert.equal(sums.get(PUBLIC_DMG), hash('dmg 1510'), 'the dmg it kept keeps its checksum');
    assert.equal(sums.get(PUBLIC_APK), hash('apk 1513'));
    // The Mac then catches up with a build between: the dmg moves on, the tag stays newest.
    await publishAlpha(gh, macPart(alphaOf(1512)));
    assert.equal(gh.contents.get(`${ALPHA}/${PUBLIC_DMG}`), 'dmg 1512');
    assert.equal(gh.tagTargets.get(ALPHA), sha(1513));
  });

  it('refuses a feed naming another zip or version, or half the Mac files', async () => {
    const gh = new FakeGh();
    const b = alphaOf(1510);
    const other = alphaOf(1509);
    await assert.rejects(
      publishAlpha(gh, { ...macPart(b), feed: other.feed }),
      /does not name penmoss-mac-1510\.zip/,
    );
    await assert.rejects(
      publishAlpha(gh, { ...macPart(b), version: '0.2.0-alpha.1' }),
      /not version 0\.2\.0-alpha\.1/,
    );
    await assert.rejects(
      publishAlpha(gh, { run: b.run, sha: b.sha, version: b.version, dmg: b.dmg }),
      /together/,
    );
    await assert.rejects(
      publishAlpha(gh, { run: b.run, sha: b.sha, version: b.version }),
      /Give --apk/,
    );
    assert.deepEqual(gh.releases, []);
  });

  it('leaves no temporary files', async () => {
    const gh = new FakeGh();
    const tmp = mkdtempSync(path.join(dir, 'tmp-alpha-'));
    const saved = process.env.TMPDIR;
    process.env.TMPDIR = tmp;
    try {
      const b = alphaOf(1510);
      await publishAlpha(gh, androidPart(b));
      await publishAlpha(gh, macPart(b));
      await publishAlpha(gh, macPart(alphaOf(1511)));
    } finally {
      if (saved === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = saved;
    }
    assert.deepEqual(
      readdirSync(tmp).filter((name) => name.startsWith('penmoss-release-')),
      [],
    );
  });
});
