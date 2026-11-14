import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { ports } from '../../scripts/ports.mjs';
import { contentSecurityPolicy } from './csp';
import { excalidrawAssets } from './excalidraw-assets';

const page = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/**
 * The Mac app's page (T29), built into the files the app serves (`task desktop:build`). Since
 * T59 (D49) it is the only build: no server to proxy to, no service worker and no spike page.
 */
export default defineConfig({
  // Excalidraw's fonts, bundled for the drawing editor (PEN-28).
  plugins: [react(), excalidrawAssets()],
  resolve: {
    alias: [
      {
        // The codec (packages/core) uses only the math syntax; the package's entry also has its
        // HTML renderer, which imports KaTeX. Dev pre-bundling kept that KaTeX in the codec's
        // start-up load, and once Excalidraw's Mermaid shared the version it became a file of its
        // own there (PEN-28, blocks.spec.ts's T12): resolve the package to its syntax alone.
        find: /^micromark-extension-math$/,
        replacement: page(
          '../../packages/core/node_modules/micromark-extension-math/lib/syntax.js',
        ),
      },
    ],
  },
  server: {
    // 5173, or this checkout's port block (scripts/ports.mjs).
    port: ports().vite,
    strictPort: true,
  },
  preview: {
    // `vite preview` of a production build runs under the page's own policy (A1038).
    headers: { 'Content-Security-Policy': contentSecurityPolicy() },
  },
  build: {
    rollupOptions: {
      input: { main: page('./index.html') },
    },
  },
});
