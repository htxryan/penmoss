/// <reference types="node" />
/**
 * The built-in themes the Android app ships (T40 P1, A412): apps/android/contract/themes-v1.json
 * is `@penmoss/ui`'s built-ins and token list exactly, so the phone's theme grid shows every
 * built-in offline in the web's colours and Kotlin never makes one up. The Kotlin
 * `ThemesContractTest` reads the same file, and the APK bundles it.
 *
 * After changing a built-in, write the file again:
 * `PENMOSS_WRITE_CONTRACTS=1 pnpm --filter @penmoss/android-editor test themes-contract`.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  BUILT_IN_THEMES,
  COLOUR_GROUPS,
  COLOUR_TOKENS,
  DEFAULT_EDITOR_WIDTH,
  EDITOR_WIDTH,
  FONT_CHOICES,
} from '@penmoss/ui/theme';
import { describe, expect, it } from 'vitest';
import contract from '../../contract/themes-v1.json';

/** The contract as this build of `@penmoss/ui` has it. */
function themesContract() {
  return JSON.parse(
    JSON.stringify({
      version: 1,
      groups: COLOUR_GROUPS,
      tokens: COLOUR_TOKENS.map(({ key, label, group }) => ({ key, label, group })),
      fonts: FONT_CHOICES,
      editorWidth: { ...EDITOR_WIDTH, default: DEFAULT_EDITOR_WIDTH },
      themes: BUILT_IN_THEMES,
    }),
  ) as unknown;
}

describe('themes contract v1', () => {
  it('is the built-in themes and their tokens, exactly', () => {
    const expected = themesContract();
    if (process.env['PENMOSS_WRITE_CONTRACTS']) {
      // Run from the package, as `pnpm --filter` does.
      const file = resolve(process.cwd(), '../contract/themes-v1.json');
      writeFileSync(file, `${JSON.stringify(expected, null, 2)}\n`);
    }
    expect(contract).toEqual(expected);
  });

  it('gives every built-in a colour for every token in both variants', () => {
    const keys = contract.tokens.map((token) => token.key);
    expect(contract.themes.map((theme) => theme.id)).toEqual([
      'penmoss',
      'paper',
      'slate',
      'nord',
      'solarized',
      'gruvbox',
      'rose-pine',
      'high-contrast',
    ]);
    for (const theme of contract.themes) {
      for (const variant of [theme.light, theme.dark]) {
        expect(Object.keys(variant).sort()).toEqual([...keys].sort());
        for (const colour of Object.values(variant)) expect(colour).toMatch(/^#[0-9a-f]{6}$/);
      }
    }
  });
});
