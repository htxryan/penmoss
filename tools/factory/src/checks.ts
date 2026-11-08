/**
 * A PR's checks as the factory reads them (F6): green, red (with what failed), still running,
 * or stalled. A job that has waited longer than `timeouts.ciMinutes` without starting means no
 * runner picked it up (a Mac asleep or busy): that pauses the run, it never fails it.
 */
export interface CheckRun {
  readonly name: string;
  readonly state: string;
  /** gh's bucket: pass, fail, pending, skipping or cancel. */
  readonly bucket: string;
  readonly link: string;
  readonly startedAt?: string;
  readonly workflow?: string;
}

export type ChecksSummary =
  | { readonly kind: 'green' }
  | { readonly kind: 'red'; readonly failed: readonly CheckRun[] }
  | { readonly kind: 'pending'; readonly waiting: readonly CheckRun[] }
  | { readonly kind: 'stalled'; readonly queued: readonly CheckRun[] };

const NEVER = '0001-01-01T00:00:00Z';

export function summarizeChecks(
  checks: readonly CheckRun[],
  now: Date,
  ciMinutes: number,
  openedAt: Date,
): ChecksSummary {
  const failed = checks.filter((c) => c.bucket === 'fail' || c.bucket === 'cancel');
  if (failed.length > 0) return { kind: 'red', failed };
  const waiting = checks.filter((c) => c.bucket === 'pending');
  if (waiting.length === 0) {
    // No checks at all yet: GitHub hasn't queued the workflow.
    return checks.length === 0 ? { kind: 'pending', waiting: [] } : { kind: 'green' };
  }
  const minutes = (now.getTime() - openedAt.getTime()) / 60_000;
  const queued = waiting.filter(
    (c) => c.state === 'QUEUED' || c.state === 'PENDING' || !c.startedAt || c.startedAt === NEVER,
  );
  if (queued.length === waiting.length && minutes > ciMinutes) return { kind: 'stalled', queued };
  return { kind: 'pending', waiting };
}

/** The Actions run ID in a check's link, for `gh run view <id> --log-failed`. */
export function runIdOf(check: CheckRun): string | undefined {
  return /\/actions\/runs\/(\d+)/.exec(check.link)?.[1];
}
