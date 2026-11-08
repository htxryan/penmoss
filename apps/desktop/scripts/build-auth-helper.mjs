// Builds the Mac's owner check (native/penmoss-auth.swift, T41, A504) into dist/native/Penmoss:
// one universal binary (arm64 and x86_64), so both halves of a universal app carry the same
// file. electron-builder ships it in Contents/Resources/auth/Penmoss and signs it with the app
// (electron-builder.config.cjs, beforePack and mac.extraResources).
//
//   node scripts/build-auth-helper.mjs            build it; fails without swiftc (Xcode tools)
//   node scripts/build-auth-helper.mjs --if-mac   the same on macOS, nothing elsewhere
//
// Without the helper the app refuses every admin change; it never asks a weaker question.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = join(dirname(fileURLToPath(import.meta.url)), '..');
export const SOURCE = join(desktop, 'native', 'penmoss-auth.swift');
export const HELPER = join(desktop, 'dist', 'native', 'Penmoss');
const MIN_MACOS = '12.0';
const ARCHES = ['arm64', 'x86_64'];

export function buildAuthHelper() {
  if (process.platform !== 'darwin') {
    throw new Error('The owner check (native/penmoss-auth.swift) builds only on macOS.');
  }
  mkdirSync(dirname(HELPER), { recursive: true });
  const work = mkdtempSync(join(tmpdir(), 'penmoss-auth-'));
  try {
    const slices = ARCHES.map((arch) => {
      const out = join(work, arch);
      execFileSync(
        'xcrun',
        ['swiftc', '-O', '-target', `${arch}-apple-macos${MIN_MACOS}`, SOURCE, '-o', out],
        { stdio: 'inherit' },
      );
      return out;
    });
    execFileSync('lipo', ['-create', ...slices, '-output', HELPER], { stdio: 'inherit' });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  if (!statSync(HELPER).isFile()) throw new Error(`No helper at ${HELPER}`);
  console.log(`[penmoss] owner check built: ${HELPER}`);
  return HELPER;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--if-mac') && process.platform !== 'darwin') {
    console.log('[penmoss] not macOS: the owner check is not built');
  } else {
    buildAuthHelper();
  }
}
