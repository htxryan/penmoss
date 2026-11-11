import { describe, expect, it } from 'vitest';
import { onlyTableHousekeeping, settleRisks, unrunPlatforms } from '../src/risks.ts';

// The risks PEN-63's and PEN-73's agents wrote, before the factory's proof and numbering.
const MAC_ANDROID =
  'The Mac spec (apps/desktop/test/e2e/download.spec.ts) and the Android instrumented test could not be run in the sandbox (no VM, no emulator).';
const PADDING =
  'Prettier re-padded the decisions table (A-NEW-1 is wider than the ID column); the gate renumbers and reformats it.';

describe("the PR's risks after proof (stale risks)", () => {
  it("notes the factory's passing proof on a risk that says its spec couldn't run here", () => {
    expect(settleRisks([MAC_ANDROID], ['web', 'mac', 'android'])).toEqual([
      `${MAC_ANDROID} (The factory's proof ran the Mac and Android specs: passed.)`,
    ]);
    // Only the platforms proof ran and saw pass are named.
    expect(settleRisks([MAC_ANDROID], ['web', 'mac'])).toEqual([
      `${MAC_ANDROID} (The factory's proof ran the Mac spec: passed.)`,
    ]);
  });

  it('keeps it as it is when no proof ran for what it names', () => {
    expect(settleRisks([MAC_ANDROID], ['web'])).toEqual([MAC_ANDROID]);
    expect(settleRisks([MAC_ANDROID], [])).toEqual([MAC_ANDROID]);
  });

  it("never drops or notes a risk that isn't about a spec it couldn't run", () => {
    const real = [
      'The Android IME may still lose the first keystroke on Samsung keyboards.',
      'Mac users on macOS 12 see the old icon until they restart.',
    ];
    expect(settleRisks(real, ['web', 'mac', 'android'])).toEqual(real);
    expect(unrunPlatforms(real[1]!, ['mac'])).toEqual([]);
  });

  it("drops a risk that is only the decisions table's padding or numbering", () => {
    expect(onlyTableHousekeeping(PADDING)).toBe(true);
    expect(onlyTableHousekeeping('A-NEW-1 will be renumbered by the gate.')).toBe(true);
    expect(settleRisks([PADDING, MAC_ANDROID], [])).toEqual([MAC_ANDROID]);
  });

  it('keeps a decisions risk with anything else in it', () => {
    for (const risk of [
      'Prettier re-padded the decisions table; the new row also contradicts A1220, which needs a look.',
      'A-NEW-1 amends A1220, so the site and the docs disagree until both merge.',
      'Prettier re-padded apps/web/src/a.ts.',
    ])
      expect(settleRisks([risk], ['web', 'mac', 'android'])).toEqual([risk]);
  });
});
