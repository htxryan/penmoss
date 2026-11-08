import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

/**
 * The JVM tests' git runner (T50 G7, A878): the git engine page's code and the CLI, bundled for
 * Node into apps/android/build/git-runner (git ignores it), so `engine-bridge`'s cross-engine tests
 * run the page the APK ships and the CLI's commands. Never shipped.
 */
export default defineConfig({
  build: {
    ssr: fileURLToPath(new URL('runner/git-runner.ts', import.meta.url)),
    outDir: fileURLToPath(new URL('../build/git-runner', import.meta.url)),
    emptyOutDir: true,
    target: 'node22',
    sourcemap: false,
    rollupOptions: {
      output: {
        entryFileNames: 'git-runner.mjs',
        format: 'es',
        codeSplitting: false,
        // The CLI bundles CommonJS packages (yaml) that require Node's modules, as its own build does.
        banner:
          "import { createRequire as __penmossRequire } from 'node:module'; const require = __penmossRequire(import.meta.url);",
      },
    },
  },
  ssr: { noExternal: true, target: 'node' },
});
