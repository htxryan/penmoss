import { describe, expect, it } from 'vitest';
import {
  designProblems,
  mockupLabelProblems,
  mockupTitles,
  REVIEW_CHECKS,
  reviewProblems,
} from '../src/design-check.ts';
import type { PlanReview } from '../src/planning.ts';

const MAIN = '24699f96a1b2c3d4e5f60718293a4b5c6d7e8f90';
const allOk = (main = MAIN): PlanReview => ({
  main,
  checks: Object.fromEntries(Object.keys(REVIEW_CHECKS).map((id) => [id, { ok: true, note: '' }])),
  titleCaseExceptions: [],
});

/** PEN-137's first consent mockup, as Ryan reviewed it. */
const CONSENT = `<!doctype html><html><head><style>button{width:150px}</style></head><body>
<section role="dialog"><h2>Share how you use Penmoss?</h2>
<p>Penmoss keeps a record of what you do, by name, on this Mac.</p>
<h3>What is recorded</h3><h3>Never Recorded</h3>
<label>Analytics Id <span class="hint">a random id, not your name</span></label>
<div class="row"><button>Share usage data</button><button>Don&rsquo;t Share</button></div>
<svg><text>ignored label</text></svg></section></body></html>`;

describe('the design check (A1649)', () => {
  it("reads a mockup's titles, leaving hints, prose and drawings out", () => {
    expect(mockupTitles(CONSENT)).toEqual([
      'Share how you use Penmoss?',
      'What is recorded',
      'Never Recorded',
      'Analytics Id',
      'Share usage data',
      'Don’t Share',
    ]);
  });

  it('names each label not in Title Case, with what it should say', () => {
    expect(mockupLabelProblems([{ file: 'ac1.html', html: CONSENT }])).toEqual([
      'ac1.html: "Share how you use Penmoss?" should read "Share How You Use Penmoss?"',
      'ac1.html: "What is recorded" should read "What Is Recorded"',
      'ac1.html: "Analytics Id" should read "Analytics ID"',
      'ac1.html: "Share usage data" should read "Share Usage Data"',
    ]);
  });

  it('skips the exceptions the session names', () => {
    expect(
      mockupLabelProblems(
        [{ file: 'ac1.html', html: CONSENT }],
        ['Share how you use Penmoss?', 'What is recorded', 'Analytics Id', 'Share usage data'],
      ),
    ).toEqual([]);
  });

  it('asks for the self-review when there is none', () => {
    expect(reviewProblems(null, MAIN)[0]).toMatch(/no "review"/);
  });

  it('refuses a self-review of an older main', () => {
    expect(reviewProblems(allOk('0d40d497'), MAIN)).toEqual([
      expect.stringMatching(/against main 0d40d497, but the snapshot is main 24699f96a1/),
    ]);
    expect(reviewProblems(allOk(MAIN.slice(0, 8)), MAIN)).toEqual([]);
  });

  it('names a missing or failing checklist item', () => {
    const review = allOk();
    const rest = Object.fromEntries(
      Object.entries(review.checks).filter(([id]) => id !== 'parity'),
    );
    const problems = reviewProblems(
      {
        ...review,
        checks: {
          ...rest,
          destructive: { ok: false, note: 'Delete My Shared Data has no confirm' },
        },
      },
      MAIN,
    );
    expect(problems).toEqual([
      expect.stringMatching(/no "parity" item/),
      expect.stringMatching(/"destructive" not met: Delete My Shared Data has no confirm/),
    ]);
  });

  it('checks nothing for a plan without a design', () => {
    expect(designProblems({ designUrl: null, review: null, mockups: [], main: MAIN })).toEqual([]);
  });

  it('checks the review and the labels of a design', () => {
    const problems = designProblems({
      designUrl: 'https://claude.ai/artifact/d',
      review: allOk(),
      mockups: [{ file: 'ac1.html', html: CONSENT }],
      main: MAIN,
    });
    expect(problems).toHaveLength(4);
    expect(problems[0]).toMatch(/^a mockup label isn't in Title Case: ac1\.html/);
  });
});
