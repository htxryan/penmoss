import { describe, expect, it } from 'vitest';
import type { Board } from '../src/board.ts';
import { parseIssueSpec } from '../src/labels.ts';
import type { CheckRun } from '../src/checks.ts';
import type { AgentResult } from '../src/result.ts';
import {
  branchName,
  gateCommand,
  runImplement,
  type RunDeps,
  type RunSandbox,
} from '../src/run.ts';
import { item, testConfig } from './helpers.ts';

const config = testConfig();
const card = item(42, { title: 'Fix the typo in docs/cli.md', labels: ['plan:skip'] });
const spec = (() => {
  const r = parseIssueSpec(card.labels, config);
  if (!r.ok) throw new Error(r.error);
  return r.spec;
})();
const board: Board = {
  projectId: 'P',
  status: { id: 'S', options: {} },
  blocked: { id: 'B', options: {} },
  items: [card],
};

const green: CheckRun = {
  name: 'Check',
  state: 'SUCCESS',
  bucket: 'pass',
  link: 'l',
  startedAt: '2026-11-07T12:00:00Z',
};
const red: CheckRun = {
  name: 'Check',
  state: 'FAILURE',
  bucket: 'fail',
  link: 'https://github.com/htxryan/penmoss/actions/runs/77/job/1',
};
const queued: CheckRun = {
  name: 'Android app',
  state: 'QUEUED',
  bucket: 'pending',
  link: 'l',
  startedAt: '0001-01-01T00:00:00Z',
};

const done: AgentResult = {
  status: 'done',
  summary: 'Fix a typo in the CLI docs',
  questions: [],
  platforms: {},
  tests: [],
  decisions: [],
  risks: [],
  replies: {},
};

interface Fake {
  deps: RunDeps;
  calls: string[];
  comments: string[];
  prompts: string[];
  events: string[];
}

function fake(overrides: {
  result?: AgentResult | { error: string };
  paths?: string[];
  commits?: number;
  dirty?: boolean;
  gateExit?: number;
  proofPassed?: boolean;
  agentRounds?: AgentResult[];
  ci?: CheckRun[][];
  conflict?: boolean;
  /** review.json per validation, in order (F19). */
  reviews?: string[];
  /** The first agent runs stop on a usage limit. */
  limited?: number;
  /** The branch's diff adds a test.skip in the first gate round. */
  weakened?: boolean;
}): Fake {
  const calls: string[] = [];
  const comments: string[] = [];
  let opened = 0;
  const sandbox = (): RunSandbox => {
    const n = ++opened;
    return {
      worktreePath: `/wt/${n}`,
      exec: (command) => {
        calls.push(`exec ${n}: ${command}`);
        if (command.startsWith('git rebase'))
          return Promise.resolve({
            exitCode: overrides.conflict && opened <= 2 ? 1 : 0,
            stdout: 'CONFLICT (content): docs/cli.md',
            stderr: '',
          });
        if (command.startsWith('git diff'))
          return Promise.resolve({
            exitCode: 0,
            stdout:
              overrides.weakened && opened <= 2
                ? "diff --git a/apps/web/test/e2e/x.spec.ts b/apps/web/test/e2e/x.spec.ts\n+test.skip('x', () => {})\n"
                : '',
            stderr: '',
          });
        if (command.startsWith('git status'))
          return Promise.resolve({
            exitCode: 0,
            stdout: overrides.dirty ? ' M x' : '',
            stderr: '',
          });
        return Promise.resolve({
          exitCode: overrides.gateExit ?? 0,
          stdout: 'lint output',
          stderr: '',
        });
      },
      close: () => {
        calls.push(`close ${n}`);
        return Promise.resolve();
      },
    };
  };
  const result = overrides.result ?? done;
  let limitedLeft = overrides.limited ?? 0;
  const reviews = [...(overrides.reviews ?? [])];
  const events: string[] = [];
  const rounds = [...(overrides.agentRounds ?? [])];
  const prompts: string[] = [];
  const ciRounds = [...(overrides.ci ?? [])];
  let clock = Date.parse('2026-11-07T12:00:00Z');
  const deps: RunDeps = {
    config,
    slot: config.slots[0]!,
    runId: 'r1',
    board,
    comment: (issue, body) => {
      comments.push(body);
      calls.push(`comment #${issue}`);
      return Promise.resolve();
    },
    setStatus: (_item, status) => {
      calls.push(`status ${status}`);
      return Promise.resolve();
    },
    setBlocked: () => {
      calls.push('blocked');
      return Promise.resolve();
    },
    openSandbox: (branch) => {
      calls.push(`open ${branch}`);
      return Promise.resolve(sandbox());
    },
    runAgent: (_sandbox, prompt) => {
      calls.push('agent');
      prompts.push(prompt);
      return Promise.resolve(
        limitedLeft-- > 0
          ? { output: 'Claude AI usage limit reached|1700000000' }
          : { output: 'done' },
      );
    },
    readResult: () => {
      const next = rounds.shift() ?? result;
      return Promise.resolve(
        'error' in next ? { ok: false, error: next.error } : { ok: true, result: next },
      );
    },
    diff: () =>
      Promise.resolve({
        paths: overrides.paths ?? ['docs/cli.md'],
        commits: overrides.commits ?? 1,
      }),
    heavy: (_label, fn) => fn(),
    stageMockups: () => {
      calls.push('mockups');
      return Promise.resolve();
    },
    readReview: () => Promise.resolve(reviews.shift() ?? null),
    collectFidelity: (_sandbox, rows) => Promise.resolve([...rows]),
    recordProof: (_sandbox, platform, specs) => {
      calls.push(`proof ${platform}: ${specs.join(' ')}`);
      return Promise.resolve(
        (overrides.proofPassed ?? true)
          ? [
              {
                platform,
                title: 'shows it',
                status: 'passed',
                phase: 'after',
                source: 'harness',
                video: '/v.webm',
                screenshot: '/s.png',
              },
            ]
          : [],
      );
    },
    prepareProof: (items) =>
      Promise.resolve({
        ok: true,
        proof: items.map((i) => ({
          label: `${i.platform}: ${i.title}`,
          phase: i.phase,
          source: i.source,
          image: 'web-1.png',
          video: 'web-1.mp4',
        })),
      }),
    fetchMain: () => Promise.resolve(),
    numberDecisions: () => Promise.resolve({}),
    push: (branch) => {
      calls.push(`push ${branch}`);
      return Promise.resolve();
    },
    checks: () => {
      calls.push('checks');
      return Promise.resolve(ciRounds.shift() ?? [green]);
    },
    failedLog: () => Promise.resolve('Error: lint failed at a.ts:1'),
    notify: (title) => {
      calls.push(`notify ${title}`);
      return Promise.resolve();
    },
    sleep: () => Promise.resolve(),
    now: () => new Date((clock += 30 * 60_000)),
    openPr: ({ body }) => {
      calls.push('pr');
      comments.push(body);
      return Promise.resolve('https://github.com/htxryan/penmoss/pull/900');
    },
    log: (event) => void events.push(event),
  };
  return { deps, calls, comments, prompts, events };
}

describe('runImplement', () => {
  it('takes a docs-only plan:skip issue from Ready to In review', async () => {
    const f = fake({});
    const outcome = await runImplement(f.deps, { item: card, spec, prompt: 'p' });
    expect(outcome).toEqual({
      kind: 'in-review',
      pr: 'https://github.com/htxryan/penmoss/pull/900',
      scope: { kind: 'docs-only', platforms: [] },
    });
    expect(f.calls).toEqual([
      'comment #42',
      'status In progress',
      'open factory/42-fix-the-typo-in-docs-cli',
      'agent',
      'close 1',
      'open factory/42-fix-the-typo-in-docs-cli',
      'exec 2: git status --porcelain --untracked-files=no',
      'exec 2: git rebase origin/main',
      'exec 2: git diff origin/main...HEAD',
      'exec 2: task lint',
      'close 2',
      'push factory/42-fix-the-typo-in-docs-cli',
      'pr',
      'checks',
      'comment #42',
      'status In review',
      'notify Penmoss #42 is ready for review',
    ]);
    // The claim carries the marker; the PR says Part of, not Closes (R20).
    expect(f.comments[0]).toContain(
      '<!-- penmoss-factory run=r1 agent=claude model=opus phase=implement event=claim -->',
    );
    expect(f.comments[1]).toMatch(/^Part of #42\./);
    expect(f.comments[1]).not.toMatch(/Closes|Fixes|Resolves/);
  });

  const webDone: AgentResult = {
    ...done,
    platforms: {
      web: { inScope: true, proofSpecs: ['comments.spec.ts'] },
      mac: { inScope: true, proofSpecs: ['app.spec.ts'] },
      android: { inScope: true, proofSpecs: ['app.penmoss.EditorScreenTest'] },
    },
  };

  it('runs task check for product changes, then records the web proof specs', async () => {
    const f = fake({ paths: ['apps/web/src/a.ts'], result: webDone });
    const outcome = await runImplement(f.deps, { item: card, spec, prompt: 'p' });
    expect(outcome.kind).toBe('in-review');
    expect(f.calls).toContain('exec 2: task check');
    expect(f.calls).toContain('proof web: comments.spec.ts');
    expect(f.comments[1]).toContain('![](./web-1.mp4)');
    expect(f.calls).toContain('proof mac: app.spec.ts');
    expect(f.calls).toContain('proof android: app.penmoss.EditorScreenTest');
    expect(f.comments[1]).not.toContain('No recorded proof yet');
  });

  it('sends a run that names no web proof spec back to the agent with the reason (R9)', async () => {
    const f = fake({ paths: ['apps/web/src/a.ts'], agentRounds: [done, webDone] });
    const outcome = await runImplement(f.deps, { item: card, spec, prompt: 'p' });
    expect(outcome.kind).toBe('in-review');
    expect(f.calls.filter((c) => c === 'agent')).toHaveLength(2);
    expect(f.prompts[1]).toContain("The gate's feedback (round 1)");
    expect(f.prompts[1]).toContain('names no proof spec for web');
  });

  it('fails the gate when the proof specs do not pass under recording', async () => {
    const f = fake({ paths: ['apps/web/src/a.ts'], result: webDone, proofPassed: false });
    const outcome = await runImplement(f.deps, { item: card, spec, prompt: 'p' });
    expect(outcome).toEqual({ kind: 'blocked', reason: 'gate-failed' });
    expect(f.comments.at(-1)).toContain("proof specs for web, mac, android didn't pass");
  });

  const review = (verdict: string, note = '') =>
    JSON.stringify({
      rows: [
        {
          criterion: 'AC1 the badge uses the accent colour',
          verdict,
          note,
          mockup: 'ac1-mockup.png',
          screenshot: 'ac1.png',
        },
      ],
    });

  it('validates a planned web change, sends a wrong colour back, and shows the fidelity table (F19)', async () => {
    const f = fake({
      paths: ['apps/web/src/a.ts'],
      result: webDone,
      reviews: [
        review('mismatch', 'The badge is red; the mockup accent is green'),
        review('match'),
      ],
    });
    const outcome = await runImplement(f.deps, { item: card, spec, prompt: 'p', plan: 'AC1 …' });
    expect(outcome.kind).toBe('in-review');
    expect(f.prompts[3]).toContain('**AC1 the badge uses the accent colour**: The badge is red');
    // Build, walkthrough, review; then the fix, walkthrough, review.
    expect(f.prompts).toHaveLength(6);
    expect(f.prompts[1]).toMatch(/^You are validating/);
    expect(f.prompts[2]).toMatch(/^You are an independent reviewer/);
    expect(f.comments[1]).toContain('## Fidelity');
    expect(f.comments[1]).toContain(
      '| ✅ Match | ![mockup](./ac1-mockup.png) | ![screenshot](./ac1.png) |',
    );
  });

  it("puts what isn't fixed after the last round in the PR as a deviation (F19)", async () => {
    const red = review('mismatch', 'Still red');
    const f = fake({ paths: ['apps/web/src/a.ts'], result: webDone, reviews: [red, red, red] });
    const outcome = await runImplement(f.deps, { item: card, spec, prompt: 'p', plan: 'AC1 …' });
    expect(outcome.kind).toBe('in-review');
    expect(f.comments[1]).toContain('⚠️ Deviation');
    expect(f.comments[1]).toContain('Not fixed in the rounds allowed: Still red');
  });

  it('skips validation without an agreed plan (plan:skip)', async () => {
    const f = fake({ paths: ['apps/web/src/a.ts'], result: webDone });
    await runImplement(f.deps, { item: card, spec, prompt: 'p' });
    expect(f.calls).not.toContain('mockups');
  });

  it('posts the questions and sets Blocked on needs-info, without pushing', async () => {
    const f = fake({
      result: { ...done, status: 'needs-info', questions: ['Which file? Proposed: docs/cli.md'] },
    });
    const outcome = await runImplement(f.deps, { item: card, spec, prompt: 'p' });
    expect(outcome).toEqual({ kind: 'blocked', reason: 'needs-info' });
    expect(f.calls.slice(-2)).toEqual(['comment #42', 'blocked']);
    expect(f.calls.some((c) => c.startsWith('push'))).toBe(false);
    expect(f.comments.at(-1)).toContain('1. Which file? Proposed: docs/cli.md');
  });

  it('gives the agent rounds.gateFix more tries, then blocks without pushing', async () => {
    const f = fake({ paths: ['.github/x.yml'], gateExit: 1 });
    const outcome = await runImplement(f.deps, { item: card, spec, prompt: 'p' });
    expect(outcome).toEqual({ kind: 'blocked', reason: 'gate-failed' });
    expect(f.calls.filter((c) => c === 'agent')).toHaveLength(config.rounds.gateFix + 1);
    expect(f.comments.at(-1)).toContain('after 3 round(s)');
    expect(f.calls.some((c) => c.startsWith('push'))).toBe(false);
    expect(f.calls.at(-1)).toBe('blocked');
  });

  it('blocks when the agent leaves uncommitted changes', async () => {
    const f = fake({ dirty: true });
    expect(await runImplement(f.deps, { item: card, spec, prompt: 'p' })).toEqual({
      kind: 'blocked',
      reason: 'gate-failed',
    });
  });

  it('blocks when the agent commits nothing or writes no result', async () => {
    expect(
      await runImplement(fake({ commits: 0 }).deps, { item: card, spec, prompt: 'p' }),
    ).toEqual({ kind: 'blocked', reason: 'no-commits' });
    const f = fake({ result: { error: 'the agent wrote no .factory/result.json' } });
    expect(await runImplement(f.deps, { item: card, spec, prompt: 'p' })).toEqual({
      kind: 'blocked',
      reason: 'the agent wrote no .factory/result.json',
    });
    expect(f.calls).toContain('close 1');
  });
});

describe('CI after the PR opens (F6)', () => {
  it('hands a rebase conflict back to the agent, then goes on', async () => {
    const f = fake({ conflict: true });
    const outcome = await runImplement(f.deps, { item: card, spec, prompt: 'p' });
    expect(outcome.kind).toBe('in-review');
    expect(f.calls).toContain('exec 2: git rebase --abort');
    expect(f.prompts[1]).toContain('stopped on conflicts');
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

  it('waits out a job no runner has taken, saying so once, without failing', async () => {
    const f = fake({ ci: [[queued], [queued], [queued], [green]] });
    const outcome = await runImplement(f.deps, { item: card, spec, prompt: 'p' });
    expect(outcome.kind).toBe('in-review');
    expect(
      f.comments.filter((c) => c.startsWith('CI is waiting for a free Mac runner')),
    ).toHaveLength(1);
  });
});

describe('helpers', () => {
  it('names the branch from the issue', () => {
    expect(
      branchName(config, item(7, { title: '  Ünïcode & "quotes": the Settings → Status page!' })),
    ).toBe('factory/7-n-code-quotes-the-settings-status');
    expect(branchName(config, item(8, { title: '!!!' }))).toBe('factory/8-issue');
  });
  it('gates docs with lint and everything else with task check', () => {
    expect(gateCommand({ kind: 'docs-only', platforms: [] })).toBe('task lint');
    expect(gateCommand({ kind: 'ci-only', platforms: [] })).toBe('task check');
  });
});
