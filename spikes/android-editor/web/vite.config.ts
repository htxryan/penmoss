import { defineConfig } from 'vite';

// One JS file and one CSS file, copied into the Android app's assets by
// ../build-web.sh. Relative base so the bundle works under any asset path.
export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'chrome120',
    assetsInlineLimit: 100_000,
    cssCodeSplit: false,
    chunkSizeWarningLimit: 1000,
    modulePreload: false,
    rolldownOptions: {
      output: {
        entryFileNames: 'editor.js',
        assetFileNames: 'editor[extname]',
        codeSplitting: false,
      },
    },
  },
});
