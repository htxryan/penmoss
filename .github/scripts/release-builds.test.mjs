// The build releases (A403, A1015, P3) against an in-memory Releases page: `task releases:test`.
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { MAC_MARKER, macAsset, publishApk, publishMac, updateFiles } from './release-builds.mjs';
import { FakeGh, apkOf, dir, macOf, sha, signedMacOf } from './release-fake-gh.mjs';
import { FEED, SIDELOAD_CERT } from './release-files.mjs';

describe('publish-apk', () => {
  it('creates build-<run> as a prerelease with the APK and no Mac app yet; Latest never moves', async () => {
    const gh = new FakeGh();
    gh.releases.push({
      tag: 'android-build-98',
      target: sha(98),
      body: '',
      prerelease: false,
      assets: [{ name: 'penmoss-98.apk' }],
    });
    gh.latest = 'android-build-98';
    await publishApk(gh, apkOf(100));
    const release = gh.find('build-100');
    assert.deepEqual(release.assets, [{ name: 'penmoss-100.apk' }]);
    assert.equal(release.target, sha(100));
    assert.equal(release.prerelease, true);
    // P3: an old build that was Latest becomes a prerelease, so Latest stays empty until v0.2.0.
    assert.equal(gh.find('android-build-98').prerelease, true);
    assert.ok(gh.calls.includes('prerelease android-build-98'));
    assert.equal(gh.latest, null);
    assert.ok(gh.calls.includes('create build-100 Penmoss build 100 (0000100)'));
    assert.match(release.body, /^Build 100 from main at 0000100: Commit 0000100/);
    assert.match(release.body, /penmoss-100\.apk/);
    assert.match(release.body, /App id: `app\.penmoss`, the release build/);
    assert.ok(release.body.includes(SIDELOAD_CERT));
    assert.match(release.body, /No Mac app yet/);
  });

  it('carries the newest earlier Mac app, saying which build it came from', async () => {
    const gh = new FakeGh();
    await publishApk(gh, apkOf(100));
    await publishMac(gh, macOf(100));
    await publishApk(gh, apkOf(101));
    const release = gh.find('build-101');
    assert.deepEqual(release.assets.map((a) => a.name).sort(), [
      'penmoss-101.apk',
      'penmoss-mac-100.dmg',
    ]);
    assert.match(release.body, /`penmoss-mac-100\.dmg`: the Mac app from build 100/);
    assert.match(release.body, /Open Anyway/);
    assert.match(release.body, /xattr -dr com\.apple\.quarantine \/Applications\/Penmoss\.app/);
    assert.equal(release.body.split(MAC_MARKER).length, 2);
    assert.match(release.body, /An Alpha build \(P3\): a prerelease, never Latest/);
  });

  it('leaves a stable Latest alone, whatever order builds finish in', async () => {
    const gh = new FakeGh();
    gh.releases.push({ tag: 'v0.2.0', target: sha(99), body: '', prerelease: false, assets: [] });
    gh.latest = 'v0.2.0';
    await publishApk(gh, apkOf(104));
    await publishApk(gh, apkOf(103));
    assert.equal(gh.latest, 'v0.2.0');
    assert.equal(gh.find('v0.2.0').prerelease, false);
    assert.ok(gh.calls.includes('create build-103 Penmoss build 103 (0000103)'));
    assert.ok(gh.releases.filter((r) => r.tag.startsWith('build-')).every((r) => r.prerelease));
  });

  it('replaces the APK on a re-run instead of creating the release again', async () => {
    const gh = new FakeGh();
    await publishApk(gh, apkOf(100));
    await publishApk(gh, apkOf(100));
    assert.equal(gh.releases.length, 1);
    assert.deepEqual(gh.find('build-100').assets, [{ name: 'penmoss-100.apk' }]);
  });

  it('keeps the last 10 builds, old tag names included, and the newest Mac app with them', async () => {
    const gh = new FakeGh();
    for (const run of [90, 91]) {
      gh.releases.push({
        tag: `android-build-${run}`,
        target: sha(run),
        body: '',
        prerelease: false,
        assets: [],
      });
    }
    gh.releases.push({
      tag: 'spike-t2-v1',
      target: 'main',
      body: '',
      prerelease: false,
      assets: [],
    });
    await publishApk(gh, apkOf(100));
    await publishMac(gh, macOf(100));
    for (let run = 101; run <= 110; run += 1) await publishApk(gh, apkOf(run));
    assert.deepEqual(
      gh.releases.map((r) => r.tag).sort(),
      [...Array.from({ length: 10 }, (_, i) => `build-${101 + i}`), 'spike-t2-v1'].sort(),
    );
    assert.ok(gh.calls.includes('remove android-build-90'));
    assert.equal(gh.macs()['build-110'], 100);
    assert.equal(gh.find('spike-t2-v1').prerelease, false, 'only builds become prereleases');
    assert.equal(gh.latest, null);
  });
});

describe('publish-mac', () => {
  it("attaches the dmg to its own commit's release, named by that build", async () => {
    const gh = new FakeGh();
    await publishApk(gh, apkOf(100));
    await publishMac(gh, macOf(100));
    const release = gh.find('build-100');
    assert.deepEqual(release.assets.map((a) => a.name).sort(), [
      'penmoss-100.apk',
      'penmoss-mac-100.dmg',
    ]);
    assert.match(release.body, /Download `penmoss-mac-100\.dmg`, this build's Mac app/);
    assert.doesNotMatch(release.body, /No Mac app yet/);
    assert.match(release.body, /^Build 100 from main/);
  });

  it('replaces a carried app with its own, and passes it on to newer builds holding an older one', async () => {
    const gh = new FakeGh();
    await publishApk(gh, apkOf(100));
    await publishMac(gh, macOf(100));
    await publishApk(gh, apkOf(101));
    await publishApk(gh, apkOf(102));
    await publishMac(gh, macOf(101)); // The Mac caught up with 101 before 102 was merged.
    assert.deepEqual(gh.macs(), { 'build-100': 100, 'build-101': 101, 'build-102': 101 });
    assert.ok(gh.calls.includes('delete-asset build-102 penmoss-mac-100.dmg'));
    // Uploads come before the older app is removed, so no release is ever without one.
    assert.ok(
      gh.calls.indexOf('upload build-102 penmoss-mac-101.dmg') <
        gh.calls.indexOf('delete-asset build-102 penmoss-mac-100.dmg'),
    );
    assert.match(gh.find('build-102').body, /the Mac app from build 101/);
  });

  it('never replaces a newer Mac app with an older one that finishes late', async () => {
    const gh = new FakeGh();
    await publishApk(gh, apkOf(100));
    await publishApk(gh, apkOf(101));
    await publishMac(gh, macOf(101));
    await publishMac(gh, macOf(100));
    assert.deepEqual(gh.macs(), { 'build-100': 100, 'build-101': 101 });
  });

  it('does nothing for a commit without a release', async () => {
    const gh = new FakeGh();
    await publishApk(gh, apkOf(100));
    await publishMac(gh, macOf(99));
    assert.deepEqual(gh.macs(), { 'build-100': null });
  });

  it('keeps the rule whatever order the jobs finish in', async () => {
    // Every order of APK and Mac jobs for five builds, the Mac job after its own APK job and
    // some Mac jobs never running (cancelled by a newer one): after each step every release
    // holds the newest published Mac app at or before it, every build is a prerelease, and
    // Latest (a stable release) never moves.
    let seed = 7;
    const random = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
    for (let round = 0; round < 200; round += 1) {
      const gh = new FakeGh();
      gh.releases.push({ tag: 'v0.2.0', target: sha(1), body: '', prerelease: false, assets: [] });
      gh.latest = 'v0.2.0';
      /** @type {{ kind: 'apk' | 'mac', run: number }[]} */
      const pending = [100, 101, 102, 103, 104].map((run) => ({ kind: 'apk', run }));
      /** @type {number[]} */
      const published = [];
      while (pending.length > 0) {
        const [job] = pending.splice(Math.floor(random() * pending.length), 1);
        if (!job) break;
        if (job.kind === 'apk') {
          await publishApk(gh, apkOf(job.run));
          if (random() < 0.7) pending.push({ kind: 'mac', run: job.run });
        } else {
          await publishMac(gh, macOf(job.run));
          published.push(job.run);
        }
        for (const release of gh.releases) {
          if (release.tag === 'v0.2.0') continue;
          assert.equal(release.prerelease, true, release.tag);
          const k = Number(release.tag.slice('build-'.length));
          const expected = Math.max(-1, ...published.filter((m) => m <= k));
          assert.equal(
            macAsset(release)?.build ?? -1,
            expected,
            `${release.tag} in round ${round}`,
          );
          assert.equal(release.body.split(MAC_MARKER).length, 2);
        }
        assert.equal(gh.latest, 'v0.2.0');
      }
    }
  });
});

describe('the Mac update feed (A1015)', () => {
  /** @param {FakeGh} gh @param {string} tag */
  const names = (gh, tag) =>
    gh
      .find(tag)
      .assets.map((a) => a.name)
      .sort();

  it("attaches a signed build's zip and feed with its dmg, the feed last", async () => {
    const gh = new FakeGh();
    await publishApk(gh, apkOf(100));
    await publishMac(gh, signedMacOf(100));
    assert.deepEqual(names(gh, 'build-100'), [
      FEED,
      'penmoss-100.apk',
      'penmoss-mac-100.dmg',
      'penmoss-mac-100.zip',
    ]);
    const uploads = gh.calls.filter((call) => call.startsWith('upload build-100'));
    assert.deepEqual(uploads, [
      'upload build-100 penmoss-mac-100.dmg',
      'upload build-100 penmoss-mac-100.zip',
      `upload build-100 ${FEED}`,
    ]);
    assert.match(gh.find('build-100').body, /updates itself once Settings → Updates/);
    assert.deepEqual(updateFiles(gh.find('build-100'), 100), ['penmoss-mac-100.zip', FEED]);
  });

  it('carries them to newer builds with the dmg, so every build has a feed and its zip', async () => {
    const gh = new FakeGh();
    await publishApk(gh, apkOf(100));
    await publishMac(gh, signedMacOf(100));
    await publishApk(gh, apkOf(101));
    assert.deepEqual(names(gh, 'build-101'), [
      FEED,
      'penmoss-101.apk',
      'penmoss-mac-100.dmg',
      'penmoss-mac-100.zip',
    ]);
    // Its own app replaces the carried one: the old zip goes once the new feed is up.
    await publishMac(gh, signedMacOf(101));
    assert.deepEqual(names(gh, 'build-101'), [
      FEED,
      'penmoss-101.apk',
      'penmoss-mac-101.dmg',
      'penmoss-mac-101.zip',
    ]);
    assert.ok(
      gh.calls.lastIndexOf(`upload build-101 ${FEED}`) <
        gh.calls.indexOf('delete-asset build-101 penmoss-mac-100.zip'),
    );
  });

  it('an unsigned app carried over a signed one takes the stale feed away', async () => {
    const gh = new FakeGh();
    await publishApk(gh, apkOf(100));
    await publishApk(gh, apkOf(101));
    await publishMac(gh, signedMacOf(100));
    assert.ok(names(gh, 'build-101').includes(FEED));
    await publishMac(gh, macOf(101));
    assert.deepEqual(names(gh, 'build-101'), ['penmoss-101.apk', 'penmoss-mac-101.dmg']);
    assert.match(gh.find('build-101').body, /do not update themselves/);
  });

  it('refuses a zip renamed from its build, a feed naming another zip, or one without the other', async () => {
    const gh = new FakeGh();
    await publishApk(gh, apkOf(100));
    const other = signedMacOf(99);
    await assert.rejects(
      publishMac(gh, { ...macOf(100), zip: other.zip, feed: signedMacOf(100).feed }),
      /must be penmoss-mac-100\.zip/,
    );
    await assert.rejects(
      publishMac(gh, { ...macOf(100), zip: signedMacOf(100).zip, feed: other.feed }),
      /does not name penmoss-mac-100\.zip/,
    );
    await assert.rejects(publishMac(gh, { ...macOf(100), zip: signedMacOf(100).zip }), /both/);
    assert.deepEqual(names(gh, 'build-100'), ['penmoss-100.apk']);
  });
});

describe('temporary files', () => {
  /** Runs `flows` with TMPDIR set to a fresh directory, and returns what they left in it. */
  async function leftovers(/** @type {() => Promise<void>} */ flows) {
    const tmp = mkdtempSync(path.join(dir, 'tmp-'));
    const saved = process.env.TMPDIR;
    process.env.TMPDIR = tmp;
    try {
      assert.equal(tmpdir(), tmp);
      await flows();
    } finally {
      if (saved === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = saved;
    }
    return readdirSync(tmp).filter((name) => name.startsWith('penmoss-release-'));
  }

  it('removes the renamed copies it uploads', async () => {
    const gh = new FakeGh();
    const left = await leftovers(async () => {
      await publishApk(gh, apkOf(100)); // app-debug.apk goes up as penmoss-100.apk
      await publishApk(gh, apkOf(100)); // a re-run uploads it again
      await publishMac(gh, macOf(100)); // the dmg goes up as penmoss-mac-100.dmg
    });
    assert.deepEqual(gh.macs(), { 'build-100': 100 });
    assert.deepEqual(left, []);
  });

  it('removes the Mac apps it downloads to carry into newer builds', async () => {
    const gh = new FakeGh();
    const left = await leftovers(async () => {
      await publishApk(gh, apkOf(100));
      await publishMac(gh, macOf(100));
      await publishApk(gh, apkOf(101));
      await publishApk(gh, apkOf(102));
    });
    assert.ok(gh.calls.includes('download build-100 penmoss-mac-100.dmg'));
    assert.deepEqual(gh.macs(), { 'build-100': 100, 'build-101': 100, 'build-102': 100 });
    assert.deepEqual(left, []);
  });

  it('cleans up when an upload, a create or a download fails', async () => {
    const gh = new FakeGh();
    const left = await leftovers(async () => {
      await publishApk(gh, apkOf(100));
      gh.failing.add('upload');
      await assert.rejects(publishApk(gh, apkOf(100)), /upload failed/);
      await assert.rejects(publishMac(gh, macOf(100)), /upload failed/);
      gh.failing.clear();
      await publishMac(gh, macOf(100));
      gh.failing.add('create');
      await assert.rejects(publishApk(gh, apkOf(101)), /create failed/);
      gh.failing.clear();
      await publishApk(gh, apkOf(101));
      gh.failing.add('download');
      await assert.rejects(publishApk(gh, apkOf(102)), /download failed/);
    });
    assert.deepEqual(left, []);
  });
});
