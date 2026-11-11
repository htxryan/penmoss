// Penmoss builds on the GitHub Releases page (A400, A403, P2–P5), run by CI on main.
//
// One prerelease per main build, `build-<run>`, titled "Penmoss build <run> (<sha7>)", never
// Latest (P3, A1188: Latest is for stable `vX.Y.Z` releases only):
//   publish-apk    creates it with `penmoss-<run>.apk` as soon as the Android job passes, then
//                  keeps the last 10 builds.
//   publish-mac    attaches `penmoss-mac-<n>.dmg` to the release of the commit the Mac built,
//                  whenever the Mac (a self-hosted runner that may be asleep) gets to it.
//   publish-alpha  replaces files on the rolling `alpha` prerelease (P4): `Penmoss.apk`, or
//                  `Penmoss.dmg` with its update zip and `alpha-mac.yml`, then `SHA256SUMS.txt`
//                  and the feed last, and moves the `alpha` tag to the newest build's commit.
//   version        prints build <run>'s app version (P5): X.Y.(Z+1)-alpha.<run> after the newest
//                  stable tag vX.Y.Z, or 0.2.0-alpha.<run> before the first.
//   release-info   for release.yml (P3, A1189): a tag's version, whether it is a rehearsal
//                  (-rc.N, a prerelease) and the stable tag before it, as GITHUB_OUTPUT lines.
//   publish-notes  collects the Release notes of the pull requests merged since the last build
//                  into release-notes.json on alpha, and into the build's and alpha's notes
//                  (PEN-106; .github/scripts/release-notes.mjs).
//   fix-note       re-reads one merged pull request's Release note and puts it in their place.
//   draft-stable   creates the draft release of a vX.Y.Z tag: Penmoss.dmg, Penmoss.apk,
//                  penmoss-mac-X.Y.Z.zip, release-notes.json, SHA256SUMS.txt and latest-mac.yml,
//                  with the Release notes since the stable tag before it (PEN-107). Ryan
//                  publishes it, which makes it Latest.
// A release with no Mac app of its own carries the newest one built at or before it. A dmg's
// name says which build it came from, so the state needs no other record: every release
// `build-k` holds the dmg with the highest number m <= k. A signed Mac app also has its update
// files (A1015): `penmoss-mac-<m>.zip` and `latest-mac.yml`, which travel with its dmg. Each
// command ends by restoring that rule across all releases, and makes any build release that is
// not a prerelease one, so it holds whatever order the jobs finish in; CI runs them one at a
// time (concurrency group `releases`).
//
//   node .github/scripts/releases.mjs publish-apk --run 123 --sha <sha> --apk app-release.apk
//   node .github/scripts/releases.mjs publish-mac --sha <sha> --dmg Penmoss.dmg \
//     [--zip penmoss-mac-<run>.zip --feed alpha-mac.yml]
//   node .github/scripts/releases.mjs publish-alpha --run 123 --sha <sha> --version <v> \
//     [--apk app-release.apk] [--dmg Penmoss.dmg --zip penmoss-mac-<run>.zip --feed alpha-mac.yml]
//   node .github/scripts/releases.mjs publish-notes --run 123 --sha <sha>
//   node .github/scripts/releases.mjs fix-note --pr 140
//   node .github/scripts/releases.mjs version --run 123
//   node .github/scripts/releases.mjs release-info --tag v0.2.0
//   node .github/scripts/releases.mjs draft-stable --tag v0.2.0 --build 1180 [--previous v0.1.0] \
//     --dmg <dmg> --apk app-release.apk --zip penmoss-mac-0.2.0.zip --feed latest-mac.yml
// Add --dry-run to print the changes instead of making them: it still reads the releases and
// tags, but downloads no file. GH_TOKEN and REPO (or GITHUB_REPOSITORY) come from the environment. Renamed copies and downloaded files go in
// `penmoss-release-*` directories under the temp dir, removed when the command ends, failed or
// not: the Mac runners keep /tmp between jobs, and a dmg is over 200 MB.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  NOTES_FILE,
  fixNote,
  loadNotes,
  notesSectionOf,
  publishNotes,
  stableNotes,
  withNotesSection,
} from './release-notes.mjs';

export const KEEP = 10;
const BUILD = /^build-(\d+)$/;
/** Builds published before A403 were `android-build-<run>`; they count towards the 10. */
const ANY_BUILD = /^(?:android-)?build-(\d+)$/;
const DMG = /^penmoss-mac-(\d+)\.dmg$/;
const ZIP = /^penmoss-mac-(\d+)\.zip$/;
/** electron-updater's feed for the Mac (A1015): one per build release, the one of its dmg's build. */
export const FEED = 'latest-mac.yml';
export const MAC_MARKER = '<!-- penmoss-mac -->';
/** The sideload key's certificate (A400, P8, A1219): every public APK is signed with it alone. */
export const SIDELOAD_CERT =
  '3D:B5:DA:CC:2F:A1:F5:DA:70:28:FA:78:A3:35:C8:3F:50:62:63:A5:15:88:15:B3:3C:EC:73:24:81:C3:DE:07';

/** The rolling Alpha release (P4) and its fixed file names (P2). */
export const ALPHA = 'alpha';
export const ALPHA_FEED = 'alpha-mac.yml';
export const PUBLIC_DMG = 'Penmoss.dmg';
export const PUBLIC_APK = 'Penmoss.apk';
export const SUMS = 'SHA256SUMS.txt';
const ALPHA_STATE = /<!-- penmoss-alpha (\{.*?\}) -->/;
/** A stable tag (P3, P5): vX.Y.Z, no suffix. */
const STABLE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
/** A release tag (P3, R5): vX.Y.Z, or vX.Y.Z-rc.N for a rehearsal. */
const RELEASE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-rc\.([1-9]\d*))?$/;

/**
 * The update files a release holds for its Mac app from build `build`, zip first, the feed
 * last (so a client never reads a feed before its zip is there). None for an unsigned build.
 * @param {Release} release @param {number} build @returns {string[]}
 */
export function updateFiles(release, build) {
  const names = release.assets.map(({ name }) => name);
  const zip = `penmoss-mac-${build}.zip`;
  if (!names.includes(zip) || !names.includes(FEED)) return [];
  return [zip, FEED];
}

/**
 * @typedef {{ tag: string, target: string, body: string, prerelease: boolean, assets: { name: string }[] }} Release
 * @typedef {{ tag: string, sha: string, title: string, notes: string, files: string[] }} NewRelease
 * @typedef {{ tag: string, title: string, files: string[], prerelease: boolean, notes: string }} NewDraft
 * @typedef {{
 *   list(): Promise<Release[]>,
 *   tags(): Promise<string[]>,
 *   subject(sha: string): Promise<string>,
 *   create(r: NewRelease): Promise<void>,
 *   findRelease(tag: string): Promise<(Release & { draft: boolean }) | null>,
 *   createDraft(r: NewDraft): Promise<void>,
 *   upload(tag: string, file: string): Promise<void>,
 *   deleteAsset(tag: string, name: string): Promise<void>,
 *   download(tag: string, name: string, dir: string): Promise<string>,
 *   editNotes(tag: string, notes: string): Promise<void>,
 *   markPrerelease(tag: string): Promise<void>,
 *   moveTag(tag: string, sha: string): Promise<void>,
 *   remove(tag: string): Promise<void>,
 *   compare(base: string, head: string): Promise<string[]>,
 *   pullsOf(sha: string): Promise<import('./release-notes.mjs').PullRequest[]>,
 *   pull(number: number): Promise<import('./release-notes.mjs').PullRequest>,
 *   log(message: string): void,
 * }} Gh
 * `create` makes a prerelease that is never Latest, with `files` uploaded in order. `findRelease`
 * sees drafts too. `createDraft` makes a draft of an existing tag, with `notes` (the Release
 * notes, PEN-107) and `files` uploaded in order.
 * @typedef {{ dir(): string, remove(): void }} Scratch
 */

/** @param {string} tag @param {RegExp} [pattern] @returns {number | null} */
export function buildNumber(tag, pattern = BUILD) {
  const match = pattern.exec(tag);
  return match ? Number(match[1]) : null;
}

/**
 * The newest stable version among `tags` (P5), as [X, Y, Z], or null before the first. Tags
 * with a suffix (v0.2.0-rc.1, a rehearsal) and anything else are ignored.
 * @param {string[]} tags @returns {[number, number, number] | null}
 */
export function newestStable(tags) {
  /** @type {[number, number, number] | null} */
  let best = null;
  for (const tag of tags) {
    const match = STABLE_TAG.exec(tag);
    if (!match) continue;
    /** @type {[number, number, number]} */
    const version = [Number(match[1]), Number(match[2]), Number(match[3])];
    if (best === null || compareVersions(version, best) > 0) best = version;
  }
  return best;
}

/** @param {number[]} a @param {number[]} b */
function compareVersions(a, b) {
  for (let i = 0; i < 3; i += 1) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * The app version of main build `run` (P5): X.Y.(Z+1)-alpha.<run> after the newest stable tag
 * vX.Y.Z, else 0.2.0-alpha.<run>. It is newer than every 0.1.<run> build before it, older than
 * the next stable release, and goes up with the run.
 * @param {string[]} tags @param {number} run
 */
export function appVersion(tags, run) {
  if (!Number.isSafeInteger(run) || run < 1) throw new Error(`Not a build number: ${run}`);
  const stable = newestStable(tags);
  if (stable === null) return `0.2.0-alpha.${run}`;
  return `${stable[0]}.${stable[1]}.${stable[2] + 1}-alpha.${run}`;
}

/**
 * A Play bundle's version name (PEN-109, RN15): the alpha-style version of the newest main build
 * (its `build-N` tag), so a Play build places itself in the release notes as a sideload build
 * does. Its versionCode stays minute-based (A595).
 * @param {string[]} tags the v* tags @param {string[]} releases every release's tag
 */
export function playVersion(tags, releases) {
  const builds = releases.flatMap((tag) => {
    const match = BUILD.exec(tag);
    return match ? [Number(match[1])] : [];
  });
  if (builds.length === 0) throw new Error('No build-N release: set PENMOSS_VERSION_NAME.');
  return appVersion(tags, Math.max(...builds));
}

/**
 * A release tag's version (P3): vX.Y.Z is stable, vX.Y.Z-rc.N a rehearsal (a draft prerelease).
 * @param {string} tag
 * @returns {{ version: string, core: [number, number, number], prerelease: boolean } | null}
 */
export function parseReleaseTag(tag) {
  const match = RELEASE_TAG.exec(tag);
  if (!match) return null;
  /** @type {[number, number, number]} */
  const core = [Number(match[1]), Number(match[2]), Number(match[3])];
  return { version: tag.slice(1), core, prerelease: match[4] !== undefined };
}

/**
 * What release.yml needs to know about `tag` (P3): its version, whether it is a rehearsal, and
 * the newest stable tag before it (the notes start there). It refuses a tag that is not a release
 * tag, and one at or below an existing stable release, which would move Latest backwards.
 * @param {string} tag @param {string[]} tags
 */
export function releaseInfo(tag, tags) {
  const parsed = parseReleaseTag(tag);
  if (parsed === null) throw new Error(`${tag} is not vX.Y.Z or vX.Y.Z-rc.N.`);
  const others = tags.filter((t) => t !== tag && STABLE_TAG.test(t));
  const newest = newestStable(others);
  if (newest !== null && compareVersions(parsed.core, newest) <= 0) {
    throw new Error(`${tag} is not newer than the stable release v${newest.join('.')}.`);
  }
  return {
    version: parsed.version,
    prerelease: parsed.prerelease,
    previous: newest === null ? null : `v${newest.join('.')}`,
  };
}

/**
 * The files of a stable release (P2, R5), in upload order: the feed last.
 * @param {string} version
 */
export function stableFiles(version) {
  return [PUBLIC_DMG, PUBLIC_APK, `penmoss-mac-${version}.zip`, NOTES_FILE, SUMS, FEED];
}

/** The Mac app a release holds (the newest, if it somehow holds more than one). */
/** @param {Release} release @returns {{ name: string, build: number } | null} */
export function macAsset(release) {
  let best = null;
  for (const { name } of release.assets) {
    const build = buildNumber(name, DMG);
    if (build !== null && (best === null || build > best.build)) best = { name, build };
  }
  return best;
}

/** The newest Mac app built at or before build `n`, and a release that holds it. */
/** @param {Release[]} releases @param {number} n */
export function newestMacUpTo(releases, n) {
  /** @type {{ name: string, build: number, tag: string } | null} */
  let best = null;
  for (const release of releases) {
    if (buildNumber(release.tag) === null) continue;
    const mac = macAsset(release);
    if (mac && mac.build <= n && (best === null || mac.build > best.build)) {
      best = { ...mac, tag: release.tag };
    }
  }
  return best;
}

/** @param {{ run: number, sha: string, subject: string }} build */
export function headerNotes({ run, sha, subject }) {
  return [
    `Build ${run} from main at ${sha.slice(0, 7)}: ${subject}`,
    '',
    `An Alpha build (P3): a prerelease, never Latest. The newest one is always on the [\`alpha\` release](https://github.com/htxryan/penmoss/releases/tag/${ALPHA}) as \`${PUBLIC_DMG}\` and \`${PUBLIC_APK}\`; stable releases are [Latest](https://github.com/htxryan/penmoss/releases/latest).`,
    '',
    '### Android',
    '',
    `On the phone, download \`penmoss-${run}.apk\` and open it (allow installs from your browser once; if Play Protect warns about an unknown developer, choose **Install anyway**). It installs over earlier APKs from this page. App id: \`app.penmoss\`, the release build, signed with the sideload key (certificate SHA-256 \`${SIDELOAD_CERT}\`). It is a different app from the older \`app.penmoss.debug\` builds, which stay installed until you remove them, and it cannot install over Penmoss from Google Play (another key): remove that one first.`,
  ].join('\n');
}

/**
 * The Mac section of build `n`'s notes, holding the app from build `from` (null: none yet);
 * `updates` when that app comes with its update files (A1015).
 * @param {number} n @param {number | null} from @param {boolean} [updates]
 */
export function macNotes(n, from, updates = false) {
  const lines = [MAC_MARKER, '### Mac (Apple Silicon and Intel)', ''];
  if (from === null) {
    lines.push(
      'No Mac app yet: it is built on the Mac when the Mac is awake, and attached here when it is done.',
    );
    return lines.join('\n');
  }
  const dmg = `penmoss-mac-${from}.dmg`;
  lines.push(
    from === n
      ? `Download \`${dmg}\`, this build's Mac app.`
      : `Download \`${dmg}\`: the Mac app from build ${from}. The Mac builds only the newest commit when it is awake, so not every build has its own.`,
    '',
    '1. Open the dmg and drag **Penmoss** to **Applications** (replace the older copy if asked).',
    '2. First launch: if the app is not notarised by Apple, macOS blocks it once. Open Penmoss, close the warning, then choose **Open Anyway** in System Settings → Privacy & Security. Or, in Terminal: `xattr -dr com.apple.quarantine /Applications/Penmoss.app`.',
    '3. A new build may ask once to use the keychain item “Penmoss Safe Storage”: choose **Always Allow**.',
    '',
    updates
      ? 'App id: `app.penmoss.mac`. It updates itself once Settings → Updates → Auto-Update is on.'
      : 'App id: `app.penmoss.mac`. These builds do not update themselves: install newer ones from this page.',
  );
  return lines.join('\n');
}

/**
 * `body` with its Mac section replaced.
 * @param {string} body @param {number} n @param {number | null} from @param {boolean} [updates]
 */
export function withMacNotes(body, n, from, updates = false) {
  const head = body.split(MAC_MARKER)[0]?.trimEnd() ?? '';
  return `${head}\n\n${macNotes(n, from, updates)}`;
}

/** Whether an asset is a Mac app's file (dmg, zip, feed). @param {string} name */
const isMacFile = (name) => DMG.test(name) || ZIP.test(name) || name === FEED;

/**
 * Removes the Mac files of `release` that are not `keep`, after the new ones are uploaded.
 * @param {Gh} gh @param {Release} release @param {string[]} keep
 */
async function dropOtherMacFiles(gh, release, keep) {
  for (const { name } of release.assets) {
    if (isMacFile(name) && !keep.includes(name)) await gh.deleteAsset(release.tag, name);
  }
  release.assets = [
    ...release.assets.filter(({ name }) => !isMacFile(name)),
    ...keep.map((name) => ({ name })),
  ];
}

/** Gives `release` the newest Mac app at or before it, if it holds an older one or none. */
/**
 * @param {Gh} gh @param {Release[]} releases @param {Release} release
 * @param {Map<string, string>} files @param {Scratch} scratch
 */
async function syncMac(gh, releases, release, files, scratch) {
  const n = /** @type {number} */ (buildNumber(release.tag));
  const best = newestMacUpTo(releases, n);
  const current = macAsset(release);
  if (best === null || (current !== null && current.build >= best.build)) return;
  const source = releases.find(({ tag }) => tag === best.tag);
  const names = [best.name, ...(source ? updateFiles(source, best.build) : [])];
  // Upload first (the dmg, the zip, the feed last), then remove the older ones, so the
  // release never lacks a Mac app and its feed never names a zip that is not there.
  for (const name of names) {
    const key = `${best.build}/${name}`;
    let file = files.get(key);
    if (file === undefined) {
      file = await gh.download(best.tag, name, scratch.dir());
      files.set(key, file);
    }
    await gh.upload(release.tag, file);
  }
  await dropOtherMacFiles(gh, release, names);
  release.body = withMacNotes(release.body, n, best.build, names.length > 1);
  await gh.editNotes(release.tag, release.body);
  gh.log(`${release.tag}: Mac app from build ${best.build}`);
}

/**
 * Restores the rules across every release: each build holds the newest Mac app at or before it,
 * and every build is a prerelease, so Latest is only ever a stable release (P3). Latest itself
 * is never touched.
 * @param {Gh} gh @param {Release[]} releases @param {Map<string, string>} files
 * @param {Scratch} scratch
 */
async function reconcile(gh, releases, files, scratch) {
  const builds = releases
    .filter(({ tag }) => buildNumber(tag) !== null)
    .sort(
      (a, b) =>
        /** @type {number} */ (buildNumber(a.tag)) - /** @type {number} */ (buildNumber(b.tag)),
    );
  for (const release of builds) await syncMac(gh, releases, release, files, scratch);

  for (const release of numbered(releases)) {
    if (release.prerelease) continue;
    await gh.markPrerelease(release.tag);
    release.prerelease = true;
    gh.log(`${release.tag}: now a prerelease`);
  }
}

/** Builds, old and new tag names, newest first. @param {Release[]} releases */
function numbered(releases) {
  return releases
    .filter(({ tag }) => buildNumber(tag, ANY_BUILD) !== null)
    .sort(
      (a, b) =>
        /** @type {number} */ (buildNumber(b.tag, ANY_BUILD)) -
        /** @type {number} */ (buildNumber(a.tag, ANY_BUILD)),
    );
}

/** Deletes all but the newest `keep` builds (and their tags). */
/** @param {Gh} gh @param {Release[]} releases @param {number} keep */
async function prune(gh, releases, keep) {
  for (const release of numbered(releases).slice(keep)) {
    await gh.remove(release.tag);
    releases.splice(releases.indexOf(release), 1);
    gh.log(`${release.tag}: deleted (keeping the last ${keep})`);
  }
}

/** The temporary directories one command makes, each removed by `remove()`. @returns {Scratch} */
function scratchDirs() {
  /** @type {string[]} */
  const dirs = [];
  return {
    dir() {
      const dir = mkdtempSync(path.join(tmpdir(), 'penmoss-release-'));
      dirs.push(dir);
      return dir;
    },
    remove() {
      for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Runs `command` with a Scratch, then removes its directories whether it succeeded or not. */
/** @template T @param {(scratch: Scratch) => Promise<T>} command @returns {Promise<T>} */
async function withScratch(command) {
  const scratch = scratchDirs();
  try {
    return await command(scratch);
  } finally {
    scratch.remove();
  }
}

/** `file`, or a copy of it in `scratch` named `name`, for uploading under that name. */
/** @param {string} file @param {string} name @param {Scratch} scratch */
function named(file, name, scratch) {
  if (path.basename(file) === name) return file;
  const copy = path.join(scratch.dir(), name);
  copyFileSync(file, copy);
  return copy;
}

/**
 * Refuses a feed that does not name `zipName`, or a zip not named so: electron-updater looks
 * for the file the feed names.
 * @param {string} zip @param {string} feed @param {string} zipName
 */
function checkFeed(zip, feed, zipName) {
  if (path.basename(zip) !== zipName) {
    throw new Error(`The zip must be ${zipName} (the build's own), not ${path.basename(zip)}.`);
  }
  if (
    !new RegExp(`^\\s*-?\\s*url: ${zipName.replace(/\./g, '\\.')}\\s*$`, 'm').test(
      readFileSync(feed, 'utf8'),
    )
  ) {
    throw new Error(
      `${path.basename(feed)} does not name ${zipName}: not publishing a feed that would break updates.`,
    );
  }
}

/**
 * Publishes build `run`'s APK: creates `build-<run>` as a prerelease (or replaces the APK on a
 * re-run), then carries a Mac app into it and keeps the last `keep` builds.
 * @param {Gh} gh @param {{ run: number, sha: string, apk: string, keep?: number }} build
 */
export async function publishApk(gh, { run, sha, apk, keep = KEEP }) {
  return withScratch(async (scratch) => {
    const releases = await gh.list();
    const tag = `build-${run}`;
    const file = named(apk, `penmoss-${run}.apk`, scratch);
    const existing = releases.find((release) => release.tag === tag);
    if (existing) {
      await gh.upload(tag, file);
      gh.log(`${tag}: APK replaced`);
    } else {
      const notes = `${headerNotes({ run, sha, subject: await gh.subject(sha) })}\n\n${macNotes(run, null)}`;
      const title = `Penmoss build ${run} (${sha.slice(0, 7)})`;
      await gh.create({ tag, sha, title, notes, files: [file] });
      releases.push({
        tag,
        target: sha,
        body: notes,
        prerelease: true,
        assets: [{ name: path.basename(file) }],
      });
      gh.log(`${tag}: created as a prerelease`);
    }
    await reconcile(gh, releases, new Map(), scratch);
    await prune(gh, releases, keep);
  });
}

/**
 * Publishes a Mac app built from `sha` on that commit's release (the newest, if a re-run made
 * two), then passes it on to newer releases that hold an older one. Does nothing when the
 * commit has no release (its Android build failed, or it was pruned). A signed build's `zip`
 * and `feed` (A1015) go with it, the feed as `latest-mac.yml`; the feed must name that zip.
 * @param {Gh} gh @param {{ sha: string, dmg: string, zip?: string, feed?: string }} build
 */
export async function publishMac(gh, { sha, dmg, zip, feed }) {
  if ((zip === undefined) !== (feed === undefined)) {
    throw new Error('Give both --zip and --feed, or neither.');
  }
  const releases = await gh.list();
  const own = releases
    .filter(({ tag, target }) => target === sha && buildNumber(tag) !== null)
    .sort(
      (a, b) =>
        /** @type {number} */ (buildNumber(b.tag)) - /** @type {number} */ (buildNumber(a.tag)),
    )[0];
  if (!own) {
    gh.log(`No build-* release for ${sha}: nothing to attach the Mac app to.`);
    return;
  }
  const n = /** @type {number} */ (buildNumber(own.tag));
  const name = `penmoss-mac-${n}.dmg`;
  // The zip is uploaded under the name the feed was written with, never renamed.
  if (zip !== undefined && feed !== undefined) checkFeed(zip, feed, `penmoss-mac-${n}.zip`);
  return withScratch(async (scratch) => {
    const files = [
      named(dmg, name, scratch),
      ...(zip !== undefined && feed !== undefined ? [zip, named(feed, FEED, scratch)] : []),
    ];
    for (const file of files) await gh.upload(own.tag, file);
    const names = files.map((file) => path.basename(file));
    await dropOtherMacFiles(gh, own, names);
    own.body = withMacNotes(own.body, n, n, names.length > 1);
    await gh.editNotes(own.tag, own.body);
    gh.log(`${own.tag}: its own Mac app`);
    await reconcile(
      gh,
      releases,
      new Map(files.map((file) => [`${n}/${path.basename(file)}`, file])),
      scratch,
    );
  });
}

/**
 * @typedef {{ build: number, sha: string, version: string }} AlphaPart
 * @typedef {{ android?: AlphaPart, mac?: AlphaPart }} AlphaState
 */

/** What the alpha release holds, from the record in its notes. @param {string} body @returns {AlphaState} */
export function alphaState(body) {
  const match = ALPHA_STATE.exec(body);
  if (!match?.[1]) return {};
  try {
    /** @type {AlphaState} */
    const state = JSON.parse(match[1]);
    return typeof state === 'object' && state !== null ? state : {};
  } catch {
    return {};
  }
}

/** How to install a stable release, between its notes and its changelog link (PEN-107). */
export function stableInstall() {
  return [
    '### Install',
    '',
    `- **Mac** (Apple Silicon and Intel): download \`${PUBLIC_DMG}\`, open it and drag **Penmoss** to **Applications**. Penmoss updates itself from here after that.`,
    `- **Android**: download \`${PUBLIC_APK}\` on the phone and open it. It installs over any earlier Penmoss APK from GitHub. App id \`app.penmoss\`, signed with the sideload key (certificate SHA-256 \`${SIDELOAD_CERT}\`).`,
    '',
    `\`${SUMS}\` lists every file's SHA-256: \`shasum -a 256 -c ${SUMS} --ignore-missing\`.`,
  ].join('\n');
}

/** @param {AlphaState} state */
export function alphaNotes(state) {
  const { android, mac } = state;
  const at = (/** @type {AlphaPart} */ part) =>
    `version \`${part.version}\`, build ${part.build} from main at ${part.sha.slice(0, 7)}`;
  return [
    `<!-- penmoss-alpha ${JSON.stringify(state)} -->`,
    'Penmoss Alpha: the newest build of main, replaced by every merge (P4). It is a prerelease, never Latest; stable releases are [Latest](https://github.com/htxryan/penmoss/releases/latest).',
    '',
    '### Mac (Apple Silicon and Intel)',
    '',
    mac
      ? `\`${PUBLIC_DMG}\`: ${at(mac)}. Open it and drag **Penmoss** to **Applications**. On the Alpha update channel the app updates itself from \`${ALPHA_FEED}\` here.`
      : 'No Mac app yet: it is built on the Mac when the Mac is awake.',
    '',
    '### Android',
    '',
    android
      ? `\`${PUBLIC_APK}\`: ${at(android)}. Download it on the phone and open it; it installs over any earlier Penmoss APK from this page or a stable release while its build is newer. App id \`app.penmoss\`, signed with the sideload key (certificate SHA-256 \`${SIDELOAD_CERT}\`).`
      : 'No APK yet.',
    '',
    `\`${SUMS}\` lists every file's SHA-256: \`shasum -a 256 -c ${SUMS} --ignore-missing\`.`,
  ].join('\n');
}

/** A file's SHA-256, read in 1 MB pieces. @param {string} file */
export function sha256(file) {
  const hash = createHash('sha256');
  const buffer = Buffer.alloc(1 << 20);
  const fd = openSync(file, 'r');
  try {
    for (let read = readSync(fd, buffer); read > 0; read = readSync(fd, buffer)) {
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
}

/** `SHA256SUMS.txt` as a map from name to hash. @param {string} text */
export function parseSums(text) {
  /** @type {Map<string, string>} */
  const sums = new Map();
  for (const line of text.split('\n')) {
    const match = /^([0-9a-f]{64}) [ *](.+)$/.exec(line.trim());
    if (match?.[1] && match[2]) sums.set(match[2], match[1]);
  }
  return sums;
}

/** @param {Map<string, string>} sums */
export function formatSums(sums) {
  return [...sums.keys()]
    .sort()
    .map((name) => `${sums.get(name)}  ${name}\n`)
    .join('');
}

/**
 * Replaces build `run`'s files on the rolling `alpha` prerelease (P4): its APK as `Penmoss.apk`,
 * and/or its Mac app as `Penmoss.dmg` with the update zip and `alpha-mac.yml`. A part already
 * holding the same or a newer build is left alone, so a late job never takes alpha back. Upload
 * order: the APK, the dmg, the zip, `SHA256SUMS.txt`, the feed last; then older zips go, except
 * the one the previous feed named, so a download already under way can finish. The `alpha` tag
 * then moves to the commit of the newest build it holds. Creates the release the first time.
 * @param {Gh} gh
 * @param {{ run: number, sha: string, version: string, apk?: string, dmg?: string, zip?: string, feed?: string }} build
 */
export async function publishAlpha(gh, { run, sha, version, apk, dmg, zip, feed }) {
  const mac = [dmg, zip, feed].filter((file) => file !== undefined).length;
  if (mac !== 0 && mac !== 3) throw new Error('Give --dmg, --zip and --feed together.');
  if (apk === undefined && mac === 0) throw new Error('Give --apk, or --dmg, --zip and --feed.');
  if (zip !== undefined && feed !== undefined) checkFeed(zip, feed, `penmoss-mac-${run}.zip`);
  if (
    feed !== undefined &&
    !new RegExp(`^version: '?${version.replace(/\./g, '\\.')}'?$`, 'm').test(
      readFileSync(feed, 'utf8'),
    )
  ) {
    throw new Error(`${path.basename(feed)} is not version ${version}.`);
  }

  const releases = await gh.list();
  const alpha = releases.find(({ tag }) => tag === ALPHA);
  const state = alpha ? alphaState(alpha.body) : {};
  const part = { build: run, sha, version };
  /** @type {AlphaState} */
  const next = { ...state };
  if (apk !== undefined && !(state.android && state.android.build >= run)) next.android = part;
  if (dmg !== undefined && !(state.mac && state.mac.build >= run)) next.mac = part;
  if (next.android !== part && next.mac !== part) {
    gh.log(`${ALPHA}: already holds build ${run} or newer; nothing to replace.`);
    return;
  }

  await withScratch(async (scratch) => {
    /** @type {string[]} */
    const payload = [];
    if (next.android === part && apk !== undefined) payload.push(named(apk, PUBLIC_APK, scratch));
    if (next.mac === part && dmg !== undefined && zip !== undefined) {
      payload.push(named(dmg, PUBLIC_DMG, scratch), zip);
    }
    const newFeed =
      next.mac === part && feed !== undefined ? named(feed, ALPHA_FEED, scratch) : null;

    // Zips: the new one, and the newest older one (the previous feed's), stay; the rest go.
    const existing = (alpha?.assets ?? []).map(({ name }) => name);
    /** @type {string[]} */
    let stale = [];
    if (newFeed !== null) {
      const older = existing
        .filter((name) => ZIP.test(name) && name !== path.basename(/** @type {string} */ (zip)))
        .sort(
          (a, b) =>
            /** @type {number} */ (buildNumber(b, ZIP)) -
            /** @type {number} */ (buildNumber(a, ZIP)),
        );
      stale = older.slice(1);
    }
    const uploaded = [...payload, ...(newFeed ? [newFeed] : [])].map((file) => path.basename(file));
    const after = new Set([...existing.filter((name) => !stale.includes(name)), ...uploaded]);
    after.delete(SUMS);

    // The checksums of every file alpha will hold: the old list's for the files that stay.
    /** @type {Map<string, string>} */
    let sums = new Map();
    if (existing.includes(SUMS)) {
      sums = parseSums(readFileSync(await gh.download(ALPHA, SUMS, scratch.dir()), 'utf8'));
    }
    for (const file of [...payload, ...(newFeed ? [newFeed] : [])]) {
      sums.set(path.basename(file), sha256(file));
    }
    for (const name of [...sums.keys()]) if (!after.has(name)) sums.delete(name);
    for (const name of after) {
      if (!sums.has(name)) gh.log(`::warning::${ALPHA}: no checksum for ${name}`);
    }
    const sumsFile = path.join(scratch.dir(), SUMS);
    writeFileSync(sumsFile, formatSums(sums));

    if (!alpha) {
      await gh.create({
        tag: ALPHA,
        sha,
        title: 'Penmoss Alpha',
        notes: alphaNotes(next),
        files: [],
      });
      gh.log(`${ALPHA}: created as a prerelease at ${sha.slice(0, 7)}`);
    }
    for (const file of [...payload, sumsFile, ...(newFeed ? [newFeed] : [])]) {
      await gh.upload(ALPHA, file);
    }
    for (const name of stale) await gh.deleteAsset(ALPHA, name);

    const newest = [next.android, next.mac]
      .filter((p) => p !== undefined)
      .sort((a, b) => b.build - a.build)[0];
    if (alpha && newest) await gh.moveTag(ALPHA, newest.sha);
    // The notes section publish-notes writes (PEN-106) stays when the files change.
    await gh.editNotes(
      ALPHA,
      withNotesSection(alphaNotes(next), notesSectionOf(alpha?.body ?? '')),
    );
    gh.log(
      `${ALPHA}: ${[next.android === part ? 'APK' : '', next.mac === part ? 'Mac app' : ''].filter(Boolean).join(' and ')} from build ${run} (${version})${newest ? `, tag at ${newest.sha.slice(0, 7)}` : ''}`,
    );
  });
}

/**
 * Creates the draft release of stable tag `tag` (P3, R5): `Penmoss.dmg`, `Penmoss.apk`,
 * `penmoss-mac-X.Y.Z.zip`, `release-notes.json` (PEN-107), `SHA256SUMS.txt` listing the app
 * files and the feed, and `latest-mac.yml` last. Its text is the Release notes since
 * `previous`, up to its `build` (`stableNotes`). A -rc.N tag makes a draft prerelease. A re-run
 * replaces the files and the text on its draft; a release already published is never touched.
 * @param {Gh} gh
 * @param {{ tag: string, build: number, previous?: string | null, dmg: string, apk: string, zip: string, feed: string, repo?: string, date?: string }} release
 */
export async function draftStable(
  gh,
  {
    tag,
    build,
    previous = null,
    dmg,
    apk,
    zip,
    feed,
    repo = 'htxryan/penmoss',
    date = new Date().toISOString().slice(0, 10),
  },
) {
  const parsed = parseReleaseTag(tag);
  if (parsed === null) throw new Error(`${tag} is not vX.Y.Z or vX.Y.Z-rc.N.`);
  const { version } = parsed;
  checkFeed(zip, feed, `penmoss-mac-${version}.zip`);
  if (
    !new RegExp(`^version: '?${version.replace(/\./g, '\\.')}'?$`, 'm').test(
      readFileSync(feed, 'utf8'),
    )
  ) {
    throw new Error(`${path.basename(feed)} is not version ${version}.`);
  }
  const existing = await gh.findRelease(tag);
  if (existing && !existing.draft) {
    throw new Error(`${tag} is already published: not changing it.`);
  }
  await withScratch(async (scratch) => {
    const payload = [named(dmg, PUBLIC_DMG, scratch), named(apk, PUBLIC_APK, scratch), zip];
    const feedFile = named(feed, FEED, scratch);
    /** @type {Map<string, string>} */
    const sums = new Map();
    for (const file of [...payload, feedFile]) sums.set(path.basename(file), sha256(file));
    const sumsFile = path.join(scratch.dir(), SUMS);
    writeFileSync(sumsFile, formatSums(sums));
    const notes = stableNotes(await loadNotes(gh, await gh.list(), scratch.dir()), {
      tag,
      version,
      build,
      previous: previous || null,
      date,
      repo,
      install: stableInstall(),
    });
    const notesFile = path.join(scratch.dir(), NOTES_FILE);
    writeFileSync(notesFile, `${JSON.stringify(notes.file, null, 2)}\n`);
    const files = [...payload, notesFile, sumsFile, feedFile];
    if (existing) {
      for (const file of files) await gh.upload(tag, file);
      await gh.editNotes(tag, notes.body);
      gh.log(`${tag}: the draft's files and text replaced`);
    } else {
      await gh.createDraft({
        tag,
        title: `Penmoss ${version}`,
        files,
        prerelease: parsed.prerelease,
        notes: notes.body,
      });
      gh.log(
        `${tag}: draft${parsed.prerelease ? ' prerelease' : ''} created; publish it on the Releases page`,
      );
    }
  });
}

/**
 * The `gh` CLI as a Gh. With `dryRun`, changes are printed, not made; reads still happen.
 * @param {{ repo: string, dryRun?: boolean }} options @returns {Gh}
 */
export function cliGh({ repo, dryRun = false }) {
  /** @param {string[]} args @param {string} [input] */
  const run = (args, input) =>
    execFileSync('gh', args, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'inherit'] });
  /** @param {string[]} args @param {string} [input] */
  const change = async (args, input) => {
    if (dryRun) console.log(`[dry run] gh ${args.join(' ')}${input ? `\n${input}\n[end]` : ''}`);
    else run(args, input);
  };
  return {
    async list() {
      /** @type {{ tag_name: string, target_commitish: string, body: string | null, draft: boolean, prerelease: boolean, assets: { name: string }[] }[]} */
      const releases = JSON.parse(run(['api', `repos/${repo}/releases?per_page=100`]));
      return releases
        .filter((release) => !release.draft)
        .map((release) => ({
          tag: release.tag_name,
          target: release.target_commitish,
          body: release.body ?? '',
          prerelease: release.prerelease,
          assets: release.assets.map(({ name }) => ({ name })),
        }));
    },
    async tags() {
      const out = run([
        'api',
        '--paginate',
        `repos/${repo}/git/matching-refs/tags/v`,
        '--jq',
        '.[].ref',
      ]);
      return out
        .split('\n')
        .filter(Boolean)
        .map((ref) => ref.replace(/^refs\/tags\//, ''));
    },
    async subject(sha) {
      return run([
        'api',
        `repos/${repo}/commits/${sha}`,
        '--jq',
        '.commit.message | split("\\n")[0]',
      ]).trim();
    },
    create: ({ tag, sha, title, notes, files }) =>
      change(
        [
          'release',
          'create',
          tag,
          ...files,
          '--repo',
          repo,
          '--target',
          sha,
          '--title',
          title,
          '--notes-file',
          '-',
          '--prerelease',
          '--latest=false',
        ],
        notes,
      ),
    async findRelease(tag) {
      /** @type {{ tag_name: string, target_commitish: string, body: string | null, draft: boolean, prerelease: boolean, assets: { name: string }[] }[]} */
      const releases = JSON.parse(run(['api', `repos/${repo}/releases?per_page=100`]));
      const found = releases.find((release) => release.tag_name === tag);
      if (!found) return null;
      return {
        tag: found.tag_name,
        target: found.target_commitish,
        body: found.body ?? '',
        prerelease: found.prerelease,
        draft: found.draft,
        assets: found.assets.map(({ name }) => ({ name })),
      };
    },
    createDraft: ({ tag, title, files, prerelease, notes }) =>
      change(
        [
          'release',
          'create',
          tag,
          ...files,
          '--repo',
          repo,
          '--draft',
          '--verify-tag',
          '--title',
          title,
          '--notes-file',
          '-',
          ...(prerelease ? ['--prerelease'] : []),
        ],
        notes,
      ),
    upload: (tag, file) => change(['release', 'upload', tag, file, '--repo', repo, '--clobber']),
    deleteAsset: (tag, name) =>
      change(['release', 'delete-asset', tag, name, '--repo', repo, '--yes']),
    async download(tag, name, dir) {
      // A dry run downloads nothing (a dmg is 230 MB): it leaves an empty file in its place.
      const args = ['release', 'download', tag, '--repo', repo, '--pattern', name, '--dir', dir];
      if (dryRun) {
        console.log(`[dry run] gh ${args.join(' ')} (an empty stand-in)`);
        writeFileSync(path.join(dir, name), '');
      } else run(args);
      return path.join(dir, name);
    },
    editNotes: (tag, notes) =>
      change(['release', 'edit', tag, '--repo', repo, '--notes-file', '-'], notes),
    markPrerelease: (tag) =>
      change(['release', 'edit', tag, '--repo', repo, '--prerelease', '--latest=false']),
    moveTag: (tag, sha) =>
      change([
        'api',
        '-X',
        'PATCH',
        `repos/${repo}/git/refs/tags/${tag}`,
        '-f',
        `sha=${sha}`,
        '-F',
        'force=true',
      ]),
    remove: (tag) => change(['release', 'delete', tag, '--repo', repo, '--cleanup-tag', '--yes']),
    async compare(base, head) {
      const out = run(['api', `repos/${repo}/compare/${base}...${head}`, '--jq', '.commits[].sha']);
      return out.split('\n').filter(Boolean);
    },
    async pullsOf(sha) {
      return JSON.parse(
        run([
          'api',
          `repos/${repo}/commits/${sha}/pulls`,
          '--jq',
          '[.[] | { number, body, mergedTo: (if .merged_at then .base.ref else null end) }]',
        ]),
      );
    },
    async pull(number) {
      return JSON.parse(
        run([
          'api',
          `repos/${repo}/pulls/${number}`,
          '--jq',
          '{ number, body, mergedTo: (if .merged_at then .base.ref else null end) }',
        ]),
      );
    },
    log: (message) => console.log(message),
  };
}

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      run: { type: 'string' },
      sha: { type: 'string' },
      version: { type: 'string' },
      tag: { type: 'string' },
      previous: { type: 'string' },
      build: { type: 'string' },
      apk: { type: 'string' },
      dmg: { type: 'string' },
      zip: { type: 'string' },
      feed: { type: 'string' },
      pr: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
    },
  });
  const repo = process.env.REPO ?? process.env.GITHUB_REPOSITORY;
  if (!repo) throw new Error('Set REPO (owner/name).');
  const gh = cliGh({ repo, dryRun: values['dry-run'] });
  const [command] = positionals;
  /** @param {string | undefined} file */
  const exists = (file) => {
    if (file !== undefined && !existsSync(file)) throw new Error(`No such file: ${file}`);
    return file;
  };
  if (command === 'publish-apk' && values.run && values.sha && values.apk) {
    await publishApk(gh, { run: Number(values.run), sha: values.sha, apk: values.apk });
  } else if (command === 'publish-mac' && values.sha && values.dmg) {
    await publishMac(gh, {
      sha: values.sha,
      dmg: values.dmg,
      ...(values.zip ? { zip: values.zip } : {}),
      ...(values.feed ? { feed: values.feed } : {}),
    });
  } else if (command === 'publish-alpha' && values.run && values.sha && values.version) {
    await publishAlpha(gh, {
      run: Number(values.run),
      sha: values.sha,
      version: values.version,
      ...(values.apk ? { apk: exists(values.apk) } : {}),
      ...(values.dmg ? { dmg: exists(values.dmg) } : {}),
      ...(values.zip ? { zip: exists(values.zip) } : {}),
      ...(values.feed ? { feed: exists(values.feed) } : {}),
    });
  } else if (command === 'publish-notes' && values.run && values.sha) {
    const run = Number(values.run);
    const sha = values.sha;
    await withScratch((scratch) => publishNotes(gh, { run, sha, dir: scratch.dir() }));
  } else if (command === 'fix-note' && values.pr) {
    const pr = Number(values.pr);
    await withScratch((scratch) => fixNote(gh, { pr, dir: scratch.dir() }));
  } else if (command === 'play-version') {
    console.log(
      playVersion(
        await gh.tags(),
        (await gh.list()).map((release) => release.tag),
      ),
    );
  } else if (command === 'version' && values.run) {
    console.log(appVersion(await gh.tags(), Number(values.run)));
  } else if (command === 'release-info' && values.tag) {
    const info = releaseInfo(values.tag, await gh.tags());
    console.log(
      `version=${info.version}\nprerelease=${info.prerelease}\nprevious=${info.previous ?? ''}`,
    );
  } else if (
    command === 'draft-stable' &&
    values.tag &&
    values.build &&
    values.dmg &&
    values.apk &&
    values.zip &&
    values.feed
  ) {
    await draftStable(gh, {
      tag: values.tag,
      build: Number(values.build),
      repo,
      previous: values.previous || null,
      dmg: /** @type {string} */ (exists(values.dmg)),
      apk: /** @type {string} */ (exists(values.apk)),
      zip: /** @type {string} */ (exists(values.zip)),
      feed: /** @type {string} */ (exists(values.feed)),
    });
  } else {
    throw new Error(
      'Usage: releases.mjs publish-apk --run N --sha SHA --apk FILE | publish-mac --sha SHA --dmg FILE [--zip FILE --feed FILE] | publish-alpha --run N --sha SHA --version V [--apk FILE] [--dmg FILE --zip FILE --feed FILE] | publish-notes --run N --sha SHA | fix-note --pr N | version --run N | release-info --tag vX.Y.Z | draft-stable --tag vX.Y.Z --build N [--previous TAG] --dmg FILE --apk FILE --zip FILE --feed FILE [--dry-run]',
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
