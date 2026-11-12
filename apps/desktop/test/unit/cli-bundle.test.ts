/**
 * The CLI's own bundle inside the Mac app (PEN-121): scripts/cli-bundle.mjs, electron-builder's
 * afterPack, on a stand-in Penmoss.app. Needs macOS's plutil, so it runs on a Mac only; the
 * packaged app's proof is packaged-cli.spec.ts, in the test VM.
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { afterPack, CLI_BUNDLE_ID, makeCliBundle } from '../../scripts/cli-bundle.mjs';
import { CLI_EXECUTABLE } from '../../src/local-agents';

const PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDisplayName</key><string>Penmoss</string>
  <key>CFBundleExecutable</key><string>Penmoss</string>
  <key>CFBundleIdentifier</key><string>app.penmoss.mac</string>
  <key>CFBundleName</key><string>Penmoss</string>
  <key>CFBundleURLTypes</key>
  <array><dict><key>CFBundleURLSchemes</key><array><string>penmoss</string></array></dict></array>
  <key>ElectronAsarIntegrity</key>
  <dict><key>Resources/app.asar</key><dict><key>hash</key><string>abc</string></dict></dict>
</dict>
</plist>
`;

/** One key of a plist, as plutil prints it (raw), or null when it isn't there. */
function key(plist: string, name: string): string | null {
  try {
    return execFileSync('/usr/bin/plutil', ['-extract', name, 'raw', '-o', '-', plist], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

let dir: string;
let app: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'penmoss-cli-bundle-'));
  app = join(dir, 'Penmoss.app');
  const contents = join(app, 'Contents');
  mkdirSync(join(contents, 'MacOS'), { recursive: true });
  mkdirSync(join(contents, 'Frameworks', 'Electron Framework.framework'), { recursive: true });
  mkdirSync(join(contents, 'Resources'), { recursive: true });
  writeFileSync(join(contents, 'Info.plist'), PLIST);
  writeFileSync(join(contents, 'PkgInfo'), 'APPL????');
  writeFileSync(join(contents, 'MacOS', 'Penmoss'), 'the executable', { mode: 0o755 });
  writeFileSync(join(contents, 'Resources', 'app.asar'), 'the asar');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe.runIf(process.platform === 'darwin')('the CLI bundle (PEN-121)', () => {
  it('has its own background-only bundle id, the app’s executable, Frameworks and asar', () => {
    const bundle = makeCliBundle(app);
    const own = join(bundle, 'Contents');
    expect(join(own, 'MacOS', 'Penmoss')).toBe(join(app, 'Contents', ...CLI_EXECUTABLE));
    const plist = join(own, 'Info.plist');
    expect(key(plist, 'CFBundleIdentifier')).toBe(CLI_BUNDLE_ID);
    expect(key(plist, 'CFBundleDisplayName')).toBe('Penmoss CLI');
    expect(key(plist, 'LSBackgroundOnly')).toBe('true');
    // Electron finds its helpers by the name, and checks the same asar.
    expect(key(plist, 'CFBundleName')).toBe('Penmoss');
    expect(key(plist, 'CFBundleExecutable')).toBe('Penmoss');
    expect(key(plist, 'ElectronAsarIntegrity.Resources/app\\.asar.hash')).toBe('abc');
    // Links open in the app, never in the CLI.
    expect(key(plist, 'CFBundleURLTypes')).toBe(null);
    // The app's own plist is as it was.
    expect(key(join(app, 'Contents', 'Info.plist'), 'CFBundleIdentifier')).toBe('app.penmoss.mac');

    expect(readFileSync(join(own, 'MacOS', 'Penmoss'), 'utf8')).toBe('the executable');
    expect(statSync(join(own, 'MacOS', 'Penmoss')).mode & 0o777).toBe(0o755);
    expect(readlinkSync(join(own, 'Frameworks'))).toBe('../../../Frameworks');
    expect(realpathSync(join(own, 'Frameworks'))).toBe(
      realpathSync(join(app, 'Contents', 'Frameworks')),
    );
    expect(readFileSync(join(own, 'Resources', 'app.asar'), 'utf8')).toBe('the asar');

    // Packing again replaces it.
    expect(makeCliBundle(app)).toBe(bundle);
    expect(key(plist, 'CFBundleIdentifier')).toBe(CLI_BUNDLE_ID);
  });

  it('is made once per app: not in the arches a universal build merges', async () => {
    const context = (appOutDir: string) => ({
      electronPlatformName: 'darwin',
      appOutDir,
      packager: { appInfo: { productFilename: 'Penmoss' } },
    });
    const temp = join(dir, 'mac-universal-arm64-temp');
    mkdirSync(temp);
    execFileSync('/bin/cp', ['-R', app, temp]);
    await afterPack(context(temp));
    expect(existsSync(join(temp, 'Penmoss.app', 'Contents', 'Helpers'))).toBe(false);
    await afterPack(context(dir));
    expect(existsSync(join(app, 'Contents', ...CLI_EXECUTABLE))).toBe(true);
  });
});
