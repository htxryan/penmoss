import { describe, expect, it } from 'vitest';
import type { AgentResult } from '../src/result.ts';
import type { IssueComment } from '../src/issue.ts';
import { repliesSection } from '../src/agent-round.ts';
import { runImplement } from '../src/run.ts';
import type { RunDeps } from '../src/run-deps.ts';
import { BlockedByRyan, guardEffects, RUN_GUARDED, RUN_STEPS } from '../src/guard.ts';
import { config, card, spec, red, done, type Fake, fake } from './run-fake.ts';

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
      'rebase /wt/2',
      'exec 2: pnpm install --frozen-lockfile --prefer-offline',
      'exec 2: git diff origin/main...HEAD',
      'exec 2: task lint',
      // What the gate numbered on the branch, for the PR body.
      'exec 2: git log --reverse --format=%s origin/main..HEAD',
      'close 2',
      // main hasn't moved since the gate's rebase, so the first push goes as it is.
      'behind? factory/42-fix-the-typo-in-docs-cli',
      'push factory/42-fix-the-typo-in-docs-cli',
      'pr',
      'checks',
      // main hasn't moved while CI ran, so there is nothing to rebase before review.
      'behind? factory/42-fix-the-typo-in-docs-cli',
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

  it("titles the PR with the branch's first commit subject, without the card's id", async () => {
    const f = fake({});
    const titles: string[] = [];
    const linearCard = { ...card, key: 'PEN-42' };
    const deps: RunDeps = {
      ...f.deps,
      diff: () =>
        Promise.resolve({
          paths: ['docs/cli.md'],
          commits: 2,
          subject: 'Docs: fix the typo in the CLI page (PEN-42)',
        }),
      openPr: (pr) => {
        titles.push(pr.title);
        return f.deps.openPr(pr);
      },
    };
    await runImplement(deps, {
      item: linearCard,
      spec,
      prompt: 'p',
    });
    expect(titles).toEqual(['Docs: fix the typo in the CLI page']);
    // The body still links the card, without closing it.
    expect(f.comments[1]).toMatch(/^Part of PEN-42\./);
  });

  it('stops before the gate when Blocked is set while the agent works (R23)', async () => {
    // PEN-75: Ryan set Blocked as the agent finished, and the gate ran on regardless.
    const f = fake({});
    let blocked = false;
    const deps: RunDeps = {
      ...f.deps,
      runAgent: async (sandbox, prompt) => {
        const ran = await f.deps.runAgent(sandbox, prompt);
        blocked = true;
        return ran;
      },
    };
    const guarded = guardEffects(deps, RUN_GUARDED, 42, () => Promise.resolve(blocked), RUN_STEPS);
    const stopped = runImplement(guarded, { item: card, spec, prompt: 'p' });
    await expect(stopped).rejects.toBeInstanceOf(BlockedByRyan);
    await expect(stopped).rejects.toMatchObject({ step: 'the gate' });
    expect(f.calls).toEqual([
      'comment #42',
      'status In progress',
      'open factory/42-fix-the-typo-in-docs-cli',
      'agent',
      'close 1',
    ]);
  });

  it.each([
    ['a gate-fix round', 'gate-fix round 1', true],
    ['the push', 'the push', false],
  ])('stops before %s when Blocked is set during the gate', async (_what, step, gateFails) => {
    // Blocked comes on while the gate's command runs; that command finishes, nothing after it.
    let blocked = false;
    const f = fake({});
    const deps: RunDeps = {
      ...f.deps,
      heavy: async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
        const r = await fn();
        if (!label.startsWith('factory gate')) return r;
        blocked = true;
        return gateFails ? { ...r, exitCode: 1 } : r;
      },
    };
    const guarded = guardEffects(deps, RUN_GUARDED, 42, () => Promise.resolve(blocked), RUN_STEPS);
    await expect(runImplement(guarded, { item: card, spec, prompt: 'p' })).rejects.toMatchObject({
      step,
    });
    expect(f.calls).not.toContain('push factory/42-fix-the-typo-in-docs-cli');
  });

  it("goes on from the gate when a recovered run's agent had already finished (R12)", async () => {
    // PEN-75: the restarted run ran the agent again at round 0 over finished, committed work.
    const f = fake({});
    const outcome = await runImplement(f.deps, {
      item: card,
      spec,
      prompt: 'p',
      recovered: true,
      resume: { run: '42-old', result: done },
    });
    expect(outcome.kind).toBe('in-review');
    expect(f.calls).not.toContain('agent');
    expect(f.calls.slice(0, 4)).toEqual([
      'comment #42',
      'status In progress',
      'open factory/42-fix-the-typo-in-docs-cli',
      'exec 1: git status --porcelain --untracked-files=no',
    ]);
    expect(f.comments[0]).toMatch(/^Restarted: this run stopped after its agent had finished/);
    expect(f.events.slice(0, 2)).toEqual(['claimed', 'agent-finished']);
  });

  it('goes back to waiting on CI when the PR is as the factory pushed it (A1298)', async () => {
    // PEN-71: CI went red, Ryan re-ran the job green and cleared Blocked; the restart gated,
    // proved and validated the same commit again, about 30 minutes for nothing.
    const f = fake({});
    const pr = 'https://github.com/htxryan/penmoss/pull/7';
    const outcome = await runImplement(
      { ...f.deps, pushedPr: () => Promise.resolve(pr) },
      { item: card, spec, prompt: 'p', recovered: true, resume: { run: '42-old', result: done } },
    );
    expect(outcome).toMatchObject({ kind: 'in-review', pr });
    for (const step of [
      'agent',
      'open factory/42-fix-the-typo-in-docs-cli',
      'push factory/42-fix-the-typo-in-docs-cli',
      'pr',
    ])
      expect(f.calls).not.toContain(step);
    expect(f.comments[0]).toMatch(/^Restarted: .*pull\/7 is as the factory last pushed it/);
    expect(f.events).toEqual(['claimed', 'agent-finished', 'resumed-at-ci', 'in-review']);
  });

  it("counts the PR's earlier repair rounds, so clearing Blocked gives the agent none more (A1313)", async () => {
    // Each time Ryan cleared Blocked on a ci-red card, its restarted watchCi began again at 0.
    const pr = 'https://github.com/htxryan/penmoss/pull/7';
    const repaired = (round: number) =>
      JSON.stringify({ at: 'x', run: '42-old', event: 'ci-repaired', round, pr });
    const f = fake({ ci: [[red]], ledger: [repaired(1), repaired(2)].join('\n') });
    const outcome = await runImplement(
      { ...f.deps, pushedPr: () => Promise.resolve(pr) },
      { item: card, spec, prompt: 'p', recovered: true, resume: { run: '42-old', result: done } },
    );
    expect(outcome).toEqual({ kind: 'blocked', reason: 'ci-red' });
    expect(f.prompts).toEqual([]);
    expect(f.comments.at(-1)).toContain('CI is still red after 2 repair round(s)');
  });

  it('goes on counting from the ledger, one repair left', async () => {
    const pr = 'https://github.com/htxryan/penmoss/pull/7';
    const repaired = JSON.stringify({ at: 'x', run: '42-old', event: 'ci-repaired', round: 1, pr });
    const f = fake({ ci: [[red], [red]], ledger: repaired });
    const outcome = await runImplement(
      { ...f.deps, pushedPr: () => Promise.resolve(pr) },
      { item: card, spec, prompt: 'p', recovered: true, resume: { run: '42-old', result: done } },
    );
    expect(outcome).toEqual({ kind: 'blocked', reason: 'ci-red' });
    expect(f.prompts).toHaveLength(1);
    expect(f.prompts[0]).toContain('## CI failed (repair round 2)');
  });

  it('gates again when the PR is not as the factory pushed it', async () => {
    const f = fake({});
    await runImplement(
      { ...f.deps, pushedPr: () => Promise.resolve(undefined) },
      { item: card, spec, prompt: 'p', recovered: true, resume: { run: '42-old', result: done } },
    );
    expect(f.calls).toContain('push factory/42-fix-the-typo-in-docs-cli');
    expect(f.comments[0]).toMatch(/^Restarted: this run stopped after its agent had finished/);
  });

  it('keeps a finished result when a step after the agent fails, so a restart resumes (A1266)', async () => {
    // PEN-72: OpenCode committed and wrote its result, then Sandcastle's session capture failed.
    const f = fake({});
    const deps: RunDeps = {
      ...f.deps,
      runAgent: () => Promise.reject(new Error('Session capture failed')),
    };
    await expect(runImplement(deps, { item: card, spec, prompt: 'p' })).rejects.toThrow(
      'Session capture failed',
    );
    expect(f.events).toEqual(['claimed', 'agent-started', 'agent-finished']);
  });
  it('records no finished round when the agent fails without a done result', async () => {
    const f = fake({ result: { error: 'no .factory/result.json' } });
    const deps: RunDeps = { ...f.deps, runAgent: () => Promise.reject(new Error('crashed')) };
    await expect(runImplement(deps, { item: card, spec, prompt: 'p' })).rejects.toThrow('crashed');
    expect(f.events).not.toContain('agent-finished');
  });

  it("opens no PR when the branch's commits change nothing against main (A1268)", async () => {
    // PEN-80: the gate refused a skip, the agent took it back out, and an empty PR opened.
    const f = fake({ paths: [], commits: 2 });
    const outcome = await runImplement(f.deps, { item: card, spec, prompt: 'p' });
    expect(outcome).toMatchObject({ kind: 'blocked', reason: 'no-changes' });
    expect(f.calls).not.toContain('pr');
    expect(f.comments.at(-1)).toMatch(/change nothing against main, so there is no PR to open/);
  });

  it('runs the agent with Ryan’s replies when he commented after the run stopped', async () => {
    // A recovered run went on from the gate with the old result while Ryan's reply waited.
    const reply: IssueComment = {
      author: 'ryan',
      authorName: 'Ryan',
      body: 'Use the accent colour, not blue.',
      createdAt: '2026-11-12T09:00:00.000Z',
    };
    const f = fake({});
    const outcome = await runImplement(f.deps, {
      item: card,
      spec,
      prompt: 'p',
      recovered: true,
      replies: [reply],
    });
    expect(outcome.kind).toBe('in-review');
    expect(f.calls.slice(0, 5)).toEqual([
      'comment #42',
      'status In progress',
      'open factory/42-fix-the-typo-in-docs-cli',
      'agent',
      'close 1',
    ]);
    expect(f.comments[0]).toMatch(/^Restarted: you commented after this run stopped/);
    expect(f.prompts[0]).toBe(
      `p\n\n${repliesSection('factory/42-fix-the-typo-in-docs-cli', [reply])}`,
    );
    expect(f.prompts[0]).toContain(
      '**Ryan** (2026-11-12T09:00:00.000Z):\nUse the accent colour, not blue.',
    );
  });

  it('gives each round Ryan’s card comments newer than the prompt', async () => {
    const said: IssueComment = {
      author: 'ryan',
      body: 'Also keep the old link working.',
      createdAt: '2026-11-12T09:30:00.000Z',
    };
    // The first round sees nothing new; Ryan comments while the gate runs; the gate fails.
    const f = fake({ gateExit: 1, owner: [[], [said]] });
    await runImplement(f.deps, { item: card, spec, prompt: 'p' });
    expect(f.prompts[0]).toBe('p');
    expect(f.prompts[1]).toContain("## The gate's feedback (round 1)");
    expect(f.prompts[1]).toMatch(
      /## Ryan's new comments on the issue\n\n.*\n\n\*\*ryan\*\* \(2026-11-12T09:30:00.000Z\):\nAlso keep the old link working\.$/,
    );
    expect(f.details).toContainEqual(['owner-comments', { round: 1, comments: 1 }]);
  });

  it('runs the agent again when the branch has none of the finished round’s commits', async () => {
    const f = fake({ commits: 0 });
    await runImplement(f.deps, {
      item: card,
      spec,
      prompt: 'p',
      recovered: true,
      resume: { run: '42-old', result: done },
    });
    expect(f.calls).toContain('agent');
    expect(f.comments[0]).toMatch(/^Restarted: this run stopped before it finished/);
  });

  it('says on the issue why a run restarts after the daemon stopped mid-run (R12)', async () => {
    const f = fake({});
    await runImplement(f.deps, { item: card, spec, prompt: 'p', recovered: true });
    expect(f.comments[0]).toMatch(/^Restarted: this run stopped before it finished/);
    expect(f.comments[0]).toContain('event=claim');
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
    expect(f.comments[1]).toContain('[▶ Watch the recording (MP4)](./web-1.mp4)');
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

  it("gives the agent each failed proof's own output (A1252)", async () => {
    const f = fake({ paths: ['apps/web/src/a.ts'], result: webDone, proofPassed: false });
    const logs: Record<string, string> = {
      android: 'BUILD FAILED\nerror: emulator-5582 did not come up\nexit 1',
    };
    const deps = { ...f.deps, proofLog: (p: string) => logs[p] };
    await runImplement(deps, { item: card, spec, prompt: 'p' });
    expect(f.prompts[1]).toContain("The android proof's output:");
    expect(f.prompts[1]).toContain('emulator-5582 did not come up');
    expect(f.prompts[1]).not.toContain("The web proof's output:");
    // And where to see the proof's last screenshot, which the Mac proof's VM is the only way to (A1291).
    expect(f.prompts[1]).toContain('.factory/last-proof/');
    // And what a failing test left there, by the names the host gives the files (A1342).
    expect(f.prompts[1]).toContain('`<platform>-failures.md`');
    expect(f.prompts[1]).toContain('`<platform>-<n>-error-context.md`');
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
    // The ledger says validation sent it back, naming the criterion, not that the gate failed.
    expect(f.events).toContain('validation-mismatch');
    expect(f.events).not.toContain('gate-failed');
    expect(f.details).toContainEqual(['validation-mismatch', { round: 0, criteria: ['AC1'] }]);
    expect(f.prompts[3]).toContain('**AC1 the badge uses the accent colour**: The badge is red');
    // Build, walkthrough, review; then the fix, walkthrough, review.
    expect(f.prompts).toHaveLength(6);
    expect(f.prompts[1]).toMatch(/^You are validating/);
    expect(f.prompts[2]).toMatch(/^You are an independent reviewer/);
    // Each validation's files are kept in the run folder before the review is read (A1256).
    const kept = f.calls.filter((c) => c === 'keep validation' || c === 'read review');
    expect(kept).toEqual(['keep validation', 'read review', 'keep validation', 'read review']);
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

  it("writes the PR body with the gate's decision numbers and the factory's proof, not the agent's stale words", async () => {
    // PEN-73's PR #148 said "decision A-NEW-1 amends A1220" after the gate made it A1303, and
    // PEN-63's #152 kept risks about specs the factory's proof had since run, and passed.
    const f = fake({
      paths: ['apps/web/src/a.ts'],
      result: {
        ...webDone,
        summary: 'Download buttons are one component; decision A-NEW-1 amends A1220.',
        decisions: ['A-NEW-1: one DownloadButton draws every download button', 'A-NEW-10 stays'],
        risks: [
          'The Mac spec (test/e2e/download.spec.ts) and the Android instrumented test could not be run in the sandbox (no VM, no emulator).',
          'Prettier re-padded the decisions table around A-NEW-1; the gate renumbers and reformats it.',
          'A-NEW-2 may read oddly on a narrow phone.',
        ],
      },
      reviews: [
        JSON.stringify({
          rows: [
            {
              criterion: 'AC1 the hero follows A-NEW-1',
              verdict: 'deviation',
              note: 'A-NEW-1 keeps the old label on Android',
            },
          ],
        }),
      ],
    });
    const base = f.deps;
    f.deps = {
      ...base,
      openSandbox: async (branch) => {
        const box = await base.openSandbox(branch);
        return {
          ...box,
          exec: (command) =>
            command.startsWith('git log')
              ? Promise.resolve({
                  exitCode: 0,
                  stdout:
                    'Site: one DownloadButton\nNumber the new decisions: A-NEW-1 is A1301, A-NEW-2 is A1302\nRenumber the decisions main already has: A1301 is now A1303\n',
                  stderr: '',
                })
              : box.exec(command),
        };
      },
    };
    const outcome = await runImplement(f.deps, { item: card, spec, prompt: 'p', plan: 'AC1 …' });
    expect(outcome.kind).toBe('in-review');
    const body = f.comments[1]!;
    expect(body).toContain('Download buttons are one component; decision A1303 amends A1220.');
    expect(body).toContain('- A1303: one DownloadButton draws every download button');
    // Whole words only: the gate gave A-NEW-10 no number, so it stays as the agent wrote it.
    expect(body).toContain('- A-NEW-10 stays');
    expect(body).toContain('- A1302 may read oddly on a narrow phone.');
    expect(body).toContain('AC1 the hero follows A1303<br>A1303 keeps the old label on Android');
    expect(body).not.toMatch(/A-NEW-1\b/);
    expect(body).toContain(
      "could not be run in the sandbox (no VM, no emulator). (The factory's proof ran the Mac and Android specs: passed.)",
    );
    expect(body).not.toContain('Prettier re-padded');
  });

  it('renders the agreed mockups before the capture session, and tells it which PNGs are there (A1323)', async () => {
    const rendered = [
      JSON.stringify({ file: 'ac1.html', png: 'ac1-mockup.png', width: 390, height: 844 }),
      JSON.stringify({ file: 'ac2.html', error: 'page.screenshot: Timeout 15000ms exceeded.' }),
    ].join('\n');
    const f = fake({
      paths: ['apps/web/src/a.ts'],
      result: webDone,
      reviews: [review('match')],
      rendered,
    });
    await runImplement(f.deps, { item: card, spec, prompt: 'p', plan: 'AC1 …' });
    const staged = f.calls.indexOf('mockups');
    const render = f.calls.findIndex((c) => /^exec \d+: cd 'apps\/web' && node - /.test(c));
    expect(staged).toBeGreaterThan(-1);
    expect(render).toBeGreaterThan(staged);
    // Between staging and the capture session, the build's own agent round long done.
    expect(f.calls.indexOf('agent', render)).toBeGreaterThan(render);
    expect(f.calls.slice(staged, render)).not.toContain('agent');
    const capture = f.prompts[1]!;
    expect(capture).toMatch(/^You are validating/);
    expect(capture).toContain("so don't render them again");
    expect(capture).toContain('- `ac1-mockup.png`, 390×844, from `ac1.html`.');
    expect(capture).toContain(
      "- `ac2.html` couldn't be rendered (page.screenshot: Timeout 15000ms exceeded.). Render it yourself to `ac2-mockup.png`",
    );
    expect(capture).not.toContain('Render each one to');
    // One criterion per test, with a short timeout, so a hang costs seconds.
    expect(capture).toContain('one criterion per test');
    expect(capture).toContain('`--timeout=20000`');
  });

  it("gives the reviewer the agreed plan's words, which win over its mockup (PEN-63)", async () => {
    const plan = 'AC4 When a note is moved on Android, the snackbar shall show no leading glyph.';
    const f = fake({ paths: ['apps/web/src/a.ts'], result: webDone, reviews: [review('match')] });
    await runImplement(f.deps, { item: card, spec, prompt: 'p', plan });
    const reviewer = f.prompts[2]!;
    expect(reviewer).toMatch(/^You are an independent reviewer/);
    expect(reviewer).toContain(`## The agreed plan\n\n${plan}`);
    expect(reviewer).toContain(
      "Where the plan's words and its mockup disagree, the plan's words win.",
    );
    expect(reviewer).toContain(
      'A screenshot that follows the words but not the mockup is a `deviation` whose note quotes the plan',
    );
    expect(reviewer).toContain('never a `mismatch`');
    expect(reviewer).toContain('One that follows the mockup against the words is a `mismatch`.');
  });

  it("gives the reviewer the builder's reasons for what it couldn't do (F19)", async () => {
    const f = fake({
      paths: ['apps/web/src/a.ts'],
      result: { ...webDone, risks: ['AC1: Safari has no :has(), so the badge stays flat'] },
      reviews: [review('deviation', 'Flat badge: Safari has no :has()')],
    });
    const outcome = await runImplement(f.deps, { item: card, spec, prompt: 'p', plan: 'AC1 …' });
    expect(outcome.kind).toBe('in-review');
    expect(f.prompts[2]).toMatch(/^You are an independent reviewer/);
    expect(f.prompts[2]).toContain('- AC1: Safari has no :has(), so the badge stays flat');
    expect(f.comments[1]).toContain('- **AC1 the badge uses the accent colour**: Flat badge');
  });

  it("shows the validation and review sessions the issue's images (A1277)", async () => {
    const f = fake({ paths: ['apps/web/src/a.ts'], result: webDone, reviews: [review('match')] });
    const images = "## The issue's images\n\n1. `.factory/attachments/0a1b.png`";
    await runImplement(f.deps, { item: card, spec, prompt: 'p', plan: 'AC1 …', images });
    expect(f.prompts[1]).toMatch(/^You are validating/);
    expect(f.prompts[1]).toContain('`.factory/attachments/0a1b.png`');
    expect(f.prompts[2]).toMatch(/^You are an independent reviewer/);
    expect(f.prompts[2]).toContain('`.factory/attachments/0a1b.png`');
  });

  it('tells the validation and review sessions when the issue has no images', async () => {
    const f = fake({ paths: ['apps/web/src/a.ts'], result: webDone, reviews: [review('match')] });
    await runImplement(f.deps, { item: card, spec, prompt: 'p', plan: 'AC1 …' });
    expect(f.prompts[1]).toContain("## The issue's images\n\nThe issue has none.");
    expect(f.prompts[2]).toContain("## The issue's images\n\nThe issue has none.");
  });

  const androidDone: AgentResult = {
    ...done,
    platforms: { android: { inScope: true, proofSpecs: ['app.penmoss.EditorScreenTest'] } },
  };
  const macDone: AgentResult = {
    ...done,
    platforms: { mac: { inScope: true, proofSpecs: ['test/e2e/app.spec.ts'] } },
  };

  it('walks a Mac and Android change on each app, then tells the reviewer what each walk did (PEN-94)', async () => {
    const f = fake({
      paths: ['apps/web/src/a.ts', 'apps/desktop/src/b.ts', 'apps/android/app/src/c.kt'],
      result: webDone,
      reviews: [review('match')],
      walks: {
        mac: { platform: 'mac', captures: ['ac3-mac.png'] },
        android: {
          platform: 'android',
          captures: [],
          problem: 'The walkthrough failed. It printed nothing.',
        },
      },
    });
    const outcome = await runImplement(f.deps, { item: card, spec, prompt: 'p', plan: 'AC1 …' });
    expect(outcome.kind).toBe('in-review');
    // After the capturing session and before the reviewer's: Android first, then the VM.
    const walked = f.calls.filter((c) => c.startsWith('walk') || c === 'agent' || c === 'vm check');
    expect(walked.slice(-5)).toEqual(['agent', 'walk android', 'vm check', 'walk mac', 'agent']);
    // The walkthroughs are gone from the worktree once reviewed: a later round's gate would lint them.
    const reviewed = f.calls.lastIndexOf('agent');
    expect(f.calls.slice(reviewed)).toContainEqual(
      expect.stringMatching(
        /^exec \d+: rm -f apps\/android\/app\/src\/androidTest\/java\/app\/penmoss\/walk\/FactoryWalkInstrumentedTest\.kt apps\/desktop\/test\/e2e\/factory-walk\.spec\.ts$/,
      ),
    );
    expect(f.prompts.at(-2)).toContain('**web, mac, android**');
    const reviewer = f.prompts.at(-1)!;
    expect(reviewer).toMatch(/^You are an independent reviewer/);
    expect(reviewer).toContain(
      '- **Mac: the Electron app in the test VM**: captured `ac3-mac.png`.',
    );
    expect(reviewer).toContain(
      "- **Android: the app on the factory's emulator**: captured nothing. The walkthrough failed. It printed nothing.",
    );
  });

  it('validates a change only the Android app shows (PEN-94)', async () => {
    const f = fake({
      paths: ['apps/android/app/src/c.kt'],
      result: androidDone,
      reviews: [review('match')],
    });
    await runImplement(f.deps, { item: card, spec, prompt: 'p', plan: 'AC1 …' });
    expect(f.calls).toContain('walk android');
    expect(f.calls).not.toContain('walk mac');
    expect(f.prompts.some((p) => p.includes('**android**'))).toBe(true);
  });

  it('makes the Mac walkthrough wait for the test VM, as the Mac proof does (PEN-94)', async () => {
    const busy = { ok: false as const, reason: 'penmoss-test is busy with another run' };
    const f = fake({
      paths: ['apps/desktop/src/b.ts'],
      result: macDone,
      reviews: [review('match')],
      // Free for the proof, then busy twice for the walkthrough.
      vmChecks: [{ ok: true }, busy, busy],
    });
    const outcome = await runImplement(f.deps, { item: card, spec, prompt: 'p', plan: 'AC1 …' });
    expect(outcome.kind).toBe('in-review');
    expect(f.waits).toContain(
      'the Mac walkthrough waits for the test VM: penmoss-test is busy with another run',
    );
    expect(f.calls.filter((c) => c === 'walk mac')).toHaveLength(1);
    expect(f.waits.at(-1)).toBeNull();
  });

  it('tells the reviewer why a walkthrough could not run, rather than failing validation', async () => {
    const f = fake({
      paths: ['apps/android/app/src/c.kt'],
      result: androidDone,
      reviews: [review('match')],
      walks: { android: new Error('the emulator exited') },
    });
    const outcome = await runImplement(f.deps, { item: card, spec, prompt: 'p', plan: 'AC1 …' });
    expect(outcome.kind).toBe('in-review');
    expect(f.prompts.at(-1)).toContain("captured nothing. It couldn't run: the emulator exited.");
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

  it('sends a result without a Release note back once, then puts the note in the PR (PEN-105)', async () => {
    const bare: AgentResult = { ...done };
    delete (bare as { releaseNote?: string }).releaseNote;
    const f = fake({
      agentRounds: [bare, { ...done, releaseNote: 'fixed: the typo in the CLI docs is gone.' }],
    });
    const outcome = await runImplement(f.deps, { item: card, spec, prompt: 'p' });
    expect(outcome.kind).toBe('in-review');
    expect(f.calls.filter((c) => c === 'agent')).toHaveLength(2);
    expect(f.events).toContain('release-note-refused');
    expect(f.prompts[1]).toContain('## Your Release note');
    expect(f.prompts[1]).toContain('`.factory/result.json` has no `releaseNote`.');
    // The PR shows the note as the check reads it, its kind written out.
    expect(f.comments[1]).toContain(
      '## Release note\n\nFixed: the typo in the CLI docs is gone.\n',
    );
  });

  it('blocks without pushing when the Release note is still wrong after one more try', async () => {
    const bad = { ...done, releaseNote: 'Changed: something' };
    const f = fake({ agentRounds: [bad, bad] });
    const outcome = await runImplement(f.deps, { item: card, spec, prompt: 'p' });
    expect(outcome).toEqual({ kind: 'blocked', reason: 'release-note' });
    expect(f.calls.filter((c) => c === 'agent')).toHaveLength(2);
    expect(f.prompts[1]).toContain('start with New, Improved or Fixed');
    expect(f.comments.at(-1)).toContain("still doesn't pass the check");
    expect(f.calls.some((c) => c.startsWith('push'))).toBe(false);
    expect(f.calls.at(-1)).toBe('blocked');
  });

  it('blocks when the agent stops instead of fixing its Release note', async () => {
    const bare: AgentResult = { ...done };
    delete (bare as { releaseNote?: string }).releaseNote;
    const f = fake({ agentRounds: [bare, { ...done, status: 'failed', summary: 'gave up' }] });
    const outcome = await runImplement(f.deps, { item: card, spec, prompt: 'p' });
    expect(outcome).toEqual({ kind: 'blocked', reason: 'release-note' });
    expect(f.comments.at(-1)).toContain('the agent stopped instead: gave up');
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

  it("logs why the gate refused each round, in one line (gate-failed's reason)", async () => {
    const reasons = (f: Fake) =>
      f.details.filter(([e]) => e === 'gate-failed').map(([, d]) => d?.['reason']);
    const failed = fake({ gateExit: 1 });
    await runImplement(failed.deps, { item: card, spec, prompt: 'p' });
    expect(reasons(failed)).toEqual(Array(config.rounds.gateFix + 1).fill('task lint failed'));
    expect(failed.details).toContainEqual([
      'gate-failed',
      { round: 0, reason: 'task lint failed' },
    ]);

    const conflicted = fake({ conflict: true });
    await runImplement(conflicted.deps, { item: card, spec, prompt: 'p' });
    expect(reasons(conflicted)[0]).toBe('rebase conflict: docs/cli.md');

    const unproved = fake({ paths: ['apps/web/src/a.ts'], result: webDone, proofPassed: false });
    await runImplement(unproved.deps, { item: card, spec, prompt: 'p' });
    expect(reasons(unproved)[0]).toBe(
      'web proof: no passing recording; mac proof: no passing recording; android proof: no passing recording',
    );

    const unnamed = fake({ paths: ['apps/web/src/a.ts'], agentRounds: [done, webDone] });
    await runImplement(unnamed.deps, { item: card, spec, prompt: 'p' });
    expect(reasons(unnamed)).toEqual(['no proof spec named for web, mac, android']);

    const weakened = fake({ weakened: true, agentRounds: [done, done] });
    await runImplement(weakened.deps, { item: card, spec, prompt: 'p' });
    expect(reasons(weakened)[0]).toBe('weakened tests: apps/web/test/e2e/x.spec.ts');
  });

  it('installs the rebased dependencies before the check, and a failed install goes to the agent (A1251)', async () => {
    const f = fake({ paths: ['.github/x.yml'], installExit: 1 });
    const outcome = await runImplement(f.deps, { item: card, spec, prompt: 'p' });
    expect(outcome).toEqual({ kind: 'blocked', reason: 'gate-failed' });
    expect(f.comments.at(-1)).toContain('pnpm install --frozen-lockfile --prefer-offline');
    expect(f.calls.some((c) => c.endsWith(': task check') || c.endsWith(': task lint'))).toBe(
      false,
    );
  });

  it.each([
    ['leaves uncommitted changes', { dirty: true }, 'gate-failed'],
    ['commits nothing', { commits: 0 }, 'no-commits'],
  ] as const)('blocks when the agent %s', async (_, options, reason) => {
    expect(await runImplement(fake(options).deps, { item: card, spec, prompt: 'p' })).toEqual({
      kind: 'blocked',
      reason,
    });
  });

  it('blocks when the agent writes no result', async () => {
    const f = fake({ result: { error: 'the agent wrote no .factory/result.json', missing: true } });
    expect(await runImplement(f.deps, { item: card, spec, prompt: 'p' })).toEqual({
      kind: 'blocked',
      reason: 'the agent wrote no .factory/result.json',
    });
    // It was given one more session first, never more (A1346).
    expect(f.calls.filter((c) => c === 'agent')).toHaveLength(2);
    expect(f.calls).toContain('close 1');
    // A malformed result isn't a missing one: it goes straight to Blocked.
    const bad = fake({ result: { error: 'status must be done, needs-info or failed' } });
    expect(await runImplement(bad.deps, { item: card, spec, prompt: 'p' })).toMatchObject({
      kind: 'blocked',
    });
    expect(bad.calls.filter((c) => c === 'agent')).toHaveLength(1);
    expect(bad.events).not.toContain('agent-continued');
  });
});
