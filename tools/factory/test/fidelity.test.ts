import { describe, expect, it } from 'vitest';
import { fidelityFeedback, parseReview, renderFidelity, settle, standIn } from '../src/fidelity.ts';

const review = {
  rows: [
    {
      criterion: 'AC1 nested tags start collapsed',
      verdict: 'match',
      note: '',
      mockup: 'ac1-mockup.png',
      screenshot: 'ac1.png',
    },
    {
      criterion: 'AC2 the badge uses the accent colour',
      verdict: 'mismatch',
      note: 'The badge is red, the mockup accent green',
      mockup: 'ac2-mockup.png',
      screenshot: 'ac2.png',
    },
    {
      criterion: 'AC3 | pipes',
      verdict: 'deviation',
      note: 'Android draws its own scrollbar',
      screenshot: '../../etc/passwd',
    },
  ],
};

describe('fidelity (F19)', () => {
  it('parses verdicts and keeps only plain PNG names', () => {
    const r = parseReview(JSON.stringify(review));
    expect(r.ok && r.rows.map((x) => [x.verdict, x.screenshot])).toEqual([
      ['match', 'ac1.png'],
      ['mismatch', 'ac2.png'],
      ['deviation', undefined],
    ]);
  });
  it('refuses a verdict it does not know, or a mismatch without a note', () => {
    expect(parseReview('{"rows":[{"criterion":"x","verdict":"fine"}]}')).toMatchObject({
      ok: false,
    });
    expect(
      parseReview('{"rows":[{"criterion":"x","verdict":"mismatch","note":""}]}'),
    ).toMatchObject({ ok: false });
    expect(parseReview('nope')).toEqual({ ok: false, error: 'review.json is not JSON' });
  });
  it('tells the agent which criteria to fix', () => {
    const r = parseReview(JSON.stringify(review));
    if (!r.ok) throw new Error(r.error);
    expect(fidelityFeedback(r.rows.filter((x) => x.verdict === 'mismatch'))).toContain(
      '**AC2 the badge uses the accent colour**: The badge is red, the mockup accent green',
    );
  });
  it('turns what is left after the last round into deviations', () => {
    const r = parseReview(JSON.stringify(review));
    if (!r.ok) throw new Error(r.error);
    const row = settle(r.rows)[1];
    expect(row?.verdict).toBe('deviation');
    expect(row?.note).toMatch(/^Not fixed in the rounds allowed/);
  });
  it('renders the table with mockup and screenshot side by side, and lists deviations', () => {
    const r = parseReview(JSON.stringify(review));
    if (!r.ok) throw new Error(r.error);
    const md = renderFidelity(r.rows);
    expect(md).toContain(
      '| AC1 nested tags start collapsed | ✅ Match | ![mockup](./ac1-mockup.png) | ![screenshot](./ac1.png) |',
    );
    expect(md).toContain(
      '| AC3 \\| pipes<br>Android draws its own scrollbar | ⚠️ Deviation | — | — |',
    );
    expect(md).toContain('### Deviations');
    expect(renderFidelity([])).toBe('');
    // No other app's row: no stand-in note.
    expect(md).not.toContain('standing in');
  });

  it('labels a Mac row as the web build standing in for the Mac app (A1256)', () => {
    const rows = [
      {
        criterion: 'AC3 the row sits under Buttons',
        verdict: 'match' as const,
        note: '',
        mockup: 'fidelity-ac3-mac-mockup.png',
        screenshot: 'fidelity-ac3-mac.png',
      },
      {
        criterion: 'AC4 on macOS the field is a native select',
        verdict: 'deviation' as const,
        note: 'Headless Chromium draws no native popup',
        screenshot: 'fidelity-ac4.png',
      },
      { criterion: 'AC5 the web row', verdict: 'match' as const, note: '', screenshot: 'ac5.png' },
    ];
    expect(standIn(rows[0]!)).toBe('the Mac app');
    expect(standIn(rows[1]!)).toBe('the Mac app');
    expect(standIn(rows[2]!)).toBeUndefined();
    expect(standIn({ ...rows[2]!, screenshot: 'ac6-android.png' })).toBe('the Android app');
    // A word that only contains "mac" isn't the Mac.
    expect(standIn({ ...rows[2]!, screenshot: 'machine.png' })).toBeUndefined();
    const md = renderFidelity(rows);
    expect(md).toContain("that its own walkthrough didn't capture shows the web build");
    expect(md).toContain(
      '| Web build, standing in for the Mac app<br>![web build, standing in for the Mac app](./fidelity-ac3-mac.png) |',
    );
    expect(md).toContain('| — | ![screenshot](./ac5.png) |');
  });

  it("labels a Mac or Android walkthrough's screenshot as that app's own (PEN-94)", () => {
    const r = parseReview(
      JSON.stringify({
        rows: [
          {
            criterion: 'AC3 the Mac row',
            verdict: 'match',
            note: '',
            screenshot: 'ac3-mac.png',
            platform: 'mac',
          },
          {
            criterion: 'AC4 the Android row',
            verdict: 'match',
            note: '',
            screenshot: 'ac4-android.png',
            platform: 'android',
          },
          {
            criterion: 'AC5 the web row',
            verdict: 'match',
            note: '',
            screenshot: 'ac5.png',
            platform: 'web',
          },
          {
            criterion: 'AC6 an unknown platform',
            verdict: 'match',
            note: '',
            screenshot: 'ac6.png',
            platform: 'ios',
          },
        ],
      }),
    );
    if (!r.ok) throw new Error(r.error);
    expect(r.rows.map((row) => row.platform)).toEqual(['mac', 'android', 'web', undefined]);
    expect(r.rows.map(standIn)).toEqual([undefined, undefined, undefined, undefined]);
    const md = renderFidelity(r.rows);
    expect(md).toContain(
      '| Mac app, in the test VM<br>![Mac app, in the test VM](./ac3-mac.png) |',
    );
    expect(md).toContain(
      "| Android app, on the factory's emulator<br>![Android app, on the factory's emulator](./ac4-android.png) |",
    );
    expect(md).toContain('| — | ![screenshot](./ac5.png) |');
    // Nothing stands in, so no stand-in note.
    expect(md).not.toContain('standing in');
  });
});
