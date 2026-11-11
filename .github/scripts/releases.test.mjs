// The release rules (A403, P2–P5) against an in-memory Releases page: `task releases:test`.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import {
  ALPHA,
  ALPHA_FEED,
  FEED,
  MAC_MARKER,
  PUBLIC_APK,
  PUBLIC_DMG,
  SIDELOAD_CERT,
  SUMS,
  alphaState,
  appVersion,
  draftStable,
  macAsset,
  newestStable,
  parseReleaseTag,
  parseSums,
  publishAlpha,
  publishApk,
  publishMac,
  releaseInfo,
  stableFiles,
  updateFiles,
} from './releases.mjs';

const dir = mkdtempSync(path.join(tmpdir(), 'penmoss-releases-test-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const apk = path.join(dir, 'app-debug.apk');
const dmg = path.join(dir, 'Penmoss-0.1.0-arm64.dmg');
writeFileSync(apk, 'apk');
writeFileSync(dmg, 'dmg');

const sha = (/** @type {number} */ run) => `${run}`.padStart(7, '0') + 'f'.repeat(33);

/** An in-memory GitHub Releases page with the `gh` operations releases.mjs uses. */
class FakeGh {
  /** @type {import('./releases.mjs').Release[]} */
  releases = [];
  /** The Latest release: the script must never set it (P3), only a stable release may be it. */
  /** @type {string | null} */
  latest = null;
  /** Tags and the commits they point at. @type {Map<string, string>} */
  tagTargets = new Map();
  /** Each asset's bytes, by `tag/name`. @type {Map<string, string>} */
  contents = new Map();
  /** @type {string[]} */
  tagNames = [];
  /** @type {string[]} */
  calls = [];
  /** Operations that fail, as a network error would. @type {Set<'create' | 'upload' | 'download'>} */
  failing = new Set();

  /** @param {'create' | 'upload' | 'download'} operation */
  maybeFail(operation) {
    if (this.failing.has(operation)) throw new Error(`${operation} failed`);
  }

  /** @param {string} tag */
  find(tag) {
    const release = this.releases.find((r) => r.tag === tag);
    assert.ok(release, `no release ${tag}`);
    return release;
  }
  /** A copy, as the API returns: the script must not rely on its objects being ours. */
  async list() {
    return structuredClone(this.releases);
  }
  async tags() {
    return [...this.tagNames];
  }
  /** Drafts (list() never returns them, as the real one filters them out). */
  /** @type {(import('./releases.mjs').Release & { draft: boolean, title: string, notesStartTag: string | null })[]} */
  drafts = [];
  async findRelease(/** @type {string} */ tag) {
    return (
      this.drafts.find((r) => r.tag === tag) ??
      (this.releases.some((r) => r.tag === tag) ? { ...this.find(tag), draft: false } : null)
    );
  }
  /** @param {import('./releases.mjs').NewDraft} r */
  async createDraft({ tag, title, files, prerelease, notesStartTag }) {
    assert.ok(this.tagNames.includes(tag), `the tag ${tag} must exist (--verify-tag)`);
    this.calls.push(`create-draft ${tag} ${title}`);
    const draft = {
      tag,
      target: tag,
      body: '',
      prerelease,
      draft: true,
      title,
      notesStartTag,
      assets: /** @type {{ name: string }[]} */ ([]),
    };
    this.drafts.push(draft);
    for (const file of files) {
      assert.ok(existsSync(file), `${file} is gone before its upload`);
      this.calls.push(`upload ${tag} ${path.basename(file)}`);
      draft.assets.push({ name: path.basename(file) });
      this.contents.set(`${tag}/${path.basename(file)}`, readFileSync(file, 'utf8'));
    }
  }
  async subject(/** @type {string} */ sha) {
    return `Commit ${sha.slice(0, 7)}`;
  }
  /** A prerelease, never Latest (the only kind releases.mjs makes). */
  /** @param {import('./releases.mjs').NewRelease} r */
  async create({ tag, sha, title, notes, files }) {
    this.maybeFail('create');
    for (const file of files) assert.ok(existsSync(file), `${file} is gone before its upload`);
    assert.ok(!this.releases.some((r) => r.tag === tag), `${tag} exists`);
    this.calls.push(`create ${tag} ${title}`);
    this.releases.push({ tag, target: sha, body: notes, prerelease: true, assets: [] });
    this.tagTargets.set(tag, sha);
    const release = this.find(tag);
    for (const file of files) {
      release.assets.push({ name: path.basename(file) });
      this.contents.set(`${tag}/${path.basename(file)}`, readFileSync(file, 'utf8'));
    }
  }
  async upload(/** @type {string} */ tag, /** @type {string} */ file) {
    this.maybeFail('upload');
    assert.ok(existsSync(file), `${file} is gone before its upload`);
    const release = this.drafts.find((r) => r.tag === tag) ?? this.find(tag);
    const name = path.basename(file);
    this.calls.push(`upload ${tag} ${name}`);
    release.assets = [...release.assets.filter((a) => a.name !== name), { name }];
    this.contents.set(`${tag}/${name}`, readFileSync(file, 'utf8'));
  }
  async deleteAsset(/** @type {string} */ tag, /** @type {string} */ name) {
    const release = this.find(tag);
    assert.ok(
      release.assets.some((a) => a.name === name),
      `${tag} has no ${name}`,
    );
    this.calls.push(`delete-asset ${tag} ${name}`);
    release.assets = release.assets.filter((a) => a.name !== name);
    this.contents.delete(`${tag}/${name}`);
  }
  /** Saves the asset into `into`, as `gh release download --dir` does. */
  async download(
    /** @type {string} */ tag,
    /** @type {string} */ name,
    /** @type {string} */ into,
  ) {
    this.maybeFail('download');
    assert.ok(
      this.find(tag).assets.some((a) => a.name === name),
      `${tag} has no ${name}`,
    );
    this.calls.push(`download ${tag} ${name}`);
    const file = path.join(into, name);
    writeFileSync(file, this.contents.get(`${tag}/${name}`) ?? 'dmg');
    return file;
  }
  async editNotes(/** @type {string} */ tag, /** @type {string} */ notes) {
    this.find(tag).body = notes;
  }
  /** GitHub drops Latest from a release that becomes a prerelease. */
  async markPrerelease(/** @type {string} */ tag) {
    this.find(tag).prerelease = true;
    this.calls.push(`prerelease ${tag}`);
    if (this.latest === tag) this.latest = null;
  }
  async moveTag(/** @type {string} */ tag, /** @type {string} */ target) {
    assert.ok(this.tagTargets.has(tag), `no tag ${tag}`);
    this.calls.push(`move-tag ${tag} ${target.slice(0, 7)}`);
    this.tagTargets.set(tag, target);
  }
  async remove(/** @type {string} */ tag) {
    this.find(tag);
    this.calls.push(`remove ${tag}`);
    this.releases = this.releases.filter((r) => r.tag !== tag);
    this.tagTargets.delete(tag);
  }

  /** @type {string[]} */
  logs = [];
  log(/** @type {string} */ message) {
    this.logs.push(message);
  }

  /** Each release's Mac app build (null: none), by tag. */
  macs() {
    return Object.fromEntries(this.releases.map((r) => [r.tag, macAsset(r)?.build ?? null]));
  }
}

const apkOf = (/** @type {number} */ run) => ({ run, sha: sha(run), apk });
const macOf = (/** @type {number} */ run) => ({ sha: sha(run), dmg });
/** A signed Mac build's files (A1015): its zip, named for the build, and the feed naming it. */
const signedMacOf = (/** @type {number} */ run) => {
  const zip = path.join(dir, `penmoss-mac-${run}.zip`);
  const feed = path.join(dir, `feed-${run}`, 'latest-mac.yml');
  writeFileSync(zip, 'zip');
  mkdirSync(path.dirname(feed), { recursive: true });
  writeFileSync(
    feed,
    `version: 0.1.${run}\nfiles:\n  - url: penmoss-mac-${run}.zip\n    sha512: x\npath: penmoss-mac-${run}.zip\n`,
  );
  return { ...macOf(run), zip, feed };
};

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

describe('versions (P5)', () => {
  it('is 0.2.0-alpha.<run> before the first stable tag', () => {
    assert.equal(appVersion([], 1510), '0.2.0-alpha.1510');
    assert.equal(
      appVersion(['alpha', 'build-1509', 'v0.2.0-rc.1', 'android-build-3'], 1510),
      '0.2.0-alpha.1510',
    );
  });

  it('counts from the newest stable tag by version, not by name or order', () => {
    const tags = ['v0.9.9', 'v0.10.1', 'v0.2.0', 'v0.10.2-rc.1', 'v1.0', 'v01.2.3', 'alpha'];
    assert.deepEqual(newestStable(tags), [0, 10, 1]);
    assert.equal(appVersion(tags, 1600), '0.10.2-alpha.1600');
    assert.equal(appVersion(['v0.2.0'], 1601), '0.2.1-alpha.1601');
    assert.equal(appVersion(['v1.4.9', 'v1.10.0'], 7), '1.10.1-alpha.7');
  });

  it('refuses a run that is not a positive whole number', () => {
    for (const run of [0, -1, 1.5, Number.NaN])
      assert.throws(() => appVersion([], run), /build number/);
  });
});

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

describe('stable releases (P3, R5)', () => {
  it('reads vX.Y.Z as stable and vX.Y.Z-rc.N as a rehearsal, and nothing else', () => {
    assert.deepEqual(parseReleaseTag('v0.2.0'), {
      version: '0.2.0',
      core: [0, 2, 0],
      prerelease: false,
    });
    assert.deepEqual(parseReleaseTag('v0.2.0-rc.1'), {
      version: '0.2.0-rc.1',
      core: [0, 2, 0],
      prerelease: true,
    });
    for (const tag of [
      '0.2.0',
      'v0.2',
      'v0.2.0-beta.1',
      'v0.2.0-rc.0',
      'v01.2.0',
      'alpha',
      'v0.2.0 ',
    ]) {
      assert.equal(parseReleaseTag(tag), null, tag);
    }
  });

  it('release-info: the version, rehearsal or not, and the stable tag before it', () => {
    const tags = ['v0.2.0', 'v0.2.1-rc.1', 'v0.2.1', 'v0.3.0-rc.1'];
    assert.deepEqual(releaseInfo('v0.3.0-rc.1', tags), {
      version: '0.3.0-rc.1',
      prerelease: true,
      previous: 'v0.2.1',
    });
    assert.deepEqual(releaseInfo('v0.2.0', ['v0.2.0']), {
      version: '0.2.0',
      prerelease: false,
      previous: null,
    });
    assert.deepEqual(releaseInfo('v0.2.1', tags), {
      version: '0.2.1',
      prerelease: false,
      previous: 'v0.2.0',
    });
  });

  it('release-info refuses a tag at or below a stable release, or not a release tag', () => {
    assert.throws(
      () => releaseInfo('v0.2.0', ['v0.2.0', 'v0.2.1']),
      /not newer than the stable release v0\.2\.1/,
    );
    assert.throws(() => releaseInfo('v0.2.1-rc.2', ['v0.2.1']), /not newer/);
    assert.throws(() => releaseInfo('v0.2', []), /not vX\.Y\.Z/);
  });

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
    await draftStable(gh, { tag: 'v0.2.1', previous: 'v0.2.0', ...stableOf('0.2.1') });
    const [draft] = gh.drafts;
    assert.ok(draft);
    assert.equal(draft.draft, true);
    assert.equal(draft.prerelease, false);
    assert.equal(draft.title, 'Penmoss 0.2.1');
    assert.equal(draft.notesStartTag, 'v0.2.0');
    assert.deepEqual(stableFiles('0.2.1'), [
      PUBLIC_DMG,
      PUBLIC_APK,
      'penmoss-mac-0.2.1.zip',
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
    assert.deepEqual(gh.releases, []);
  });

  it('a -rc.N tag makes a draft prerelease; the first release has no start tag', async () => {
    const gh = new FakeGh();
    gh.tagNames = ['v0.2.0-rc.1'];
    await draftStable(gh, { tag: 'v0.2.0-rc.1', ...stableOf('0.2.0-rc.1') });
    assert.equal(gh.drafts[0]?.prerelease, true);
    assert.equal(gh.drafts[0]?.notesStartTag, null);
  });

  it('a re-run replaces the files on its draft, and never touches a published release', async () => {
    const gh = new FakeGh();
    gh.tagNames = ['v0.2.0'];
    await draftStable(gh, { tag: 'v0.2.0', ...stableOf('0.2.0') });
    gh.calls = [];
    await draftStable(gh, { tag: 'v0.2.0', ...stableOf('0.2.0') });
    assert.equal(gh.drafts.length, 1);
    assert.deepEqual(
      gh.calls.map((c) => c.split(' ').slice(0, 3).join(' ')),
      stableFiles('0.2.0').map((name) => `upload v0.2.0 ${name}`),
    );
    gh.releases.push({ tag: 'v0.1.9', target: sha(1), body: '', prerelease: false, assets: [] });
    gh.tagNames.push('v0.1.9');
    await assert.rejects(
      draftStable(gh, { tag: 'v0.1.9', ...stableOf('0.1.9') }),
      /already published/,
    );
  });

  it('refuses a zip or feed for another version', async () => {
    const gh = new FakeGh();
    gh.tagNames = ['v0.2.0'];
    const files = stableOf('0.2.0');
    await assert.rejects(
      draftStable(gh, { tag: 'v0.2.0', ...files, zip: stableOf('0.1.9').zip }),
      /must be penmoss-mac-0\.2\.0\.zip/,
    );
    await assert.rejects(
      draftStable(gh, { tag: 'v0.2.0', ...files, feed: stableOf('0.2.1').feed }),
      /does not name penmoss-mac-0\.2\.0\.zip/,
    );
    await assert.rejects(draftStable(gh, { tag: 'v0.2', ...files }), /not vX\.Y\.Z/);
    assert.deepEqual(gh.drafts, []);
  });
});
