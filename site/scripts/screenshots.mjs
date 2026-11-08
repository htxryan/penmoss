// penmoss.app's screenshots from the demo notebook (T80.9, A1210): `task site:screenshots`.
//
//   node scripts/screenshots.mjs           regenerate site/public/img/<shot>-<scheme>.webp
//   node scripts/screenshots.mjs --check   regenerate into a temp folder and fail unless every
//                                          image is byte for byte the one in site/public/img
//
// It runs scripts/screenshots.spec.ts (the web app under Vite as the Mac app's page, through
// the web suite's stand-in for the Mac, in headless Chromium: W10), which writes PNGs at
// 2880×1800, then encodes each as WebP with Chromium's own encoder (canvas.toBlob), at the
// highest quality from 0.92 down that keeps it within 200 KB. Same pixels, same bytes.
// `PENMOSS_SHOTS_PNG=<dir>` keeps the PNGs there.
/* global Image, document -- the encoder runs in Chromium's page */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { HEIGHT, IMG_DIR, imageProblems, MAX_BYTES, NAMES, WIDTH } from './images.mjs';

const SITE = fileURLToPath(new URL('../', import.meta.url));
const check = process.argv.includes('--check');

/** WebP qualities tried, best first; the first within budget is kept. */
const QUALITIES = [0.92, 0.88, 0.84, 0.8, 0.76, 0.72, 0.68, 0.64, 0.6];

const sha256 = (/** @type {Buffer} */ bytes) => createHash('sha256').update(bytes).digest('hex');

function run() {
  const work = mkdtempSync(path.join(tmpdir(), 'penmoss-site-shots-'));
  try {
    const png = process.env['PENMOSS_SHOTS_PNG'] ?? path.join(work, 'png');
    rmSync(png, { recursive: true, force: true });
    const result = spawnSync(
      'pnpm',
      ['exec', 'playwright', 'test', '--config', 'scripts/screenshots.config.ts'],
      { cwd: SITE, stdio: 'inherit', env: { ...process.env, PENMOSS_SHOTS_DIR: png } },
    );
    if (result.status !== 0) throw new Error('The screenshot run failed (see above).');
    return { work, png };
  } catch (error) {
    rmSync(work, { recursive: true, force: true });
    throw error;
  }
}

/** Each PNG in `png` as WebP within budget, by its .webp name. @param {string} png */
async function encode(png) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    /** @type {Map<string, { bytes: Buffer, quality: number }>} */
    const out = new Map();
    for (const name of NAMES) {
      const file = path.join(png, name.replace(/\.webp$/, '.png'));
      const data = readFileSync(file).toString('base64');
      let kept = null;
      for (const quality of QUALITIES) {
        const encoded = await page.evaluate(
          async ({ data, quality }) => {
            const image = new Image();
            image.src = `data:image/png;base64,${data}`;
            await image.decode();
            const canvas = document.createElement('canvas');
            canvas.width = image.naturalWidth;
            canvas.height = image.naturalHeight;
            canvas.getContext('2d')?.drawImage(image, 0, 0);
            const blob = await new Promise((resolve) =>
              canvas.toBlob(resolve, 'image/webp', quality),
            );
            if (!(blob instanceof Blob) || blob.type !== 'image/webp') return null;
            const bytes = new Uint8Array(await blob.arrayBuffer());
            let text = '';
            for (let i = 0; i < bytes.length; i += 0x8000) {
              text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
            }
            return { b64: btoa(text), width: image.naturalWidth, height: image.naturalHeight };
          },
          { data, quality },
        );
        if (!encoded) throw new Error('This Chromium cannot encode WebP.');
        if (encoded.width !== WIDTH || encoded.height !== HEIGHT) {
          throw new Error(`${name}: ${encoded.width}×${encoded.height}, not ${WIDTH}×${HEIGHT}`);
        }
        const bytes = Buffer.from(encoded.b64, 'base64');
        kept = { bytes, quality };
        if (bytes.length <= MAX_BYTES) break;
      }
      if (!kept || kept.bytes.length > MAX_BYTES) {
        throw new Error(`${name} is over ${MAX_BYTES} bytes even at quality ${QUALITIES.at(-1)}.`);
      }
      out.set(name, kept);
    }
    return out;
  } finally {
    await browser.close();
  }
}

const { work, png } = run();
try {
  const images = await encode(png);
  const target = check ? path.join(work, 'img') : IMG_DIR;
  mkdirSync(target, { recursive: true });
  let differ = 0;
  for (const [name, { bytes, quality }] of images) {
    writeFileSync(path.join(target, name), bytes);
    let mark = '';
    if (check) {
      let committed = null;
      try {
        committed = readFileSync(path.join(IMG_DIR, name));
      } catch {
        // Missing: it differs.
      }
      const same = committed !== null && committed.equals(bytes);
      if (!same) differ++;
      mark = same ? '  same' : '  DIFFERS';
    }
    console.log(
      `${name.padEnd(20)} ${String(bytes.length).padStart(7)} bytes  q${quality}  ${sha256(bytes).slice(0, 16)}${mark}`,
    );
  }
  const problems = imageProblems(target);
  for (const problem of problems) console.error(problem);
  if (problems.length > 0) process.exitCode = 1;
  if (check) {
    const extra = readdirSync(target).filter((file) => !NAMES.includes(file));
    if (extra.length > 0) console.error(`Unexpected files: ${extra.join(', ')}`);
    if (differ > 0) {
      console.error(`${differ} image(s) differ from site/public/img: the run is not reproducible.`);
      process.exitCode = 1;
    } else {
      console.log('Every image matches site/public/img byte for byte.');
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
