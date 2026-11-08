// penmoss.app's screenshots are there and within budget (T80.9, A1210): every
// site/public/img/<shot>-<scheme>.webp, WebP at 2880×1800, 200 KB or less. Run by
// `pnpm --filter @penmoss/site test` (so `task check`) and first in `task site:test`.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { HEIGHT, imageProblems, MAX_BYTES, NAMES, webpSize, WIDTH } from './images.mjs';

const dir = mkdtempSync(path.join(tmpdir(), 'penmoss-site-images-'));
after(() => rmSync(dir, { recursive: true, force: true }));

/**
 * A lossless WebP header (VP8L) of the given size, padded to `bytes`.
 * @param {number} width @param {number} height @param {number} [bytes]
 */
function vp8l(width, height, bytes = 64) {
  const b = Buffer.alloc(bytes);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(bytes - 8, 4);
  b.write('WEBP', 8, 'ascii');
  b.write('VP8L', 12, 'ascii');
  b.writeUInt32LE(bytes - 20, 16);
  b[20] = 0x2f;
  b.writeUInt32LE(((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14), 21);
  return b;
}

/** A lossy WebP header (VP8) of the given size. @param {number} width @param {number} height */
function vp8(width, height) {
  const b = Buffer.alloc(64);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(56, 4);
  b.write('WEBP', 8, 'ascii');
  b.write('VP8 ', 12, 'ascii');
  b.writeUInt32LE(44, 16);
  b.set([0x9d, 0x01, 0x2a], 23);
  b.writeUInt16LE(width, 26);
  b.writeUInt16LE(height, 28);
  return b;
}

describe('the screenshot check', () => {
  it('reads the size of lossy and lossless WebP, and nothing else', () => {
    assert.deepEqual(webpSize(vp8(2880, 1800)), { width: 2880, height: 1800 });
    assert.deepEqual(webpSize(vp8l(2880, 1800)), { width: 2880, height: 1800 });
    assert.equal(webpSize(Buffer.from('\x89PNG\r\n\x1a\n' + ' '.repeat(40))), null);
  });

  it('names a missing image, a wrong size and one over budget', () => {
    const [first, second, third, ...rest] = NAMES;
    assert.ok(first && second && third);
    const folder = mkdtempSync(path.join(dir, 'img-'));
    writeFileSync(path.join(folder, second), vp8(1440, 900));
    writeFileSync(path.join(folder, third), vp8l(WIDTH, HEIGHT, MAX_BYTES + 2));
    for (const name of rest) writeFileSync(path.join(folder, name), vp8(WIDTH, HEIGHT));
    assert.deepEqual(imageProblems(folder), [
      `${first}: missing (run task site:screenshots)`,
      `${second}: 1440×900, not ${WIDTH}×${HEIGHT}`,
      `${third}: ${MAX_BYTES + 2} bytes, over the ${MAX_BYTES}-byte budget`,
    ]);
  });
});

describe('site/public/img', () => {
  it('has every shot in light and dark, as WebP at 2880×1800 within 200 KB', () => {
    assert.equal(NAMES.length, 10);
    assert.deepEqual(imageProblems(), []);
  });
});
