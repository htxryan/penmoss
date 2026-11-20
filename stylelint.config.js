// @ts-check
import { typeTokens } from './scripts/stylelint-type.mjs';

/**
 * Stylesheets take every colour from a theme token (T28, A244): no hex
 * colours, no named colours, no colour functions. `transparent`,
 * `currentColor` and system colours (Canvas, CanvasText) stay allowed, and
 * `color-mix()` over tokens is how derived colours are made. The colours
 * themselves live in packages/ui/src/theme/builtins.ts.
 *
 * And every text size, weight and line height from a type role or step
 * (A1561, scripts/stylelint-type.mjs): the values live in
 * apps/web/src/shell/type.css.
 *
 * @type {import('stylelint').Config}
 */
export default {
  plugins: [typeTokens],
  rules: {
    'penmoss/type-tokens': true,
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
    {
      // The usage dashboard's own palette (PEN-137): its series colours, validated for
      // colour-blind readers in light and dark, are not the app's themes.
      files: ['apps/telemetry-dashboard/src/client/styles.css'],
      rules: { 'color-no-hex': null },
    },
    {
      // Where the type scale and its roles are written (A1561).
      files: ['apps/web/src/shell/type.css'],
      rules: { 'penmoss/type-tokens': null },
    },
    {
      // penmoss.app has its own type, as it has its own palette (P13).
      files: ['site/**/*.css'],
      rules: { 'penmoss/type-tokens': null },
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
