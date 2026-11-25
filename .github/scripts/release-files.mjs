// The files a release holds: their names, checksums, and the scratch copies a command uploads
// them from. Renamed copies and downloaded files go in `penmoss-release-*` directories under the
// temp dir, removed when the command ends, failed or not: the Mac runners keep /tmp between jobs,
// and a dmg is over 200 MB.
import { createHash } from 'node:crypto';
import {
  closeSync,
  copyFileSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const DMG = /^penmoss-mac-(\d+)\.dmg$/;
export const ZIP = /^penmoss-mac-(\d+)\.zip$/;
/** electron-updater's feed for the Mac (A1015): one per build release, the one of its dmg's build. */
export const FEED = 'latest-mac.yml';
/** The sideload key's certificate (A400, P8, A1219): every public APK is signed with it alone. */
export const SIDELOAD_CERT =
  '3D:B5:DA:CC:2F:A1:F5:DA:70:28:FA:78:A3:35:C8:3F:50:62:63:A5:15:88:15:B3:3C:EC:73:24:81:C3:DE:07';
/** The public file names (P2). */
export const PUBLIC_DMG = 'Penmoss.dmg';
export const PUBLIC_APK = 'Penmoss.apk';
export const SUMS = 'SHA256SUMS.txt';

/** @typedef {{ dir(): string, remove(): void }} Scratch */

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
export async function withScratch(command) {
  const scratch = scratchDirs();
  try {
    return await command(scratch);
  } finally {
    scratch.remove();
  }
}

/** `file`, or a copy of it in `scratch` named `name`, for uploading under that name. */
/** @param {string} file @param {string} name @param {Scratch} scratch */
export function named(file, name, scratch) {
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
export function checkFeed(zip, feed, zipName) {
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
