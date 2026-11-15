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
// The jobs live in their own modules: release-builds.mjs (build-<run>), release-alpha.mjs,
// release-stable.mjs, release-notes.mjs, release-versions.mjs (tags and versions),
// release-files.mjs (names, checksums, scratch copies) and release-gh.mjs (the `gh` CLI).
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { publishAlpha } from './release-alpha.mjs';
import { publishApk, publishMac } from './release-builds.mjs';
import { withScratch } from './release-files.mjs';
import { cliGh } from './release-gh.mjs';
import { fixNote, publishNotes } from './release-notes.mjs';
import { draftStable } from './release-stable.mjs';
import { appVersion, playVersion, releaseInfo } from './release-versions.mjs';

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
  /** @param {string} file */
  const exists = (file) => {
    if (!existsSync(file)) throw new Error(`No such file: ${file}`);
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
      dmg: exists(values.dmg),
      apk: exists(values.apk),
      zip: exists(values.zip),
      feed: exists(values.feed),
    });
  } else {
    throw new Error(
      'Usage: releases.mjs publish-apk --run N --sha SHA --apk FILE | publish-mac --sha SHA --dmg FILE [--zip FILE --feed FILE] | publish-alpha --run N --sha SHA --version V [--apk FILE] [--dmg FILE --zip FILE --feed FILE] | publish-notes --run N --sha SHA | fix-note --pr N | version --run N | release-info --tag vX.Y.Z | draft-stable --tag vX.Y.Z --build N [--previous TAG] --dmg FILE --apk FILE --zip FILE --feed FILE [--dry-run]',
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
