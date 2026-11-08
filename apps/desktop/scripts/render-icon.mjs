// Renders build/icon.svg (the Moss Pen mark on the macOS icon grid: an 824 px squircle on a
// 1024 px canvas, written by scripts/brand-assets.mjs) to build/icon.png, which
// electron-builder turns into the .icns and Linux uses as is. `task brand` runs both;
// on its own: xvfb-run -a pnpm exec electron scripts/render-icon.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app, BrowserWindow } from 'electron';

const here = import.meta.dirname;

void app.whenReady().then(async () => {
  const svg = readFileSync(join(here, '..', 'build', 'icon.svg'), 'utf8');
  const window = new BrowserWindow({
    width: 1024,
    height: 1024,
    show: false,
    transparent: true,
    frame: false,
    useContentSize: true,
    webPreferences: { offscreen: true, zoomFactor: 1 },
  });
  const page = `<html><body style="margin:0;background:transparent">${svg.replace('<svg ', '<svg width="1024" height="1024" ')}</body></html>`;
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const image = await window.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 });
  writeFileSync(
    join(here, '..', 'build', 'icon.png'),
    image.resize({ width: 1024, height: 1024 }).toPNG(),
  );
  app.quit();
});
