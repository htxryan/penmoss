// The CLI's own bundle inside the Mac app (PEN-121, amending A992):
//
//   Penmoss.app/Contents/Helpers/Penmoss CLI.app/Contents/
//     Info.plist       the app's, with its own bundle id (app.penmoss.mac.cli), background only
//     MacOS/Penmoss    a copy of the app's executable
//     Frameworks/      Penmoss Helper*.app: copies of the app's (a few hundred KB each)
//                      *.framework -> ../../../../Frameworks/*.framework (Electron Framework…)
//     Resources     -> ../../../Resources                  (app.asar, the owner check, icons)
//
// Every process starts by checking in with LaunchServices under its bundle's Info.plist, before
// any of Penmoss's code runs. When agents ran Contents/MacOS/Penmoss --penmoss-cli, each MCP
// server checked in as app.penmoss.mac, and opening Penmoss only activated one of them. From
// this bundle the CLI checks in as another, background-only app, so it never stands in for
// Penmoss.
//
// Two links that look simpler don't work. A symlink for app.asar itself (rather than for the
// Resources folder) leaves Electron hung before it runs any of the app's code. And a symlink for
// the whole Frameworks folder sends the helper processes to the app's own helpers: Chromium
// resolves a process's executable path, so a helper reached through the link finds itself in
// Penmoss.app, takes its bundle id (app.penmoss.mac) and looks for the CLI's Mach port
// rendezvous under the wrong name. Copies of the helpers resolve to this bundle.
//
// The copy keeps the app's fuses: on a Mac they are in Electron Framework, which both
// executables load. CFBundleName, CFBundleExecutable and ElectronAsarIntegrity stay as the app's,
// so Electron finds its helpers ("Penmoss Helper") and checks the same app.asar. electron-builder
// signs the bundle and its helpers with the app (signIgnore skips the paths through its links).
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { join } from 'node:path';

export const CLI_BUNDLE_ID = 'app.penmoss.mac.cli';
export const CLI_APP_NAME = 'Penmoss CLI.app';
/** The bundle's path inside the app's Contents (local-agents.ts has the same, CLI_EXECUTABLE). */
export const CLI_APP_IN_CONTENTS = `Helpers/${CLI_APP_NAME}`;

/** Keys the CLI bundle must not claim: links and files open in the app, never in the CLI. */
const DROPPED_KEYS = ['CFBundleURLTypes', 'CFBundleDocumentTypes', 'NSUserActivityTypes'];

/** plutil, quiet: a key that isn't there is not an error for -remove. */
function plutil(args) {
  execFileSync('/usr/bin/plutil', args, { stdio: ['ignore', 'ignore', 'pipe'] });
}

/**
 * Writes the CLI bundle inside `appPath` (a Penmoss.app), replacing one already there.
 * @param {string} appPath
 * @returns {string} the bundle's path
 */
export function makeCliBundle(appPath) {
  const contents = join(appPath, 'Contents');
  const plist = join(contents, 'Info.plist');
  const executable = join(contents, 'MacOS', 'Penmoss');
  for (const needed of [plist, executable, join(contents, 'Frameworks')]) {
    if (!existsSync(needed)) throw new Error(`cli-bundle: ${needed} is missing`);
  }
  const bundle = join(contents, CLI_APP_IN_CONTENTS);
  rmSync(bundle, { recursive: true, force: true });
  const own = join(bundle, 'Contents');
  mkdirSync(join(own, 'MacOS'), { recursive: true });
  mkdirSync(join(own, 'Frameworks'), { recursive: true });

  const ownPlist = join(own, 'Info.plist');
  copyFileSync(plist, ownPlist);
  plutil(['-replace', 'CFBundleIdentifier', '-string', CLI_BUNDLE_ID, ownPlist]);
  plutil(['-replace', 'CFBundleDisplayName', '-string', 'Penmoss CLI', ownPlist]);
  plutil(['-replace', 'LSBackgroundOnly', '-bool', 'YES', ownPlist]);
  for (const key of DROPPED_KEYS) {
    try {
      plutil(['-remove', key, ownPlist]);
    } catch {
      // Not in the app's plist.
    }
  }

  copyFileSync(executable, join(own, 'MacOS', 'Penmoss'));
  execFileSync('/bin/chmod', ['755', join(own, 'MacOS', 'Penmoss')]);
  if (existsSync(join(contents, 'PkgInfo')))
    copyFileSync(join(contents, 'PkgInfo'), join(own, 'PkgInfo'));
  for (const name of readdirSync(join(contents, 'Frameworks'))) {
    const from = join(contents, 'Frameworks', name);
    if (name.endsWith('.app'))
      cpSync(from, join(own, 'Frameworks', name), { recursive: true, verbatimSymlinks: true });
    else symlinkSync(`../../../../Frameworks/${name}`, join(own, 'Frameworks', name));
  }
  symlinkSync('../../../Resources', join(own, 'Resources'));
  return bundle;
}

/**
 * electron-builder's afterPack: once per Mac app it packs. A universal build packs each arch into
 * a `…-temp` folder first and runs this hook on each, then again on the app @electron/universal
 * merged from them: the bundle is made only then, from the merged (universal) executable, so the
 * two arches' trees never differ.
 * @param {import('electron-builder').AfterPackContext} context
 */
export async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  if (context.appOutDir.endsWith('-temp')) return;
  const appPath = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  makeCliBundle(appPath);
}
