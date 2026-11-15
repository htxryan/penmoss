// The release tests' in-memory GitHub Releases page (FakeGh) and the files they publish, in a
// temp dir removed after the test file.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after } from 'node:test';
import { macAsset } from './release-builds.mjs';

export const dir = mkdtempSync(path.join(tmpdir(), 'penmoss-releases-test-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const apk = path.join(dir, 'app-debug.apk');
const dmg = path.join(dir, 'Penmoss-0.1.0-arm64.dmg');
writeFileSync(apk, 'apk');
writeFileSync(dmg, 'dmg');

export const sha = (/** @type {number} */ run) => `${run}`.padStart(7, '0') + 'f'.repeat(33);

/** An in-memory GitHub Releases page with the `gh` operations the release commands use. */
export class FakeGh {
  /** @type {import('./release-gh.mjs').Release[]} */
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
  /** @type {(import('./release-gh.mjs').Release & { draft: boolean, title: string })[]} */
  drafts = [];
  async findRelease(/** @type {string} */ tag) {
    return (
      this.drafts.find((r) => r.tag === tag) ??
      (this.releases.some((r) => r.tag === tag) ? { ...this.find(tag), draft: false } : null)
    );
  }
  /** @param {import('./release-gh.mjs').NewDraft} r */
  async createDraft({ tag, title, files, prerelease, notes }) {
    assert.ok(this.tagNames.includes(tag), `the tag ${tag} must exist (--verify-tag)`);
    this.calls.push(`create-draft ${tag} ${title}`);
    const draft = {
      tag,
      target: tag,
      body: notes,
      prerelease,
      draft: true,
      title,
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
  /** A prerelease, never Latest (the only kind the build and alpha commands make). */
  /** @param {import('./release-gh.mjs').NewRelease} r */
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
    (this.drafts.find((r) => r.tag === tag) ?? this.find(tag)).body = notes;
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

export const apkOf = (/** @type {number} */ run) => ({ run, sha: sha(run), apk });
export const macOf = (/** @type {number} */ run) => ({ sha: sha(run), dmg });
/** A signed Mac build's files (A1015): its zip, named for the build, and the feed naming it. */
export const signedMacOf = (/** @type {number} */ run) => {
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
