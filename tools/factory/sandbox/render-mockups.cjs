/**
 * Renders the agreed mockups to PNG before validation's capture session starts (PEN-63's
 * validation, A1323). The host runs it inside the gate's sandbox, from `apps/web`, whose
 * `@playwright/test` and headless Chromium it uses (as the doctor's "headless Chromium starts"
 * check does); never headed. Node reads it on stdin (src/mockups.ts), so `require` resolves from
 * the folder it runs in.
 *
 *   node - <mockups folder> <out folder>
 *
 * Each `<id>.html` becomes `<id>-mockup.png`, at a desktop window's 1280×800, or a phone's
 * 390×844 when the page's content is no wider than a phone (a phone frame on a page). One JSON
 * line per mockup on stdout: `{ file, png, width, height }`, or `{ file, error }`.
 */
const { mkdirSync, readdirSync } = require('node:fs');
const { basename, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('@playwright/test');

const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 390, height: 844 };
/** Content this wide or narrower is a phone's screen. */
const PHONE_MAX = 500;
/** Per step: one hung load or screenshot costs seconds, not minutes. */
const STEP_MS = 15_000;

const [from, to] = process.argv.slice(2).map((p) => resolve(p));
const say = (line) => console.log(JSON.stringify(line));
const why = (error) => String((error && error.message) || error).split('\n')[0];

/** How wide the page's content is in a desktop window: the span of its visible elements. */
function contentWidth() {
  let left = Infinity;
  let right = -Infinity;
  for (const e of globalThis.document.body.querySelectorAll('*')) {
    const box = e.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) continue;
    left = Math.min(left, box.left);
    right = Math.max(right, box.right);
  }
  return right > left ? right - left : 0;
}

async function main() {
  const files = readdirSync(from)
    .filter((n) => n.endsWith('.html'))
    .sort();
  if (files.length === 0) return;
  mkdirSync(to, { recursive: true });
  const browser = await chromium.launch({ headless: true, timeout: 60_000 });
  try {
    for (const file of files) {
      const png = `${basename(file, '.html')}-mockup.png`;
      const page = await browser.newPage({ viewport: DESKTOP });
      page.setDefaultTimeout(STEP_MS);
      try {
        // A font or image that never loads doesn't stop the render: what loaded is shown.
        await page
          .goto(pathToFileURL(resolve(from, file)).href, { waitUntil: 'load' })
          .catch(() => undefined);
        const width = await page.evaluate(contentWidth);
        const size = width > 0 && width <= PHONE_MAX ? PHONE : DESKTOP;
        await page.setViewportSize(size);
        await page.screenshot({ path: resolve(to, png) });
        say({ file, png, ...size });
      } catch (error) {
        say({ file, error: why(error) });
      } finally {
        await page.close().catch(() => undefined);
      }
    }
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(why(error));
  process.exit(1);
});
