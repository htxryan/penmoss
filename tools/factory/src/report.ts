/**
 * `factory:report` (F14, #279): what the factory did over a date range, from the run ledger.
 * Throughput (issues to In review, merged), rounds (gate fixes and CI repairs per issue), time
 * from claim to In review, and the share of issues that ended a run Blocked.
 */
import { issueOf, parseLedger, type LedgerEvent } from './ui/model.ts';

export interface Report {
  readonly from: string;
  readonly to: string;
  readonly started: number;
  readonly inReview: number;
  readonly merged: number;
  readonly blocked: number;
  readonly blockedShare: number;
  /** Gate rounds beyond the first, per issue that reached In review. */
  readonly gateFixesPerIssue: number;
  readonly ciRepairsPerIssue: number;
  /** Minutes from the first claim to the first In review. */
  readonly toReviewMinutes: { readonly median: number | null; readonly mean: number | null };
}

const median = (xs: number[]) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const round1 = (x: number) => Math.round(x * 10) / 10;

export function buildReport(ledger: string, from: Date, to: Date): Report {
  const inRange = (e: LedgerEvent) => {
    const t = Date.parse(e.at);
    return t >= from.getTime() && t < to.getTime();
  };
  const byIssue = new Map<number, LedgerEvent[]>();
  for (const e of parseLedger(ledger)) {
    const n = issueOf(e);
    if (!Number.isInteger(n)) continue;
    byIssue.set(n, [...(byIssue.get(n) ?? []), e]);
  }
  let started = 0;
  let inReview = 0;
  let merged = 0;
  let blocked = 0;
  let gateFixes = 0;
  let ciRepairs = 0;
  const toReview: number[] = [];
  for (const events of byIssue.values()) {
    const range = events.filter(inRange);
    const claim = range.find((e) => e.event === 'claimed' && e['phase'] !== 'revise');
    if (claim) started++;
    if (range.some((e) => e.event === 'merged')) merged++;
    if (range.some((e) => e.event === 'blocked')) blocked++;
    const review = range.find((e) => e.event === 'in-review');
    if (review) {
      inReview++;
      // A fix round, whether the gate's checks failed or validation found a criterion not met.
      gateFixes += range.filter(
        (e) => e.event === 'gate-failed' || e.event === 'validation-mismatch',
      ).length;
      ciRepairs += range.filter((e) => e.event === 'ci-red').length;
      // The claim may predate the range; take the issue's first.
      const first = events.find((e) => e.event === 'claimed');
      if (first) toReview.push((Date.parse(review.at) - Date.parse(first.at)) / 60_000);
    }
  }
  const touched = new Set(
    [...byIssue.entries()].filter(([, ev]) => ev.some(inRange)).map(([n]) => n),
  ).size;
  return {
    from: from.toISOString(),
    to: to.toISOString(),
    started,
    inReview,
    merged,
    blocked,
    blockedShare: touched ? Math.round((blocked / touched) * 100) / 100 : 0,
    gateFixesPerIssue: inReview ? round1(gateFixes / inReview) : 0,
    ciRepairsPerIssue: inReview ? round1(ciRepairs / inReview) : 0,
    toReviewMinutes: {
      median: toReview.length ? round1(median(toReview)!) : null,
      mean: toReview.length ? round1(toReview.reduce((a, b) => a + b, 0) / toReview.length) : null,
    },
  };
}

export function formatReport(r: Report): string {
  const day = (iso: string) => iso.slice(0, 10);
  const mins = (m: number | null) =>
    m === null ? '—' : m >= 90 ? `${round1(m / 60)} h` : `${m} min`;
  return [
    `Factory report, ${day(r.from)} to ${day(r.to)}`,
    '',
    `Started            ${r.started}`,
    `Reached In review  ${r.inReview}`,
    `Merged             ${r.merged}`,
    `Blocked            ${r.blocked} (${Math.round(r.blockedShare * 100)}% of issues worked)`,
    `Gate fix rounds    ${r.gateFixesPerIssue} per issue in review`,
    `CI repairs         ${r.ciRepairsPerIssue} per issue in review`,
    `Claim to review    median ${mins(r.toReviewMinutes.median)}, mean ${mins(r.toReviewMinutes.mean)}`,
  ].join('\n');
}

/** `--from 2026-11-01 --to 2026-11-08` (to is exclusive); the default is the last 7 days. */
export function parseRange(
  args: readonly string[],
  now: Date,
): { from: Date; to: Date } | { error: string } {
  const at = (flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
  const to = at('--to') ? new Date(`${at('--to')}T00:00:00`) : now;
  const from = at('--from')
    ? new Date(`${at('--from')}T00:00:00`)
    : new Date(to.getTime() - 7 * 86_400_000);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()))
    return { error: 'dates are YYYY-MM-DD' };
  if (from >= to) return { error: '--from must be before --to' };
  return { from, to };
}
