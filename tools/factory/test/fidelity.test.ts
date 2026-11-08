import { describe, expect, it } from 'vitest';
import { fidelityFeedback, parseReview, renderFidelity, settle } from '../src/fidelity.ts';

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
  });
});
