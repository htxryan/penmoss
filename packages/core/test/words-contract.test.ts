/**
 * Sizes and times on Android (PEN-188): `apps/android/contract/words-v1.json` holds sizes and
 * times and what core's `formatBytes` and `timeAgo` write for each. Android's `formatBytes`
 * (`ui/common/Sizes.kt`) and `timeAgo` (`ui/common/TimeAgo.kt`) replay every case
 * (`WordsContractTest`), so the phone writes a size and how long ago as the Mac does.
 *
 * After changing the rules or the cases, write the contract again:
 * `PENMOSS_WRITE_CONTRACTS=1 pnpm --filter @penmoss/core exec vitest run test/words-contract`,
 * then `pnpm exec prettier --write apps/android/contract/words-v1.json`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { formatBytes, timeAgo } from '../src/words';

const FILE = fileURLToPath(
  new URL('../../../apps/android/contract/words-v1.json', import.meta.url),
);

const SIZES = [
  0, 1, 512, 999, 1000, 1023, 1024, 1050, 1536, 9_630, 9_949, 9_950, 9_999, 10_000, 99_499, 640_000,
  999_499, 999_500, 999_999, 1_000_000, 1_048_576, 2_000_000, 2_097_152, 12_400_000, 20_000_000,
  100_000_000, 196_725_760, 219_000_000, 400_000_000, 999_999_999, 1_000_000_000, 1_250_000_000,
  52_428_800, 1_000_000_000_000, 1_234_000_000_000_000,
];

const ZONE = 'America/Chicago';
const NOW = Date.parse('2026-11-24T18:00:00Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** Times before (and one after) `NOW`, in ms. */
const AGES = [
  -5 * MINUTE,
  0,
  59_999,
  MINUTE,
  2 * MINUTE - 1,
  30 * MINUTE,
  59 * MINUTE,
  HOUR,
  3 * HOUR + 59 * MINUTE,
  23 * HOUR + 59 * MINUTE,
  DAY,
  DAY + 7 * HOUR,
  6 * DAY,
  30 * DAY,
  330 * DAY,
  NOW - Date.parse('2026-01-01T06:00:00Z'),
  NOW - Date.parse('2026-01-01T03:00:00Z'),
  400 * DAY,
  3 * 365 * DAY,
];

function contract() {
  return {
    $comment:
      'Sizes and how long ago, as core writes them (PEN-188): `sizes` pairs bytes with packages/core/src/words.ts formatBytes(); `ago` pairs a time (epoch ms) with timeAgo(at, now, zone). Written and checked by packages/core/test/words-contract.test.ts; Android’s Sizes.kt and TimeAgo.kt replay every case (WordsContractTest).',
    version: 1,
    sizes: SIZES.map((bytes) => [bytes, formatBytes(bytes)]),
    now: NOW,
    zone: ZONE,
    ago: AGES.map((age) => [NOW - age, timeAgo(NOW - age, NOW, ZONE)]),
  };
}

const text = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

if (process.env['PENMOSS_WRITE_CONTRACTS'] === '1') writeFileSync(FILE, text(contract()));

describe('words-v1.json', () => {
  it('holds what formatBytes() and timeAgo() write for each case', () => {
    const stored = JSON.parse(readFileSync(FILE, 'utf8')) as unknown;
    expect(stored).toEqual(contract());
  });
});
