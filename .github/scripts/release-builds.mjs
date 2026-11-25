// The build releases, `build-<run>` (A403, P3, A1188): one prerelease per main build, never
// Latest. `publishApk` creates one and keeps the last 10; `publishMac` attaches a Mac app to its
// commit's release. Every build release holds the newest Mac app built at or before it, with its
// update files (A1015), and each command ends by restoring that rule (`reconcile`).
import path from 'node:path';
import { ALPHA } from './release-alpha.mjs';
import {
  DMG,
  FEED,
  PUBLIC_APK,
  PUBLIC_DMG,
  SIDELOAD_CERT,
  ZIP,
  checkFeed,
  named,
  withScratch,
} from './release-files.mjs';
import { buildNumber } from './release-versions.mjs';

/**
 * @typedef {import('./release-gh.mjs').Gh} Gh
 * @typedef {import('./release-gh.mjs').Release} Release
 * @typedef {import('./release-files.mjs').Scratch} Scratch
 */

const KEEP = 10;
/** Builds published before A403 were `android-build-<run>`; they count towards the 10. */
const ANY_BUILD = /^(?:android-)?build-(\d+)$/;
export const MAC_MARKER = '<!-- penmoss-mac -->';

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
function newestMacUpTo(releases, n) {
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
function headerNotes({ run, sha, subject }) {
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
function macNotes(n, from, updates = false) {
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
function withMacNotes(body, n, from, updates = false) {
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
