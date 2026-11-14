import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

/**
 * Excalidraw's fonts as files of the page's own bundle (PEN-28), at `excalidraw/fonts/…`, where
 * src/drawing/drawings.ts points `EXCALIDRAW_ASSET_PATH`: the drawing editor never fetches a font
 * from a CDN (the Mac app works offline, and its CSP allows only its own files). Copied at build,
 * served from node_modules in dev. All of them, Xiaolai too (Excalidraw's Chinese, Japanese and
 * Korean hand-drawn font, 12 MB of the 13 in many small files): Excalidraw reads it for any text it
 * puts in a drawing's SVG, and would otherwise ask a CDN.
 */
export const EXCALIDRAW_FONTS = fileURLToPath(
  new URL('./node_modules/@excalidraw/excalidraw/dist/prod/fonts', import.meta.url),
);

/** Where the fonts are served from, under the page's root (drawings.ts's EXCALIDRAW_ASSETS). */
const PREFIX = 'excalidraw/fonts/';

/** Every font file to bundle, as paths relative to the fonts folder (`Excalifont/….woff2`). */
export function excalidrawFontFiles(root = EXCALIDRAW_FONTS): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        walk(path);
      } else if (name.endsWith('.woff2')) {
        files.push(relative(root, path).split(sep).join('/'));
      }
    }
  };
  walk(root);
  return files;
}

export function excalidrawAssets(): Plugin {
  return {
    name: 'penmoss-excalidraw-assets',
    configureServer(server) {
      const files = new Set(excalidrawFontFiles());
      server.middlewares.use((request, response, next) => {
        const path = (request.url ?? '').split('?')[0] ?? '';
        const file = path.startsWith(`/${PREFIX}`)
          ? decodeURIComponent(path.slice(PREFIX.length + 1))
          : null;
        if (!file || !files.has(file)) return next();
        response.setHeader('Content-Type', 'font/woff2');
        response.end(readFileSync(join(EXCALIDRAW_FONTS, file)));
      });
    },
    generateBundle() {
      for (const file of excalidrawFontFiles()) {
        this.emitFile({
          type: 'asset',
          fileName: `${PREFIX}${file}`,
          source: readFileSync(join(EXCALIDRAW_FONTS, file)),
        });
      }
    },
  };
}
