/// <reference types="node" />
/**
 * Invisible characters in the names an owner check shows (#170 F11, #174 review; architecture
 * review A12): apps/android/contract/invisible-v1.json is `@penmoss/core`'s `stripInvisible`
 * (with a space for each, as the owner check's words use it) over names that hide or fake text,
 * so the Kotlin `OwnerWordsTest` checks `OwnerWords`' port of the same rules against this build
 * of core rather than against tests copied from the Mac's.
 *
 * After changing `packages/core/src/invisible.ts`, write the file again:
 * `PENMOSS_WRITE_CONTRACTS=1 pnpm --filter @penmoss/android-editor test invisible-contract`.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stripInvisible } from '@penmoss/core/invisible';
import { describe, expect, it } from 'vitest';
import contract from '../../contract/invisible-v1.json';

/** Names with each kind of invisible character, and with each kind that draws something. */
const NAMES = [
  'Plan',
  'Budget ‮gnirts⁩',
  'exe.‭gpj‬',
  '⁦isolated⁩ ⁧rtl⁩ ⁨first⁩',
  '‎left‏ right؜',
  'zero​width⁠joiner﻿mark',
  'soft­hyphen',
  'line para end',
  'stray\u{E0041}\u{E0042}tags',
  'می‌خواهم',
  'Sha‍lom',
  'family \u{1F468}‍\u{1F469}‍\u{1F467}',
  'coder \u{1F469}\u{1F3FD}‍\u{1F4BB}',
  'heart ❤️‍\u{1F525}',
  'Scotland \u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}',
  'black flag alone \u{1F3F4}​',
  'emoji then joiner \u{1F600}‍',
];

describe('invisible characters contract v1', () => {
  it('is core’s stripInvisible over each name, exactly', () => {
    const expected = {
      version: 1,
      vectors: NAMES.map((text) => ({ text, visible: stripInvisible(text, ' ') })),
    };
    if (process.env['PENMOSS_WRITE_CONTRACTS']) {
      // Run from the package, as `pnpm --filter` does.
      const file = resolve(process.cwd(), '../contract/invisible-v1.json');
      writeFileSync(file, `${JSON.stringify(expected, null, 2)}\n`);
    }
    expect(contract).toEqual(expected);
  });
});
