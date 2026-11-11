/**
 * Which red CI is the runners' infrastructure rather than the branch (A1312). On 11 Nov 2026
 * GitHub's hosted runners couldn't resolve their apt mirror for hours, and PR #148's Site job
 * failed in "Install Chromium…" with `Temporary failure resolving 'azure.archive.ubuntu.com'`:
 * the factory gave it an agent repair round (a sandbox, the gate again, a push), and the agent
 * could only change the workflow, which the factory can't push. A failure like that gets its
 * failed jobs re-run instead, and only a failure that matches none of these gets an agent.
 *
 * Also what the ledger says about a PR's CI so far, so a restarted run doesn't start counting
 * again.
 */
import { runIdOf, type CheckRun } from './checks.ts';
import { issueOf, parseLedger } from './ui/model.ts';

/**
 * The log lines that mean the runner or a hosted service failed, not the code. A failed job
 * whose log carries one (and no failing test) is re-run, never given to the agent. Add one only
 * from a real job's log, and never a test's own failure: a flaky test is the code's (W11).
 */
export const INFRA_SIGNATURES: readonly {
  readonly name: string;
  readonly re: RegExp;
  /** Counts only when the log shows no test ran at all (a job cancelled mid-suite is a hang). */
  readonly withoutTests?: true;
}[] = [
  // DNS: the runner can't resolve a mirror, a registry or GitHub itself.
  { name: 'Temporary failure resolving', re: /Temporary failure resolving\b/ },
  { name: 'Could not resolve host', re: /Could not resolve host\b/i },
  { name: 'getaddrinfo EAI_AGAIN', re: /getaddrinfo EAI_AGAIN\b/ },
  // The runner went away under the job.
  {
    name: 'The runner has received a shutdown signal',
    re: /runner has received a shutdown signal/i,
  },
  { name: 'The operation was canceled', re: /The operation was cancell?ed/, withoutTests: true },
  // A package registry's server errors (HTTP 5xx).
  { name: 'ERR_PNPM_FETCH_5xx', re: /ERR_PNPM_FETCH_5\d\d\b/ },
  { name: 'npm ERR! 5xx', re: /npm ERR! (?:code E)?5\d\d\b/ },
  { name: '502 Bad Gateway', re: /\b502 Bad Gateway\b/i },
  { name: '503 Service Unavailable', re: /\b503 Service Unavailable\b/i },
];

/** A test failed: whatever else the log says, the code is in question. */
const TEST_FAILED =
  /^\s*(?:FAIL|✗|✘|×)\s|\b\d+ (?:failed|failing)\b|\bTests? failed\b|\bAssertionError\b/m;

/** A test ran at all (vitest, Playwright, Gradle). */
const TEST_RAN =
  /\b\d+ (?:passed|failed|skipped|flaky)\b|^\s*(?:✓|✔|PASS|FAIL)\s|\bTest Files\b|\bRunning \d+ tests?\b|> Task :\S*[tT]est\S*/m;

/** The infrastructure signature a failed job's log carries, or undefined when it is the code's. */
export function infraSignature(log: string): string | undefined {
  if (TEST_FAILED.test(log)) return undefined;
  const ran = TEST_RAN.test(log);
  return INFRA_SIGNATURES.find((s) => s.re.test(log) && !(s.withoutTests && ran))?.name;
}

export interface InfraFailure {
  /** The signatures the failed jobs' logs matched, in order, without repeats. */
  readonly signature: string;
  /** The failed jobs' names, by the Actions run that holds them. */
  readonly runs: ReadonlyMap<string, readonly string[]>;
}

/**
 * When every failed job's log carries an infrastructure signature and is in an Actions run that
 * can be re-run, the runs to re-run; otherwise undefined, and the failure is the branch's. One
 * real failure among them makes it the branch's: a re-run wouldn't fix that one.
 */
export function infraFailure(
  failed: readonly CheckRun[],
  logs: readonly string[],
): InfraFailure | undefined {
  if (failed.length === 0) return undefined;
  const signatures: string[] = [];
  const runs = new Map<string, string[]>();
  for (const [i, check] of failed.entries()) {
    const signature = infraSignature(logs[i] ?? '');
    const run = runIdOf(check);
    if (!signature || !run) return undefined;
    if (!signatures.includes(signature)) signatures.push(signature);
    runs.set(run, [...(runs.get(run) ?? []), check.name]);
  }
  return { signature: signatures.join('; '), runs };
}

/** The most re-runs one Actions run gets for an infrastructure failure before Ryan is asked. */
export const MAX_INFRA_RERUNS = 2;

export interface CiHistory {
  /**
   * Agent repair rounds already made for the PR (`ci-repaired`), whichever run made them: a
   * restarted run goes on counting rather than starting again at 0 (A1313).
   */
  readonly repairs: number;
  /** Re-runs already made for an infrastructure failure, by Actions run. */
  readonly reruns: ReadonlyMap<string, number>;
}

/** What the ledger (`runs.jsonl`) says the factory already did about `pr`'s CI for `issue`. */
export function ciHistory(ledger: string, issue: number, pr: string): CiHistory {
  let repairs = 0;
  const reruns = new Map<string, number>();
  for (const e of parseLedger(ledger)) {
    if (issueOf(e) !== issue) continue;
    // A repair logged before repairs named their PR (11 Nov 2026) counts for the card's PR.
    if (e.event === 'ci-repaired' && (e['pr'] === pr || e['pr'] === undefined)) repairs++;
    const run = e['actionsRun'];
    if (e.event === 'ci-rerun' && e['pr'] === pr && typeof run === 'string')
      reruns.set(run, (reruns.get(run) ?? 0) + 1);
  }
  return { repairs, reruns };
}
