/**
 * Draws the 1200×630 social card (T80.11) into public/img/social.png with headless Chromium:
 * `task site:social`. The colours are the Moss Pen's own (docs/brand.md), not theme tokens.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

/** @param {string} path */
const here = (path) => fileURLToPath(new URL(path, import.meta.url));
const mark = readFileSync(here('../src/assets/moss-pen-light.svg'), 'utf8');

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; }
  body { margin: 0; width: 1200px; height: 630px; background: #fbfaf7; color: #1e2228;
    font-family: -apple-system, 'SF Pro Display', system-ui, sans-serif;
    display: flex; align-items: center; padding: 0 88px; gap: 64px; }
  .mark { width: 260px; height: 260px; flex: none; }
  .mark svg { width: 100%; height: 100%; }
  h1 { font-size: 76px; line-height: 1.02; letter-spacing: -0.035em; margin: 0 0 28px; }
  h1 span { color: #2e5a3a; }
  p { font-size: 30px; line-height: 1.35; margin: 0; color: #3b4048; }
  .site { margin-top: 28px; font-size: 26px; font-weight: 600; color: #2e5a3a; }
</style></head><body>
  <div class="mark">${mark}</div>
  <div>
    <h1>Your Git. Your Agents. <span>Your Notes.</span></h1>
    <p>A free, open source notes app for Mac and Android. Markdown in your own git repo, open to your AI agents.</p>
    <p class="site">penmoss.app</p>
  </div>
</body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
await page.setContent(html);
await page.screenshot({ path: here('../public/img/social.png'), type: 'png' });
await browser.close();
console.log('site: wrote public/img/social.png (1200×630)');
