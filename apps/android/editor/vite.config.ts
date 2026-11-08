import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

/**
 * The editor page the Android app serves from its APK through
 * WebViewAssetLoader at https://appassets.androidplatform.net/assets/editor/
 * (T32, A282). Built into the app module's assets, which git ignores; the
 * Gradle build fails with a clear message when it is missing.
 */
export default defineConfig({
  // Relative URLs: the asset loader serves the page under /assets/editor/.
  base: './',
  build: {
    outDir: fileURLToPath(new URL('../app/src/main/assets/editor', import.meta.url)),
    emptyOutDir: true,
    // Three pages (T40 P7, A478; T50 G7, A872): the editor, the graph and the git engine, each with a fixed entry name (the
    // Gradle build checks for them); lazy chunks (Mermaid, KaTeX, the codec), the code both
    // share and stylesheets keep hashed names. The APK stores js, css and html uncompressed.
    rollupOptions: {
      input: {
        editor: fileURLToPath(new URL('index.html', import.meta.url)),
        graph: fileURLToPath(new URL('graph.html', import.meta.url)),
        // The git engine page (T50 G7, A872): headless, beside the editor and the graph.
        git: fileURLToPath(new URL('git.html', import.meta.url)),
      },
      output: {
        entryFileNames: (chunk) =>
          chunk.name === 'graph' ? 'graph.js' : chunk.name === 'git' ? 'git.js' : 'editor.js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
    // Mermaid's layout engines are lazy chunks loaded only when a diagram shows.
    chunkSizeWarningLimit: 2000,
    // Android System WebView is evergreen Chromium (Android 17 and later update it through Play).
    target: 'es2023',
    sourcemap: false,
  },
});
