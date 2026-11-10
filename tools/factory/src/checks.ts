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

/** The job ID in a check's link, for the job's own log, which GitHub has once the job ends. */
export function jobIdOf(check: CheckRun): string | undefined {
  return /\/actions\/runs\/\d+\/job\/(\d+)/.exec(check.link)?.[1];
}

/**
 * The lines of a failed job's log that say why (A1278): the 60 ending at its last `##[error]`
 * (the runner's own teardown comes after), without colour codes or timestamps.
 */
export function failedLines(log: string, count = 60): string {
  const lines = log
    // eslint-disable-next-line no-control-regex
    .replaceAll(/\u001b\[[0-9;?]*[A-Za-z]/g, '')
    .split('\n')
    .map((l) => l.replace(/^\uFEFF?\d{4}-\d\d-\d\dT[\d:.]+Z /, '').trimEnd());
  const last = lines.findLastIndex((l) => l.includes('##[error]'));
  const end = last === -1 ? lines.length : last + 1;
  return lines
    .slice(Math.max(0, end - count), end)
    .join('\n')
    .trim();
}

/** The Actions run ID in a check's link, for `gh run view <id> --log-failed`. */
export function runIdOf(check: CheckRun): string | undefined {
  return /\/actions\/runs\/(\d+)/.exec(check.link)?.[1];
}
