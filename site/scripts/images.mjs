// penmoss.app's screenshots (T80.9, A1210): which ones there are, and their budget. Read by
// scripts/screenshots.mjs, which makes them, and scripts/images.test.mjs, which checks them.
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Where the site serves them from (`/img/<name>.webp`). */
export const IMG_DIR = fileURLToPath(new URL('../public/img/', import.meta.url));

export const SHOTS = /** @type {const} */ (['hero', 'editor', 'journal', 'history', 'themes']);
export const SCHEMES = /** @type {const} */ (['light', 'dark']);

/** Every image's file name: `<shot>-<scheme>.webp`. */
export const NAMES = SHOTS.flatMap((shot) => SCHEMES.map((scheme) => `${shot}-${scheme}.webp`));

/** 1440×900 at 2x. */
export const WIDTH = 2880;
export const HEIGHT = 1800;
/** The most bytes one image may have: 200 KB. */
export const MAX_BYTES = 200_000;

/**
 * A WebP file's width and height, from its header (VP8, VP8L or VP8X), or null when the bytes
 * are not WebP. @param {Uint8Array} bytes @returns {{ width: number, height: number } | null}
 */
export function webpSize(bytes) {
  const b = Buffer.from(bytes);
  if (
    b.length < 30 ||
    b.toString('ascii', 0, 4) !== 'RIFF' ||
    b.toString('ascii', 8, 12) !== 'WEBP'
  ) {
    return null;
  }
  const chunk = b.toString('ascii', 12, 16);
  if (chunk === 'VP8 ') {
    // A key frame's start code, then 14 bits each of width and height.
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === 'VP8L') {
    if (b[20] !== 0x2f) return null;
    const bits = b.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X') {
    return { width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 };
  }
  return null;
}

/**
 * What is wrong with the images in `dir`: a missing one, one that is not WebP, the wrong size,
 * or over budget. Empty when all is well. @param {string} [dir] @returns {string[]}
 */
export function imageProblems(dir = IMG_DIR) {
  const problems = [];
  for (const name of NAMES) {
    const file = path.join(dir, name);
    let bytes;
    try {
      bytes = readFileSync(file);
    } catch {
      problems.push(`${name}: missing (run task site:screenshots)`);
      continue;
    }
    const size = webpSize(bytes);
    if (!size) {
      problems.push(`${name}: not a WebP image`);
      continue;
    }
    if (size.width !== WIDTH || size.height !== HEIGHT) {
      problems.push(`${name}: ${size.width}×${size.height}, not ${WIDTH}×${HEIGHT}`);
    }
    const bytesOnDisk = statSync(file).size;
    if (bytesOnDisk > MAX_BYTES) {
      problems.push(`${name}: ${bytesOnDisk} bytes, over the ${MAX_BYTES}-byte budget`);
    }
  }
  return problems;
}
