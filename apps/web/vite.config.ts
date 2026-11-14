import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { ports } from '../../scripts/ports.mjs';
import { contentSecurityPolicy } from './csp';

const page = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/**
 * The markdown parser's `decode-named-character-reference` without the DOM (its `worker` and
 * `default` build): the browser build makes an element as it loads, and the Time Machine's worker
 * (PEN-21) has no `document`. Found from the parser that depends on it.
 */
const ENTITIES = 'decode-named-character-reference';
const entitiesWithoutDom = (): string => {
  const fromCore = createRequire(page('../../packages/core/package.json'));
  return createRequire(fromCore.resolve('mdast-util-from-markdown')).resolve(ENTITIES);
};

/** The worker's bundle takes the build without the DOM. */
const workerEntities = (): Plugin => ({
  name: 'penmoss-worker-entities',
  enforce: 'pre',
  resolveId: (source) => (source === ENTITIES ? entitiesWithoutDom() : null),
});

/**
 * The Mac app's page (T29), built into the files the app serves (`task desktop:build`). Since
 * T59 (D49) it is the only build: no server to proxy to, no service worker and no spike page.
 */
export default defineConfig(({ command }) => ({
  plugins: [react()],
  // The dev server bundles dependencies once for the page and the worker alike, so there both
  // take the build without the DOM; it decodes the same references from a table.
  ...(command === 'serve'
    ? {
        resolve: {
          alias: [{ find: new RegExp(`^${ENTITIES}$`), replacement: entitiesWithoutDom() }],
        },
      }
    : {}),
  server: {
    // 5173, or this checkout's port block (scripts/ports.mjs).
    port: ports().vite,
    strictPort: true,
  },
  preview: {
    // `vite preview` of a production build runs under the page's own policy (A1038).
    headers: { 'Content-Security-Policy': contentSecurityPolicy() },
  },
  // The Time Machine's worker (PEN-21) is an ES module, so it may load chunks of its own.
  worker: { format: 'es', plugins: () => [workerEntities()] },
  build: {
    rollupOptions: {
      input: { main: page('./index.html') },
    },
  },
}));
