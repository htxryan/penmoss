import { describe, expect, it } from 'vitest';
import { buildReport, formatReport, parseRange } from '../src/report.ts';

const e = (run: string, event: string, at: string, extra: object = {}) =>
  JSON.stringify({ at: `2026-11-0${at}Z`, run, slot: 1, event, ...extra });
const ledger = [
  // #10: two gate fixes, one CI repair, 3 h to review, merged.
  e('10-a', 'claimed', '2T09:00:00'),
  e('10-a', 'gate-failed', '2T09:40:00'),
  e('10-a', 'gate-failed', '2T10:20:00'),
  e('10-a', 'ci-red', '2T11:30:00'),
  e('10-a', 'in-review', '2T12:00:00'),
  e('10-b', 'merged', '3T08:00:00'),
  // #11: straight through in 1 h.
  e('11-a', 'claimed', '4T10:00:00'),
  e('11-a', 'in-review', '4T11:00:00'),
  // #12: blocked.
  e('12-a', 'claimed', '5T10:00:00'),
  e('12-a', 'blocked', '5T10:30:00', { reason: 'needs-info' }),
  // #13: outside the range.
  e('13-a', 'claimed', '9T10:00:00'),
].join('\n');

describe('factory:report (F14)', () => {
  const r = buildReport(ledger, new Date('2026-11-01T00:00:00Z'), new Date('2026-11-08T00:00:00Z'));
  it('counts throughput, rounds, time to review and the blocked share', () => {
    expect(r).toMatchObject({
      started: 3,
      inReview: 2,
      merged: 1,
      blocked: 1,
      blockedShare: 0.33,
      gateFixesPerIssue: 1,
      ciRepairsPerIssue: 0.5,
      toReviewMinutes: { median: 120, mean: 120 },
    });
  });
  it('reads any date range', () => {
    const one = buildReport(
      ledger,
      new Date('2026-11-04T00:00:00Z'),
      new Date('2026-11-05T00:00:00Z'),
    );
    expect(one).toMatchObject({ started: 1, inReview: 1, merged: 0, blocked: 0 });
  });
  it('prints it', () => {
    expect(formatReport(r)).toContain('Claim to review    median 2 h, mean 2 h');
  });
  it('parses --from and --to, defaulting to the last week', () => {
    const now = new Date('2026-11-08T12:00:00Z');
    expect(parseRange([], now)).toEqual({ from: new Date('2026-11-01T12:00:00Z'), to: now });
    expect(parseRange(['--from', '2026-11-05', '--to', '2026-11-01'], now)).toEqual({
      error: '--from must be before --to',
    });
  });
});
