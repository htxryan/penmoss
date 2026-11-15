// The rolling `alpha` prerelease (P4): the newest build's `Penmoss.apk`, and `Penmoss.dmg` with
// its update zip and `alpha-mac.yml`, replaced by every merge. A record in its notes says which
// build each part is from, so a late job never takes it back.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  PUBLIC_APK,
  PUBLIC_DMG,
  SIDELOAD_CERT,
  SUMS,
  ZIP,
  checkFeed,
  formatSums,
  named,
  parseSums,
  sha256,
  withScratch,
} from './release-files.mjs';
import { notesSectionOf, withNotesSection } from './release-notes.mjs';
import { buildNumber } from './release-versions.mjs';

/** @typedef {import('./release-gh.mjs').Gh} Gh */

/** The rolling Alpha release (P4) and its feed's fixed name (P2). */
export const ALPHA = 'alpha';
export const ALPHA_FEED = 'alpha-mac.yml';
const ALPHA_STATE = /<!-- penmoss-alpha (\{.*?\}) -->/;

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
