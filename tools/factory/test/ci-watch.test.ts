import { describe, expect, it } from 'vitest';
import type { CheckRun } from '../src/checks.ts';
import type { RunJob } from '../src/merge.ts';
import { runImplement } from '../src/run.ts';
import { card, spec, green, red, queued, done, fake } from './run-fake.ts';

describe('CI after the PR opens (F6)', () => {
  it('hands a rebase conflict back to the agent, then goes on', async () => {
    const f = fake({ conflict: true });
    const outcome = await runImplement(f.deps, { item: card, spec, prompt: 'p' });
    expect(outcome.kind).toBe('in-review');
    expect(f.prompts[1]).toContain('stopped on conflicts in `docs/cli.md`');
    expect(f.prompts[1]).toContain('CONFLICT (content): docs/cli.md');
  });

  it('waits out a usage limit without using up a round (F13, R13)', async () => {
    const f = fake({ limited: 2 });
    const outcome = await runImplement(f.deps, { item: card, spec, prompt: 'p' });
    expect(outcome.kind).toBe('in-review');
    expect(f.prompts).toEqual(['p', 'p', 'p']);
    expect(f.events.filter((e) => e === 'usage-limited')).toHaveLength(2);
  });

  it('stops after the limit persists through every wait; executeRun then sets Blocked', async () => {
    const f = fake({ limited: 10 });
    await expect(runImplement(f.deps, { item: card, spec, prompt: 'p' })).rejects.toThrow(
      'usage limit 4 times in a row',
    );
  });

  it('sends a skipped test back to the agent before running the gate (F13)', async () => {
    const f = fake({ weakened: true });
    const outcome = await runImplement(f.deps, { item: card, spec, prompt: 'p' });
    expect(outcome.kind).toBe('in-review');
    expect(f.prompts[1]).toContain('The branch weakens tests');
    expect(f.prompts[1]).toContain('`apps/web/test/e2e/x.spec.ts` skips a test');
  });

  it('sends a branch that changes the workflows back to the agent before the push (A1314)', async () => {
    const f = fake({ workflowIn: (n) => n <= 2 });
    const outcome = await runImplement(f.deps, { item: card, spec, prompt: 'p' });
    expect(outcome.kind).toBe('in-review');
    expect(f.prompts[1]).toContain(
      "changes GitHub Actions' workflows (`.github/workflows/ci.yml`)",
    );
    // The refused round never reached `task lint` or the push; the fixed one did.
    expect(f.calls.indexOf('exec 2: task lint')).toBe(-1);
    expect(f.calls.filter((c) => c.startsWith('push'))).toHaveLength(1);
  });

  it("stops a CI repair round that changed the workflows before it is pushed, and tells the agent it can't (A1314)", async () => {
    // PEN-73: the repair round added a retry loop to ci.yml, and GitHub refused the factory's push.
    const f = fake({ ci: [[red]], workflowIn: (n) => n >= 4 });
    const outcome = await runImplement(f.deps, { item: card, spec, prompt: 'p' });
    expect(outcome).toEqual({ kind: 'blocked', reason: 'ci-red' });
    expect(f.prompts.at(-1)).toContain("can't push changes under `.github/workflows/`");
    expect(f.prompts.at(-1)).toContain("isn't this branch's to fix");
    expect(f.calls.filter((c) => c.startsWith('push'))).toHaveLength(1);
    expect(f.comments.at(-1)).toContain("changes GitHub Actions' workflows");
  });

  it('repairs a red check in the same PR, then moves to In review', async () => {
    const f = fake({ ci: [[red], [green]] });
    const outcome = await runImplement(f.deps, { item: card, spec, prompt: 'p' });
    expect(outcome.kind).toBe('in-review');
    expect(f.prompts.at(-1)).toContain('## CI failed (repair round 1)');
    expect(f.prompts.at(-1)).toContain('Error: lint failed at a.ts:1');
    expect(f.calls.filter((c) => c.startsWith('push'))).toHaveLength(2);
    expect(f.calls.at(-2)).toBe('status In review');
  });

  it('sets Blocked with the failing job and its log after rounds.ciRepair repairs', async () => {
    const f = fake({ ci: [[red], [red], [red]] });
    const outcome = await runImplement(f.deps, { item: card, spec, prompt: 'p' });
    expect(outcome).toEqual({ kind: 'blocked', reason: 'ci-red' });
    const last = f.comments.at(-1)!;
    expect(last).toContain('still red after 2 repair round(s)');
    expect(last).toContain(
      '[Check](https://github.com/htxryan/penmoss/actions/runs/77/job/1) (run 77)',
    );
    expect(last).toContain('Error: lint failed at a.ts:1');
    expect(f.calls).not.toContain('status In review');
    expect(f.calls.at(-1)).toBe('blocked');
  });

  it("sets Blocked with the failing job and its log when a repair round can't fix it", async () => {
    const f = fake({
      ci: [[red]],
      agentRounds: [done, { ...done, status: 'failed', summary: 'The failure is CI-only' }],
    });
    const outcome = await runImplement(f.deps, { item: card, spec, prompt: 'p' });
    expect(outcome).toEqual({ kind: 'blocked', reason: 'ci-red' });
    const last = f.comments.at(-1)!;
    expect(last).toContain("A CI repair round couldn't finish: The failure is CI-only");
    expect(last).toContain(
      '[Check](https://github.com/htxryan/penmoss/actions/runs/77/job/1) (run 77)',
    );
    expect(last).toContain('Error: lint failed at a.ts:1');
    expect(f.calls.at(-1)).toBe('blocked');
  });

  // PR #148's Site job on 11 Nov 2026, while the hosted runners couldn't resolve their apt mirror.
  const site: CheckRun = {
    name: 'Site',
    state: 'FAILURE',
    bucket: 'fail',
    link: 'https://github.com/htxryan/penmoss/actions/runs/88/job/5',
  };
  const aptLog = [
    'Run pnpm exec playwright install --with-deps chromium',
    'Installing dependencies...',
    "Err:1 http://azure.archive.ubuntu.com/ubuntu noble InRelease\n  Temporary failure resolving 'azure.archive.ubuntu.com'",
    'E: Failed to fetch http://azure.archive.ubuntu.com/ubuntu/dists/noble/InRelease',
    '##[error]Process completed with exit code 100.',
  ].join('\n');

  it("re-runs an infrastructure failure's jobs instead of a repair round, and says so once (A1312)", async () => {
    const f = fake({ ci: [[site], [site], [green]], logs: { Site: aptLog } });
    const outcome = await runImplement(f.deps, { item: card, spec, prompt: 'p' });
    expect(outcome.kind).toBe('in-review');
    expect(f.prompts).toEqual(['p']);
    expect(f.calls.filter((c) => c.startsWith('rerun'))).toEqual(['rerun 88', 'rerun 88']);
    expect(f.calls.filter((c) => c.startsWith('push'))).toHaveLength(1);
    expect(f.events.filter((e) => e === 'ci-rerun')).toHaveLength(2);
    const said = f.comments.filter((c) => c.startsWith('CI failed on an infrastructure problem'));
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('(Temporary failure resolving): Site');
  });

  it('sets Blocked, with no agent round, when the infrastructure still fails after two re-runs', async () => {
    const f = fake({ ci: [[site], [site], [site]], logs: { Site: aptLog } });
    const outcome = await runImplement(f.deps, { item: card, spec, prompt: 'p' });
    expect(outcome).toEqual({ kind: 'blocked', reason: 'ci-infra' });
    expect(f.prompts).toEqual(['p']);
    expect(f.calls.filter((c) => c.startsWith('rerun'))).toHaveLength(2);
    expect(f.comments.at(-1)).toContain("CI failed on the runners' infrastructure");
    expect(f.comments.at(-1)).toContain(
      '[Site](https://github.com/htxryan/penmoss/actions/runs/88',
    );
    expect(f.calls.at(-1)).toBe('blocked');
  });

  it("counts a run's earlier re-runs from the ledger, so a restart doesn't re-run it again", async () => {
    const pr = 'https://github.com/htxryan/penmoss/pull/900';
    const rerun = (at: string) =>
      JSON.stringify({ at, run: '42-old', event: 'ci-rerun', actionsRun: '88', pr });
    const f = fake({
      ci: [[site]],
      logs: { Site: aptLog },
      ledger: [rerun('2026-11-11T10:00:00Z'), rerun('2026-11-11T10:20:00Z')].join('\n'),
    });
    const outcome = await runImplement(f.deps, { item: card, spec, prompt: 'p' });
    expect(outcome).toEqual({ kind: 'blocked', reason: 'ci-infra' });
    expect(f.calls.filter((c) => c.startsWith('rerun'))).toEqual([]);
  });

  it('gives a repair round to a red run with one real failure beside an infrastructure one', async () => {
    const f = fake({ ci: [[site, red], [green]], logs: { Site: aptLog } });
    const outcome = await runImplement(f.deps, { item: card, spec, prompt: 'p' });
    expect(outcome.kind).toBe('in-review');
    expect(f.calls.filter((c) => c.startsWith('rerun'))).toEqual([]);
    expect(f.prompts.at(-1)).toContain('## CI failed (repair round 1)');
  });

  // PEN-117: the CLI's notebook test failed at random on the hosted runners, on a branch that
  // never touched the CLI, and the run went into a repair round.
  const cli: CheckRun = {
    name: 'Check',
    state: 'FAILURE',
    bucket: 'fail',
    link: 'https://github.com/htxryan/penmoss/actions/runs/91/job/7',
    workflow: 'CI',
  };
  const notebookLog = [
    'packages/cli test:  FAIL  test/notebook.test.ts > notebook > lists the notes in a folder',
    'packages/cli test: AssertionError: expected [] to have a length of 2',
    'packages/cli test:  Test Files  1 failed | 30 passed (31)',
    '##[error]Process completed with exit code 1.',
  ].join('\n');
  const mainPassed: RunJob[][] = [[{ name: 'Check', conclusion: 'success' }]];

  it('re-runs a failing test the branch never touched once, when main passes it, instead of a repair round (A1328)', async () => {
    const f = fake({ ci: [[cli], [green]], logs: { Check: notebookLog }, mainJobs: mainPassed });
    const outcome = await runImplement(f.deps, { item: card, spec, prompt: 'p' });
    expect(outcome.kind).toBe('in-review');
    expect(f.prompts).toEqual(['p']);
    expect(f.calls.filter((c) => c.startsWith('rerun'))).toEqual(['rerun 91']);
    expect(f.calls).toContain('main jobs CI');
    expect(f.calls.filter((c) => c.startsWith('push'))).toHaveLength(1);
    expect(f.details.filter(([e]) => e === 'ci-flake-rerun')).toEqual([
      [
        'ci-flake-rerun',
        {
          pr: 'https://github.com/htxryan/penmoss/pull/900',
          jobs: ['Check'],
          tests: ['test/notebook.test.ts'],
          actionsRuns: ['91'],
        },
      ],
    ]);
    const said = f.comments.filter((c) => c.startsWith("CI failed in tests this branch doesn't"));
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('(test/notebook.test.ts): Check');
    expect(said[0]).toContain('re-running the failed jobs once');
  });

  it('gives a repair round when the re-run fails again, and re-runs no more', async () => {
    const f = fake({
      ci: [[cli], [cli], [green]],
      logs: { Check: notebookLog },
      mainJobs: mainPassed,
    });
    const outcome = await runImplement(f.deps, { item: card, spec, prompt: 'p' });
    expect(outcome.kind).toBe('in-review');
    expect(f.calls.filter((c) => c.startsWith('rerun'))).toEqual(['rerun 91']);
    expect(f.prompts.at(-1)).toContain('## CI failed (repair round 1)');
    expect(f.details.find(([e]) => e === 'ci-repaired')?.[1]).toMatchObject({ round: 1 });
  });

  it.each([
    [
      'the branch changes what the test tests',
      // `docs/cli.md` is the fake branch's change: `cli.test.ts` shares its stem.
      { logs: { Check: ' FAIL  test/cli.test.ts > help\n1 failed' }, mainJobs: mainPassed },
    ],
    [
      'the job failed on main too',
      {
        logs: { Check: notebookLog },
        mainJobs: [
          [{ name: 'Check', conclusion: 'skipped' }],
          [{ name: 'Check', conclusion: 'failure' }],
        ],
      },
    ],
    ["main's runs never ran the job", { logs: { Check: notebookLog }, mainJobs: [[]] }],
    [
      'the log names no test',
      { logs: { Check: 'Error: lint failed at a.ts:1' }, mainJobs: mainPassed },
    ],
    ['the host reads no main runs', { logs: { Check: notebookLog } }],
  ])('gives a repair round, with no re-run, when %s', async (_why, overrides) => {
    const f = fake({ ci: [[cli], [green]], ...overrides });
    const outcome = await runImplement(f.deps, { item: card, spec, prompt: 'p' });
    expect(outcome.kind).toBe('in-review');
    expect(f.calls.filter((c) => c.startsWith('rerun'))).toEqual([]);
    expect(f.events).not.toContain('ci-flake-rerun');
    expect(f.prompts.at(-1)).toContain('## CI failed (repair round 1)');
  });

  it("re-runs a PR's flaky test only once across runs, counted from the ledger", async () => {
    const pr = 'https://github.com/htxryan/penmoss/pull/900';
    const f = fake({
      ci: [[cli], [green]],
      logs: { Check: notebookLog },
      mainJobs: mainPassed,
      ledger: JSON.stringify({ at: 'x', run: '42-old', event: 'ci-flake-rerun', pr }),
    });
    const outcome = await runImplement(f.deps, { item: card, spec, prompt: 'p' });
    expect(outcome.kind).toBe('in-review');
    expect(f.calls.filter((c) => c.startsWith('rerun'))).toEqual([]);
    expect(f.prompts.at(-1)).toContain('## CI failed (repair round 1)');
  });

  it('waits out a job no runner has taken, saying so once, without failing', async () => {
    const f = fake({ ci: [[queued], [queued], [queued], [green]] });
    const outcome = await runImplement(f.deps, { item: card, spec, prompt: 'p' });
    expect(outcome.kind).toBe('in-review');
    expect(
      f.comments.filter((c) => c.startsWith('CI is waiting for a free Mac runner')),
    ).toHaveLength(1);
  });
});
