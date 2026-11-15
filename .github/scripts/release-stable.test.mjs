// Stable releases' drafts (P3, R5, PEN-107) against an in-memory Releases page: `task releases:test`.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { ALPHA } from './release-alpha.mjs';
import { FakeGh, dir, sha } from './release-fake-gh.mjs';
import { FEED, PUBLIC_APK, PUBLIC_DMG, SUMS, parseSums } from './release-files.mjs';
import { draftStable, stableFiles, stableInstall } from './release-stable.mjs';

describe('stable releases (P3, R5)', () => {
  /** A stable build's files as release.yml hands them over. */
  const stableOf = (/** @type {string} */ version, run = 1600) => {
    const out = path.join(dir, `stable-${version}`);
    mkdirSync(out, { recursive: true });
    const files = {
      dmg: path.join(out, `penmoss-mac-${run}.dmg`),
      apk: path.join(out, 'app-release.apk'),
      zip: path.join(out, `penmoss-mac-${version}.zip`),
      feed: path.join(out, FEED),
    };
    writeFileSync(files.dmg, `dmg ${version}`);
    writeFileSync(files.apk, `apk ${version}`);
    writeFileSync(files.zip, `zip ${version}`);
    writeFileSync(
      files.feed,
      `version: ${version}\nfiles:\n  - url: penmoss-mac-${version}.zip\n    sha512: x\npath: penmoss-mac-${version}.zip\n`,
    );
    return files;
  };

  it('drafts vX.Y.Z with the five files, the feed last, notes since the stable tag before it', async () => {
    const gh = new FakeGh();
    gh.tagNames = ['v0.2.0', 'v0.2.1'];
    gh.latest = 'v0.2.0';
    // release-notes.json on alpha, as publish-notes leaves it (PEN-106): v0.2.0 at build 1170.
    gh.releases.push({
      tag: ALPHA,
      target: sha(1175),
      body: '',
      prerelease: true,
      assets: [{ name: 'release-notes.json' }],
    });
    gh.contents.set(
      `${ALPHA}/release-notes.json`,
      JSON.stringify({
        schema: 1,
        generated: '',
        head: sha(1175),
        prs: [],
        releases: [{ version: '0.2.0', tag: 'v0.2.0', build: 1170, date: '2026-11-08' }],
        notes: [
          { build: 1170, pr: 1, kind: 'new', platform: null, text: 'In 0.2.0 already.' },
          {
            build: 1172,
            pr: 2,
            kind: 'fixed',
            platform: 'mac',
            text: 'The window keeps its size.',
          },
          { build: 1174, pr: 3, kind: 'new', platform: null, text: 'Release notes in the app.' },
          { build: 1176, pr: 4, kind: 'new', platform: null, text: 'After this release.' },
        ],
      }),
    );
    await draftStable(gh, {
      tag: 'v0.2.1',
      build: 1175,
      previous: 'v0.2.0',
      date: '2026-11-20',
      ...stableOf('0.2.1'),
    });
    const [draft] = gh.drafts;
    assert.ok(draft);
    assert.equal(draft.draft, true);
    assert.equal(draft.prerelease, false);
    assert.equal(draft.title, 'Penmoss 0.2.1');
    // Its text: the notes after v0.2.0's build, up to its own (PEN-107).
    assert.equal(
      draft.body,
      `## What's new in 0.2.1\n\n**New**\n\n- Release notes in the app. (#3)\n\n**Fixed**\n\n- Mac: The window keeps its size. (#2)\n\n${stableInstall()}\n\n**Full changelog**: https://github.com/htxryan/penmoss/compare/v0.2.0...v0.2.1`,
    );
    const carried = JSON.parse(
      /** @type {string} */ (gh.contents.get('v0.2.1/release-notes.json')),
    );
    assert.deepEqual(carried.releases, [
      { version: '0.2.0', tag: 'v0.2.0', build: 1170, date: '2026-11-08' },
      { version: '0.2.1', tag: 'v0.2.1', build: 1175, date: '2026-11-20' },
    ]);
    assert.equal(carried.notes.length, 4, 'the whole record travels, the apps pick by build');
    assert.deepEqual(stableFiles('0.2.1'), [
      PUBLIC_DMG,
      PUBLIC_APK,
      'penmoss-mac-0.2.1.zip',
      'release-notes.json',
      SUMS,
      FEED,
    ]);
    assert.deepEqual(
      draft.assets.map((a) => a.name),
      stableFiles('0.2.1'),
    );
    const sums = parseSums(/** @type {string} */ (gh.contents.get(`v0.2.1/${SUMS}`)));
    const hash = (/** @type {string} */ text) => createHash('sha256').update(text).digest('hex');
    assert.equal(sums.get(PUBLIC_DMG), hash('dmg 0.2.1'));
    assert.equal(sums.get(PUBLIC_APK), hash('apk 0.2.1'));
    assert.equal(sums.get('penmoss-mac-0.2.1.zip'), hash('zip 0.2.1'));
    assert.ok(sums.has(FEED));
    assert.equal(sums.size, 4);
    // Ryan publishes it; until then Latest is untouched.
    assert.equal(gh.latest, 'v0.2.0');
    assert.deepEqual(
      gh.releases.map((r) => r.tag),
      [ALPHA],
    );
  });

  it('a -rc.N tag makes a draft prerelease, never listed as a release; the first has no notes yet', async () => {
    const gh = new FakeGh();
    gh.tagNames = ['v0.2.0-rc.1'];
    await draftStable(gh, { tag: 'v0.2.0-rc.1', build: 1180, ...stableOf('0.2.0-rc.1') });
    assert.equal(gh.drafts[0]?.prerelease, true);
    assert.match(
      gh.drafts[0]?.body ?? '',
      /A maintenance release: nothing that people using Penmoss would notice\./,
    );
    assert.match(gh.drafts[0]?.body ?? '', /commits\/v0\.2\.0-rc\.1$/);
    const carried = JSON.parse(
      /** @type {string} */ (gh.contents.get('v0.2.0-rc.1/release-notes.json')),
    );
    assert.deepEqual(carried.releases, []);
  });

  it('a re-run replaces the files on its draft, and never touches a published release', async () => {
    const gh = new FakeGh();
    gh.tagNames = ['v0.2.0'];
    await draftStable(gh, { tag: 'v0.2.0', build: 1180, ...stableOf('0.2.0') });
    gh.calls = [];
    await draftStable(gh, { tag: 'v0.2.0', build: 1180, ...stableOf('0.2.0') });
    assert.equal(gh.drafts.length, 1);
    assert.deepEqual(
      gh.calls.map((c) => c.split(' ').slice(0, 3).join(' ')),
      stableFiles('0.2.0').map((name) => `upload v0.2.0 ${name}`),
    );
    gh.releases.push({ tag: 'v0.1.9', target: sha(1), body: '', prerelease: false, assets: [] });
    gh.tagNames.push('v0.1.9');
    await assert.rejects(
      draftStable(gh, { tag: 'v0.1.9', build: 1180, ...stableOf('0.1.9') }),
      /already published/,
    );
  });

  it('refuses a zip or feed for another version', async () => {
    const gh = new FakeGh();
    gh.tagNames = ['v0.2.0'];
    const files = stableOf('0.2.0');
    await assert.rejects(
      draftStable(gh, { tag: 'v0.2.0', build: 1180, ...files, zip: stableOf('0.1.9').zip }),
      /must be penmoss-mac-0\.2\.0\.zip/,
    );
    await assert.rejects(
      draftStable(gh, { tag: 'v0.2.0', build: 1180, ...files, feed: stableOf('0.2.1').feed }),
      /does not name penmoss-mac-0\.2\.0\.zip/,
    );
    await assert.rejects(draftStable(gh, { tag: 'v0.2', build: 1180, ...files }), /not vX\.Y\.Z/);
    assert.deepEqual(gh.drafts, []);
  });
});
