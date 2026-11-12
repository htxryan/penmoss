import { describe, expect, it } from 'vitest';
import type { CheckRun } from '../src/checks.ts';
import {
  ciHistory,
  failedTests,
  flakeCandidate,
  infraFailure,
  infraSignature,
  INFRA_SIGNATURES,
  passedOnMain,
  touchedBy,
  rerunWhenDone,
} from '../src/ci-failure.ts';

const check = (name: string, run: number): CheckRun => ({
  name,
  state: 'FAILURE',
  bucket: 'fail',
  link: `https://github.com/htxryan/penmoss/actions/runs/${run}/job/1`,
});

describe("which red CI is the runners' infrastructure (A1312)", () => {
  it.each([
    [
      "Err:1 http://azure.archive.ubuntu.com/ubuntu noble InRelease\n  Temporary failure resolving 'azure.archive.ubuntu.com'",
      'Temporary failure resolving',
    ],
    ['curl: (6) Could not resolve host: registry.npmjs.org', 'Could not resolve host'],
    ['fatal: unable to access ...: Could not resolve host: github.com', 'Could not resolve host'],
    ['Error: getaddrinfo EAI_AGAIN registry.npmjs.org', 'getaddrinfo EAI_AGAIN'],
    [
      '##[error]The runner has received a shutdown signal. This can happen when the runner service is stopped.',
      'The runner has received a shutdown signal',
    ],
    ['Run task e2e:install\n##[error]The operation was canceled.', 'The operation was canceled'],
    [
      ' ERR_PNPM_FETCH_503  GET https://registry.npmjs.org/vite: Service Unavailable - 503',
      'ERR_PNPM_FETCH_5xx',
    ],
    ['npm ERR! code E503\nnpm ERR! 503 Service Unavailable - GET https://…', 'npm ERR! 5xx'],
    ['npm ERR! 503 Service Unavailable', 'npm ERR! 5xx'],
    ['Received status code 502 from server: 502 Bad Gateway', '502 Bad Gateway'],
  ])('knows %j as %s', (log, name) => {
    expect(infraSignature(log)).toBe(name);
  });

  it('keeps every signature in one list, each with a name', () => {
    expect(INFRA_SIGNATURES.length).toBeGreaterThanOrEqual(8);
    for (const s of INFRA_SIGNATURES) expect(s.name).not.toBe('');
  });

  it("calls a failing test the code's, whatever else the log says", () => {
    expect(infraSignature('Error: lint failed at a.ts:1')).toBeUndefined();
    expect(
      infraSignature(
        ' FAIL  test/sync.test.ts > retries\nError: getaddrinfo EAI_AGAIN localhost\n Tests  1 failed | 40 passed',
      ),
    ).toBeUndefined();
    // A flaky e2e spec is not infrastructure, even when its page saw a 502.
    expect(
      infraSignature('  ✘  1 [chromium] › notes.spec.ts:12 › saves\n  502 Bad Gateway\n  1 failed'),
    ).toBeUndefined();
  });

  it('counts a cancelled job as infrastructure only when no test ran (a hang mid-suite is not)', () => {
    expect(
      infraSignature(
        ' ✓ test/a.test.ts (3 tests)\n ✓ test/b.test.ts\n##[error]The operation was canceled.',
      ),
    ).toBeUndefined();
    expect(infraSignature('Installing dependencies...\n##[error]The operation was canceled.')).toBe(
      'The operation was canceled',
    );
  });

  it('re-runs only when every failed job is infrastructure, grouped by Actions run', () => {
    const apt = "Temporary failure resolving 'azure.archive.ubuntu.com'";
    const failed = [check('Site', 88), check('E2E', 88), check('Android', 90)];
    const infra = infraFailure(failed, [apt, apt, 'Could not resolve host: dl.google.com']);
    expect(infra?.signature).toBe('Temporary failure resolving; Could not resolve host');
    expect([...(infra?.runs ?? [])]).toEqual([
      ['88', ['Site', 'E2E']],
      ['90', ['Android']],
    ]);
    expect(infraFailure(failed, [apt, 'expected 4 to be 3', apt])).toBeUndefined();
    // A check with no Actions run can't be re-run.
    expect(infraFailure([{ ...check('Vercel', 1), link: 'https://vercel.com/x' }], [apt])).toBe(
      undefined,
    );
  });

  it("counts a PR's repair rounds from the ledger, across runs (A1313)", () => {
    const pr = 'https://github.com/htxryan/penmoss/pull/148';
    const e = (run: string, extra: object) =>
      JSON.stringify({ at: '2026-11-11T10:00:00Z', run, event: 'ci-repaired', ...extra });
    const ledger = [
      e('73-a', { round: 1 }), // Logged before repairs named their PR.
      e('73-b', { round: 1, pr }),
      e('73-c', { pr, phase: 'review' }),
      e('73-d', { round: 1, pr: 'https://github.com/htxryan/penmoss/pull/1' }),
      e('63-e', { round: 1, pr }),
    ].join('\n');
    expect(ciHistory(ledger, 73, pr).repairs).toBe(3);
    expect(ciHistory('', 73, pr).repairs).toBe(0);
  });

  it("reads a PR's earlier re-runs from the ledger, by Actions run", () => {
    const pr = 'https://github.com/htxryan/penmoss/pull/148';
    const e = (run: string, event: string, extra: object) =>
      JSON.stringify({ at: '2026-11-11T10:00:00Z', run, event, ...extra });
    const ledger = [
      e('73-a', 'ci-rerun', { actionsRun: '88', pr }),
      e('73-b', 'ci-rerun', { actionsRun: '88', pr }),
      e('73-b', 'ci-rerun', { actionsRun: '91', pr }),
      // Another PR, another card.
      e('73-b', 'ci-rerun', { actionsRun: '88', pr: 'https://github.com/htxryan/penmoss/pull/1' }),
      e('63-c', 'ci-rerun', { actionsRun: '88', pr }),
      '{"torn',
    ].join('\n');
    expect([...ciHistory(ledger, 73, pr).reruns]).toEqual([
      ['88', 2],
      ['91', 1],
    ]);
  });
});

describe('which red CI is a flaky test outside the branch (A-NEW-1)', () => {
  it.each([
    [
      'vitest, behind pnpm -r (PEN-117)',
      'packages/cli test:  FAIL  test/notebook.test.ts > notebook > lists a folder\npackages/cli test: AssertionError: expected [] to have a length of 2',
      ['test/notebook.test.ts'],
    ],
    [
      "vitest's file line and a project's name",
      ' ❯ test/sync.test.ts (12 tests | 1 failed) 340ms\n FAIL  |web| test/unit/a.test.tsx > b',
      ['test/sync.test.ts', 'test/unit/a.test.tsx'],
    ],
    [
      "Playwright's header and summary under xvfb (PEN-84)",
      [
        '  1) [electron] › tooltip-delay.spec.ts:20:3 › Tooltip › waits before it shows ──',
        '    Error: expect(locator).toBeVisible() failed',
        '  2 failed',
        '    [electron] › tooltip-delay.spec.ts:20:3 › Tooltip › waits before it shows',
        '    [electron] › menus/app-menu.spec.ts:8:1 › opens',
        '  1 flaky',
        '    [electron] › other.spec.ts:4:1 › passes on retry',
        '  80 passed (3.1m)',
      ].join('\n'),
      ['tooltip-delay.spec.ts', 'menus/app-menu.spec.ts'],
    ],
    [
      "Playwright's list reporter and GitHub annotation",
      '  ✘  3 [chromium] › notes.spec.ts:12:5 › saves (5.1s)\n::error file=apps/web/test/e2e/notes.spec.ts,line=12::x',
      ['notes.spec.ts', 'apps/web/test/e2e/notes.spec.ts'],
    ],
    [
      "Gradle's instrumented test on the emulator",
      'app.penmoss.TypingInstrumentedTest > typesIntoTheEditor[CI(AVD) - 15] FAILED\n\tjava.lang.AssertionError',
      ['TypingInstrumentedTest'],
    ],
  ])('reads the failing tests from %s', (_what, log, tests) => {
    expect(failedTests(log)).toEqual(tests);
  });

  it('reads none from a log that names no failing test', () => {
    expect(
      failedTests('Error: lint failed at a.ts:1\n##[error]Process completed with exit code 1.'),
    ).toEqual([]);
    expect(failedTests(' ✓ test/a.test.ts (3 tests)\n src/a.ts(4,1): error TS2322')).toEqual([]);
    expect(failedTests('(the log was empty)')).toEqual([]);
    expect(failedTests('> Task :app:testDebugUnitTest FAILED')).toEqual([]);
  });

  it("counts a test as the branch's when it changed the file, or a file with its stem", () => {
    const paths = ['packages/cli/test/notebook.test.ts', 'apps/web/src/tooltip.ts'];
    expect(touchedBy('test/notebook.test.ts', paths)).toBe(true);
    expect(touchedBy('packages/cli/test/notebook.test.ts', paths)).toBe(true);
    expect(touchedBy('tooltip.spec.ts', paths)).toBe(true);
    expect(
      touchedBy('TypingInstrumentedTest', [
        'apps/android/app/src/androidTest/java/app/penmoss/TypingInstrumentedTest.kt',
      ]),
    ).toBe(true);
    expect(touchedBy('tooltip-delay.spec.ts', paths)).toBe(false);
    expect(touchedBy('TypingInstrumentedTest', paths)).toBe(false);
    expect(touchedBy('test/notebook.test.ts', ['docs/factory.md', '.prettierrc'])).toBe(false);
  });

  it('is a candidate only when every failed job names its tests and has an Actions run', () => {
    const vitest = ' FAIL  test/notebook.test.ts > lists';
    const failed = [check('Check', 91), check('Mac app', 92)];
    const candidate = flakeCandidate(failed, [
      vitest,
      '  1) [electron] › tooltip-delay.spec.ts:20:3 › waits',
    ]);
    expect(candidate?.tests).toEqual(['test/notebook.test.ts', 'tooltip-delay.spec.ts']);
    expect([...(candidate?.runs ?? [])]).toEqual([
      ['91', ['Check']],
      ['92', ['Mac app']],
    ]);
    expect(flakeCandidate(failed, [vitest, 'error TS2322'])).toBeUndefined();
    expect(
      flakeCandidate([{ ...check('Check', 1), link: 'https://vercel.com/x' }], [vitest]),
    ).toBeUndefined();
    expect(flakeCandidate([], [])).toBeUndefined();
  });

  it("asks main's newest run that ran the job whether it passed", () => {
    const run = (conclusion: string | null) => [
      { name: 'Check', conclusion },
      { name: 'Site', conclusion: 'failure' },
    ];
    expect(passedOnMain('Check', [run('success')])).toBe(true);
    expect(
      passedOnMain('Check', [run('skipped'), run('cancelled'), run(null), run('success')]),
    ).toBe(true);
    expect(passedOnMain('Check', [run('failure'), run('success')])).toBe(false);
    expect(passedOnMain('Site', [run('success')])).toBe(false);
    expect(passedOnMain('Android', [run('success')])).toBe(false);
    expect(passedOnMain('Check', [])).toBe(false);
  });

  it("counts a PR's flaky-test re-runs from the ledger, apart from its infrastructure ones", () => {
    const pr = 'https://github.com/htxryan/penmoss/pull/160';
    const e = (run: string, event: string, extra: object) =>
      JSON.stringify({ at: '2026-11-11T10:00:00Z', run, event, ...extra });
    const ledger = [
      e('117-a', 'ci-flake-rerun', { pr, jobs: ['Check'], tests: ['test/notebook.test.ts'] }),
      e('117-a', 'ci-rerun', { actionsRun: '91', pr }),
      e('117-b', 'ci-flake-rerun', { pr: 'https://github.com/htxryan/penmoss/pull/1' }),
      e('84-c', 'ci-flake-rerun', { pr }),
    ].join('\n');
    const history = ciHistory(ledger, 117, pr);
    expect(history.flakeReruns).toBe(1);
    expect([...history.reruns]).toEqual([['91', 1]]);
    expect(history.repairs).toBe(0);
    expect(ciHistory('', 117, pr).flakeReruns).toBe(0);
  });
});

describe('rerunWhenDone', () => {
  it('waits for the Actions run to finish before re-running its failed jobs', async () => {
    const said: string[] = [];
    const statuses = ['in_progress', 'in_progress', 'completed'];
    await rerunWhenDone('42', {
      status: (run) => {
        said.push(`status ${run}`);
        return Promise.resolve(statuses.shift() ?? 'completed');
      },
      rerun: (run) => {
        said.push(`rerun ${run}`);
        return Promise.resolve();
      },
      sleep: () => Promise.resolve(),
    });
    expect(said).toEqual(['status 42', 'status 42', 'status 42', 'rerun 42']);
  });

  it('asks anyway once its time is up', async () => {
    let t = 0;
    const said: string[] = [];
    await rerunWhenDone(
      '7',
      {
        status: () => Promise.resolve('in_progress'),
        rerun: (run) => {
          said.push(`rerun ${run}`);
          return Promise.resolve();
        },
        sleep: (ms) => {
          t += ms;
          return Promise.resolve();
        },
        now: () => t,
      },
      60_000,
    );
    expect(said).toEqual(['rerun 7']);
    expect(t).toBe(60_000);
  });
});
