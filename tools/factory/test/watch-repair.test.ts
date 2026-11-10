import { describe, expect, it } from 'vitest';
import type { CheckRun } from '../src/checks.ts';
import { failedLogs } from '../src/run.ts';
import { ciRepairText } from '../src/watch.ts';

const red: CheckRun = {
  name: 'Check',
  state: 'FAILURE',
  bucket: 'fail',
  link: 'https://github.com/htxryan/penmoss/actions/runs/77/job/1',
  startedAt: '2026-11-10T20:00:00Z',
};

describe('a repair round in review (F11)', () => {
  it("gives the agent each failed check's last log lines, not only its link (A1278)", async () => {
    const logs = await failedLogs(
      { failedLog: () => Promise.resolve('FAIL test/a.test.ts > b\nexpected 4 to be 3') },
      [red],
    );
    const text = ciRepairText('base', 'https://github.com/htxryan/penmoss/pull/113', [red], logs);
    expect(text).toContain(
      'these checks failed: Check (https://github.com/htxryan/penmoss/actions/runs/77/job/1)',
    );
    expect(text).toContain('### Check\n\n```\nFAIL test/a.test.ts > b\nexpected 4 to be 3\n```');
    expect(text).toContain('never by weakening or skipping tests');
  });
});
