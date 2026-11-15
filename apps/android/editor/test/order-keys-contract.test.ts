/// <reference types="node" />
/**
 * Folder and note order keys (T40 P4, NT7; architecture review A12):
 * apps/android/contract/order-keys-v1.json is `@penmoss/core`'s `keyBetween` over a set of
 * bounds, so the Kotlin `OrderKeysTest` checks its port against what this build of core makes,
 * not against vectors pasted from an old run.
 *
 * After changing `packages/core/src/workspace/order.ts`, write the file again:
 * `PENMOSS_WRITE_CONTRACTS=1 pnpm --filter @penmoss/android-editor test order-keys-contract`.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { keyBetween } from '@penmoss/core/workspace';
import { describe, expect, it } from 'vitest';
import contract from '../../contract/order-keys-v1.json';

type Vector = { before: string | null; after: string | null; key: string };

/** Appending, prepending, the bounds' first keys, and halving towards one bound. */
function vectors(): Vector[] {
  const out: Vector[] = [];
  const between = (before: string | null, after: string | null) => {
    const key = keyBetween(before, after);
    out.push({ before, after, key });
    return key;
  };
  let last: string | null = null;
  for (let i = 0; i < 12; i++) last = between(last, null);
  let first: string | null = null;
  for (let i = 0; i < 6; i++) first = between(null, first);
  const a0 = between(null, null);
  between(null, a0);
  const a1 = between(a0, null);
  const mid = between(a0, a1);
  between(a0, mid);
  between(mid, a1);
  between(a0, keyBetween(a0, mid));
  between(keyBetween(null, a0), a0);
  between(a0, keyBetween(a1, null));
  let low = a0;
  for (let i = 0; i < 8; i++) low = between(low, a1);
  return out;
}

describe('order keys contract v1', () => {
  it('is core’s keyBetween over every pair of bounds, exactly', () => {
    const expected = { version: 1, vectors: vectors() };
    if (process.env['PENMOSS_WRITE_CONTRACTS']) {
      // Run from the package, as `pnpm --filter` does.
      const file = resolve(process.cwd(), '../contract/order-keys-v1.json');
      writeFileSync(file, `${JSON.stringify(expected, null, 2)}\n`);
    }
    expect(contract).toEqual(expected);
  });
});
