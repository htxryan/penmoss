import { describe, expect, it } from 'vitest';
import type { CheckRun } from '../src/checks.ts';
import { ciHistory, infraFailure, infraSignature, INFRA_SIGNATURES } from '../src/ci-failure.ts';

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
