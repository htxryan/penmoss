// Renders resources/tray/trayTemplate.svg (the menu bar icon, T51 item 17, A945, written by
// scripts/brand-assets.mjs) to trayTemplate.png (18 px) and trayTemplate@2x.png (36 px): black
// on transparent, a template image macOS tints for the menu bar. build.mjs copies them beside
// boot.cjs (dist/tray). `task brand` runs this; on its own:
// xvfb-run -a pnpm exec electron scripts/render-tray-icon.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app, BrowserWindow } from 'electron';

const dir = join(import.meta.dirname, '..', 'resources', 'tray');
/** Drawn large, then scaled down, so the small sizes are smoothly anti-aliased. */
const DRAWN = 576;
const SIZES = { 'trayTemplate.png': 18, 'trayTemplate@2x.png': 36 };

void app.whenReady().then(async () => {
  const svg = readFileSync(join(dir, 'trayTemplate.svg'), 'utf8');
  const window = new BrowserWindow({
    width: DRAWN,
    height: DRAWN,
    show: false,
    transparent: true,
    frame: false,
    useContentSize: true,
    webPreferences: { offscreen: true, zoomFactor: 1 },
  });
  const page = `<html><body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${DRAWN}" height="${DRAWN}" `)}</body></html>`;
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const image = await window.webContents.capturePage({ x: 0, y: 0, width: DRAWN, height: DRAWN });
  for (const [name, size] of Object.entries(SIZES)) {
    writeFileSync(
      join(dir, name),
      image.resize({ width: size, height: size, quality: 'best' }).toPNG(),
    );
  }
  app.quit();
});
