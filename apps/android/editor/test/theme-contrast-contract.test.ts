/// <reference types="node" />
/**
 * The theme editor's contrast warnings on the phone (T40 P1b, A419): the Kotlin port of
 * `@penmoss/ui`'s colour maths and WCAG checks must give the web's answers, pair for pair.
 * apps/android/contract/theme-contrast-v1.json holds every check (what is read on what, its
 * kind and minimum) and, for every built-in variant and a few failing ones, each check's
 * colours and ratio, plus the colour functions' results; the Kotlin `ContrastContractTest` reads the same file. The phone's
 * check is advisory: the server's `parseTheme` decides what a theme may hold.
 *
 * After changing the checks or the built-ins, write the file again:
 * `PENMOSS_WRITE_CONTRACTS=1 pnpm --filter @penmoss/android-editor test theme-contrast`.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  BUILT_IN_THEMES,
  contrast,
  contrastChecks,
  contrastProblems,
  mix,
  over,
  type ThemeColours,
} from '@penmoss/ui/theme';
import { describe, expect, it } from 'vitest';
import contract from '../../contract/theme-contrast-v1.json';

const nord = BUILT_IN_THEMES.find((theme) => theme.id === 'nord')!;
const highContrast = BUILT_IN_THEMES.find((theme) => theme.id === 'high-contrast')!;

/** Variants that fail: pale text, a yellow accent, borders that vanish. */
const FAILING: ReadonlyArray<{ name: string; colours: ThemeColours }> = [
  {
    name: 'Nord light with pale text and a yellow accent',
    colours: { ...nord.light, fg: '#c0c4cc', muted: '#d8dce4', accent: '#ffe066' },
  },
  {
    name: 'High Contrast dark with borders the colour of the page',
    colours: {
      ...highContrast.dark,
      border: highContrast.dark.bg,
      codeKeyword: '#202020',
      graph3: '#111111',
    },
  },
];

const PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['#000000', '#ffffff'],
  ['#2e3440', '#eceff4'],
  ['#ffe066', '#5e81ac'],
  ['#123456', '#fedcba'],
  ['#808080', '#7f7f7f'],
];

/** The contract as this build of `@penmoss/ui` computes it. */
function contrastContract() {
  const cases = [
    ...BUILT_IN_THEMES.flatMap((theme) =>
      (['light', 'dark'] as const).map((variant) => ({
        name: `${theme.name} ${variant}`,
        colours: theme[variant],
      })),
    ),
    ...FAILING,
  ].map(({ name, colours }) => ({
    name,
    colours,
    // In the order of `checks`: each pair's colours and ratio.
    pairs: contrastChecks(colours).map(({ fg, bg, ratio }) => [fg, bg, ratio]),
    failing: contrastProblems(colours).map((check) => check.label),
  }));
  // The same checks, in the same order, for every variant: what each is and its minimum.
  const checks = contrastChecks(BUILT_IN_THEMES[0]!.light).map(({ label, kind, min }) => ({
    label,
    kind,
    min,
  }));
  const functions = PAIRS.map(([a, b]) => ({
    a,
    b,
    contrast: contrast(a, b),
    mix: [0, 0.06, 0.07, 0.3, 0.5, 1].map((weight) => ({ weight, colour: mix(a, b, weight) })),
    over: [0.06, 0.09, 0.14, 0.38, 0.7].map((alpha) => ({ alpha, colour: over(a, alpha, b) })),
  }));
  return JSON.parse(JSON.stringify({ version: 1, functions, checks, cases })) as unknown;
}

describe('theme contrast contract v1', () => {
  it('is the web’s colour maths and contrast checks, exactly', () => {
    const expected = contrastContract();
    if (process.env['PENMOSS_WRITE_CONTRACTS']) {
      const file = resolve(process.cwd(), '../contract/theme-contrast-v1.json');
      writeFileSync(file, `${JSON.stringify(expected, null, 2)}\n`);
    }
    expect(contract).toEqual(expected);
  });

  it('has every built-in passing and the failing cases failing', () => {
    for (const each of contract.cases) {
      if (FAILING.some((failing) => failing.name === each.name)) {
        expect(each.failing.length, each.name).toBeGreaterThan(0);
      } else {
        expect(each.failing, each.name).toEqual([]);
      }
    }
  });
});
