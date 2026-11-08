// @ts-check
import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import { reactRefresh } from 'eslint-plugin-react-refresh';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import { penmossLintPlugin } from './packages/ui/lint/no-literal-colours.js';

export default defineConfig(
  globalIgnores([
    '**/node_modules/',
    '**/dist/',
    '**/.wrangler/',
    // Astro's generated types (site/).
    '**/.astro/',
    '**/coverage/',
    '**/test-results/',
    '**/playwright-report/',
    '**/worker-configuration.d.ts',
    'prototype/',
    'docs/',
    'spikes/',
    // The web bundle copied in for deploys (task web:bundle).
    // The Android app's Gradle output and the editor bundle built into its assets (T32).
    'apps/android/**/build/',
    'apps/android/.gradle/',
    'apps/android/app/src/main/assets/editor/',
  ]),
  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Code style (plan #style): named exports only.
      'no-restricted-exports': [
        'error',
        { restrictDefaultExports: { direct: true, named: true, defaultFrom: true } },
      ],
    },
  },
  {
    // Tool config files and the Workers' entries must use default exports.
    files: ['**/*.config.{js,mjs,ts}', 'apps/relay/src/index.ts'],
    rules: { 'no-restricted-exports': 'off' },
  },
  {
    // Plain JavaScript, and the type declarations beside the scripts (scripts/ports.d.mts),
    // which no tsconfig includes.
    files: ['**/*.js', '**/*.mjs', '**/*.cjs', 'scripts/*.d.mts'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: globals.node },
  },
  {
    // CommonJS files (electron-builder's config) load modules with require().
    files: ['**/*.cjs'],
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    files: ['apps/web/src/sw/*.js'],
    languageOptions: { globals: globals.serviceworker },
  },
  {
    files: ['apps/web/**/*.tsx', 'packages/ui/**/*.tsx', 'packages/editor/**/*.tsx'],
    extends: [reactHooks.configs.flat.recommended],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['apps/web/src/**/*.tsx'],
    extends: [reactRefresh.configs.vite()],
  },
  {
    // T28 (A244): UI colours come from theme tokens. The built-in themes are the one place
    // colours are written as literals; stylesheets get the same rule from stylelint.
    files: [
      'apps/web/src/**/*.{ts,tsx}',
      'packages/ui/src/**/*.{ts,tsx}',
      'packages/editor/src/**/*.{ts,tsx}',
      // The Mac app's windows (T29): their background comes from the theme too.
      'apps/desktop/src/**/*.ts',
      // The Android editor page (T32).
      'apps/android/editor/src/**/*.ts',
    ],
    ignores: ['packages/ui/src/theme/builtins.ts'],
    plugins: { penmoss: penmossLintPlugin },
    rules: { 'penmoss/no-literal-colours': 'error' },
  },
  prettier,
);
