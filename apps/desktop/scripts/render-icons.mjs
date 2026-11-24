// Renders the Mac app's icons from the SVGs scripts/brand-assets.mjs writes, in an offscreen
// Electron window, drawn at one size and scaled to each PNG's:
//
// - icon: build/icon.svg (the Moss Pen mark on the macOS icon grid: an 824 px squircle on a
//   1024 px canvas) to build/icon.png, which electron-builder turns into the .icns and Linux uses
//   as is.
// - tray: resources/tray/trayTemplate.svg (the menu bar icon, T51 item 17, A945) to
//   trayTemplate.png (18 px) and trayTemplate@2x.png (36 px): black on transparent, a template
//   image macOS tints for the menu bar. build.mjs copies them beside boot.cjs (dist/tray). Drawn
//   large, then scaled down, so the small sizes are smoothly anti-aliased.
//
// `task brand` runs it for both; on its own, for both or one:
// xvfb-run -a pnpm exec electron scripts/render-icons.mjs [icon|tray]
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app, BrowserWindow } from 'electron';

const root = join(import.meta.dirname, '..');

/**
 * Each icon: its SVG, the size it is drawn at, each PNG's size, and the resize quality.
 * @type {Record<string, { svg: string, drawn: number, outputs: Record<string, number>, quality?: 'good' | 'better' | 'best' }>}
 */
const TARGETS = {
  icon: { svg: 'build/icon.svg', drawn: 1024, outputs: { 'build/icon.png': 1024 } },
  tray: {
    svg: 'resources/tray/trayTemplate.svg',
    drawn: 576,
    outputs: {
      'resources/tray/trayTemplate.png': 18,
      'resources/tray/trayTemplate@2x.png': 36,
    },
    quality: 'best',
  },
};

/** @param {(typeof TARGETS)[string]} target */
async function render({ svg: file, drawn, outputs, quality }) {
  const svg = readFileSync(join(root, file), 'utf8');
  const window = new BrowserWindow({
    width: drawn,
    height: drawn,
    show: false,
    transparent: true,
    frame: false,
    useContentSize: true,
    webPreferences: { offscreen: true, zoomFactor: 1 },
  });
  const page = `<html><body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${drawn}" height="${drawn}" `)}</body></html>`;
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const image = await window.webContents.capturePage({ x: 0, y: 0, width: drawn, height: drawn });
  for (const [name, size] of Object.entries(outputs)) {
    writeFileSync(
      join(root, name),
      image.resize({ width: size, height: size, ...(quality ? { quality } : {}) }).toPNG(),
    );
  }
  // Left open: closing the last window would quit the app (on Linux) before the next icon.
}

const asked = process.argv.slice(2).filter((arg) => !arg.startsWith('-'));
const unknown = asked.filter((name) => !Object.hasOwn(TARGETS, name));
if (unknown.length > 0) {
  console.error(`render-icons.mjs: no icon named ${unknown.join(', ')} (${Object.keys(TARGETS)})`);
  process.exit(2);
}

void app.whenReady().then(async () => {
  for (const name of asked.length > 0 ? asked : Object.keys(TARGETS)) {
    await render(/** @type {(typeof TARGETS)[string]} */ (TARGETS[name]));
  }
  app.quit();
});
