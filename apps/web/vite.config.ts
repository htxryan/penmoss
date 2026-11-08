import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { ports } from '../../scripts/ports.mjs';
import { contentSecurityPolicy } from './csp';

const page = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/**
 * The Mac app's page (T29), built into the files the app serves (`task desktop:build`). Since
 * T59 (D49) it is the only build: no server to proxy to, no service worker and no spike page.
 */
export default defineConfig({
  plugins: [react()],
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
