// @ts-check
/**
 * Stylesheets take every colour from a theme token (T28, A244): no hex
 * colours, no named colours, no colour functions. `transparent`,
 * `currentColor` and system colours (Canvas, CanvasText) stay allowed, and
 * `color-mix()` over tokens is how derived colours are made. The colours
 * themselves live in packages/ui/src/theme/builtins.ts.
 *
 * @type {import('stylelint').Config}
 */
export default {
  rules: {
    'color-no-hex': true,
    'color-named': 'never',
    'function-disallowed-list': [
      'rgb',
      'rgba',
      'hsl',
      'hsla',
      'hwb',
      'lab',
      'lch',
      'oklab',
      'oklch',
      'color',
      'device-cmyk',
    ],
  },
  overrides: [
    {
      // Penmoss's variables for a first visit's first paint (A251), generated from
      // builtins.ts and held equal to it by apps/web/test/unit/theme-boot.test.ts.
      files: ['apps/web/src/theme/defaults.css'],
      rules: { 'color-no-hex': null },
    },
    {
      // penmoss.app's own palette (P13): the site is not themed by the app's tokens.
      files: ['site/src/styles/tokens.css'],
      rules: { 'color-no-hex': null },
    },
  ],
  ignoreFiles: [
    '**/node_modules/**',
    '**/dist/**',
    '**/.wrangler/**',
    'apps/android/**/build/**',
    'apps/android/app/src/main/assets/editor/**',
    'prototype/**',
    'docs/**',
    'spikes/**',
    '**/test-results/**',
    '**/playwright-report/**',
  ],
};
