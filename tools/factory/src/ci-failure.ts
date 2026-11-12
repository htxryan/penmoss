/**
 * Which red CI is the runners' infrastructure rather than the branch (A1312). On 11 Nov 2026
 * GitHub's hosted runners couldn't resolve their apt mirror for hours, and PR #148's Site job
 * failed in "Install Chromium…" with `Temporary failure resolving 'azure.archive.ubuntu.com'`:
 * the factory gave it an agent repair round (a sandbox, the gate again, a push), and the agent
 * could only change the workflow, which the factory can't push. A failure like that gets its
 * failed jobs re-run instead, and only a failure that matches none of these gets an agent.
 *
 * A failing test the branch doesn't touch, in a job that passed on main's latest CI, gets one
 * re-run before a repair round (A1328): PEN-84's `tooltip-delay.spec.ts` and PEN-117's
 * `packages/cli/test/notebook.test.ts` failed at random on the hosted runners, and each sent a
 * run into a repair round on code its card never touched.
 *
 * Also what the ledger says about a PR's CI so far, so a restarted run doesn't start counting
 * again.
 */
import { runIdOf, type CheckRun } from './checks.ts';
import type { RunJob } from './merge.ts';
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

/** A test file name as vitest and Playwright print it: `test/a.test.ts`, `notes.spec.ts`. */
const TEST_FILE = String.raw`[\w@./-]*\.(?:test|spec)\.[cm]?[jt]sx?`;

/** The lines that name a failing test file, each capturing it. */
const FAILED_FILE: readonly RegExp[] = [
  // vitest's ` FAIL  test/a.test.ts > suite > name` (also behind pnpm's `packages/cli test:`).
  new RegExp(String.raw`(?:^|\s)FAIL\s+(?:\|[^|]*\|\s+)?(${TEST_FILE})`),
  // vitest's `❯ test/a.test.ts (5 tests | 1 failed)`.
  new RegExp(String.raw`❯\s+(${TEST_FILE})\s+\(\d+ tests? \| \d+ failed`),
  // Playwright's `✘ 3 [chromium] › notes.spec.ts:12:5 › saves` and `1) [chromium] › notes.spec.ts:12`.
  new RegExp(String.raw`(?:[✘×✗]\s+\d+|(?:^|\s)\d+\))\s+(?:\[[^\]]+\]\s+›\s+)?(${TEST_FILE})`),
  // Playwright's GitHub annotation: `::error file=apps/web/test/e2e/notes.spec.ts,…`.
  new RegExp(String.raw`::error file=(${TEST_FILE})`),
];

/** One line of Playwright's summary under `N failed`: `  [chromium] › notes.spec.ts:12:5 › …`. */
const SUMMARY_FILE = new RegExp(String.raw`^\s*(?:\[[^\]]+\]\s+›\s+)?(${TEST_FILE}):\d+`);

/** Gradle's `app.penmoss.TypingInstrumentedTest > types[CI(AVD) - 15] FAILED`: the class. */
const FAILED_CLASS = /(?:^|\s)(?:[a-z_]\w*\.)*([A-Z][\w]*)(?:\$[\w$]+)?\s+>\s+\S.*\bFAILED\b/;

/**
 * The tests a failed job's log names as failing: the test files vitest and Playwright print, and
 * the classes Gradle prints, without repeats. Empty when it names none, or none it can read.
 */
export function failedTests(log: string): string[] {
  const found: string[] = [];
  const add = (name: string | undefined) => {
    if (name && !found.includes(name)) found.push(name);
  };
  let summary = false;
  for (const line of log.split('\n')) {
    if (/^\s*\d+ failed\s*$/.test(line)) {
      summary = true;
      continue;
    }
    if (summary) {
      const file = SUMMARY_FILE.exec(line)?.[1];
      if (file) {
        add(file);
        continue;
      }
      summary = false;
    }
    for (const re of FAILED_FILE) add(re.exec(line)?.[1]);
    add(FAILED_CLASS.exec(line)?.[1]);
  }
  return found;
}

/** A path's file name up to its first dot: `notebook` for `test/notebook.test.ts`. */
const stem = (path: string) => path.slice(path.lastIndexOf('/') + 1).split('.')[0] ?? '';

/**
 * Whether the branch changed a test the log names, or what it tests: the same file (a log
 * prints it from its package or its test directory, so a path ending in it counts), or a file
 * with its stem (`notebook.ts` for `notebook.test.ts`; `TypingInstrumentedTest.kt` for that
 * class). Loose on purpose: a near match makes the failure the branch's, and it gets an agent.
 */
export function touchedBy(test: string, paths: readonly string[]): boolean {
  const name = test.replace(/^\.\//, '');
  return paths.some(
    (path) =>
      path === name ||
      path.endsWith(`/${name}`) ||
      name.endsWith(`/${path}`) ||
      (stem(name) !== '' && stem(path) === stem(name)),
  );
}

export interface FlakeCandidate {
  /** The failing tests the logs name, in order, without repeats. */
  readonly tests: readonly string[];
  /** The failed jobs' names, by the Actions run that holds them. */
  readonly runs: ReadonlyMap<string, readonly string[]>;
}

/**
 * When every failed job's log names the tests that failed and is in an Actions run that can be
 * re-run, those tests and runs: a re-run might pass, if the branch didn't touch them. Undefined
 * when any job's log names none (a build or lint error, or a log cut short): that is the
 * branch's, as before.
 */
export function flakeCandidate(
  failed: readonly CheckRun[],
  logs: readonly string[],
): FlakeCandidate | undefined {
  if (failed.length === 0) return undefined;
  const tests: string[] = [];
  const runs = new Map<string, string[]>();
  for (const [i, check] of failed.entries()) {
    const named = failedTests(logs[i] ?? '');
    const run = runIdOf(check);
    if (named.length === 0 || !run) return undefined;
    for (const t of named) if (!tests.includes(t)) tests.push(t);
    runs.set(run, [...(runs.get(run) ?? []), check.name]);
  }
  return { tests, runs };
}

/**
 * Whether `job` passed the last time main's CI ran it: `runs` holds the jobs of main's latest
 * completed runs of its workflow, newest first. A run that skipped or cancelled the job (ci.yml's
 * `pick` skips what a push can't affect) says nothing, so the next one is asked.
 */
export function passedOnMain(job: string, runs: readonly (readonly RunJob[])[]): boolean {
  for (const jobs of runs) {
    const conclusion = jobs.find((j) => j.name === job)?.conclusion;
    if (!conclusion || conclusion === 'skipped' || conclusion === 'cancelled') continue;
    return conclusion === 'success';
  }
  return false;
}

/** How many of main's latest completed runs `passedOnMain` reads for a workflow. */
export const MAIN_RUNS_READ = 5;

/** The most re-runs a PR gets for failing tests outside its branch, across runs (A1328). */
export const MAX_FLAKE_RERUNS = 1;

export interface CiHistory {
  /**
   * Agent repair rounds already made for the PR (`ci-repaired`), whichever run made them: a
   * restarted run goes on counting rather than starting again at 0 (A1313).
   */
  readonly repairs: number;
  /** Re-runs already made for an infrastructure failure, by Actions run. */
  readonly reruns: ReadonlyMap<string, number>;
  /** Re-runs already made for the PR for tests outside its branch (`ci-flake-rerun`). */
  readonly flakeReruns: number;
}

/** What the ledger (`runs.jsonl`) says the factory already did about `pr`'s CI for `issue`. */
export function ciHistory(ledger: string, issue: number, pr: string): CiHistory {
  let repairs = 0;
  let flakeReruns = 0;
  const reruns = new Map<string, number>();
  for (const e of parseLedger(ledger)) {
    if (issueOf(e) !== issue) continue;
    // A repair logged before repairs named their PR (11 Nov 2026) counts for the card's PR.
    if (e.event === 'ci-repaired' && (e['pr'] === pr || e['pr'] === undefined)) repairs++;
    const run = e['actionsRun'];
    if (e.event === 'ci-rerun' && e['pr'] === pr && typeof run === 'string')
      reruns.set(run, (reruns.get(run) ?? 0) + 1);
    if (e.event === 'ci-flake-rerun' && e['pr'] === pr) flakeReruns++;
  }
  return { repairs, reruns, flakeReruns };
}

/** How long a re-run waits for its Actions run to finish before asking anyway. */
export const RERUN_WAIT_MS = 45 * 60_000;

/**
 * Re-runs an Actions run's failed jobs once the run has finished. CI counts as red as soon as
 * one job fails, but GitHub refuses `gh run rerun --failed` while the run's other jobs are still
 * going, so an infra or flake re-run asked for then would fail and fall to a repair round.
 */
export async function rerunWhenDone(
  run: string,
  deps: {
    readonly status: (run: string) => Promise<string>;
    readonly rerun: (run: string) => Promise<void>;
    readonly sleep: (ms: number) => Promise<void>;
    readonly now?: () => number;
  },
  limitMs = RERUN_WAIT_MS,
): Promise<void> {
  const now = deps.now ?? Date.now;
  const until = now() + limitMs;
  while ((await deps.status(run)) !== 'completed' && now() < until) await deps.sleep(30_000);
  await deps.rerun(run);
}
