// Stable releases (P3, R5, A1189): the draft of a vX.Y.Z tag, with its files and its Release
// notes (PEN-107). Ryan publishes it, which makes it Latest.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  FEED,
  PUBLIC_APK,
  PUBLIC_DMG,
  SIDELOAD_CERT,
  SUMS,
  checkFeed,
  formatSums,
  named,
  sha256,
  withScratch,
} from './release-files.mjs';
import { NOTES_FILE, loadNotes, stableNotes } from './release-notes.mjs';
import { parseReleaseTag } from './release-versions.mjs';

/** @typedef {import('./release-gh.mjs').Gh} Gh */

/**
 * The files of a stable release (P2, R5), in upload order: the feed last.
 * @param {string} version
 */
export function stableFiles(version) {
  return [PUBLIC_DMG, PUBLIC_APK, `penmoss-mac-${version}.zip`, NOTES_FILE, SUMS, FEED];
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
