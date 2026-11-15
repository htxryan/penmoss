import { describe, expect, it } from 'vitest';
import type { RebaseOutcome } from '../src/rebase.ts';
import { runImplement } from '../src/run.ts';
import type { RunDeps } from '../src/run-deps.ts';
import { card, spec, done, type Fake, fake, webDoneForPush } from './run-fake.ts';

describe('main moves while the PR waits for CI (F6)', () => {
  // `behind` starts with `false`: the check before the first push.
  const BR = 'factory/42-fix-the-typo-in-docs-cli';
  const conflict: RebaseOutcome = {
    kind: 'conflict',
    files: ['apps/web/src/a.ts', 'docs/cli.md'],
    output: 'CONFLICT (content): Merge conflict in apps/web/src/a.ts',
  };
  const clean: RebaseOutcome = { kind: 'rebased', resolved: [], renumbered: {} };

  it('rebases once more before In review, gates again, pushes with the lease and waits for CI', async () => {
    const f = fake({
      behind: [false, true],
      rebases: [
        clean,
        { kind: 'rebased', resolved: ['docs/decisions.md'], renumbered: { A1225: 'A1226' } },
      ],
    });
    const outcome = await runImplement(f.deps, { item: card, spec, prompt: 'p' });
    expect(outcome.kind).toBe('in-review');
    expect(f.calls.slice(f.calls.indexOf('pr'))).toEqual([
      'pr',
      'checks',
      `behind? ${BR}`,
      `open ${BR}`,
      'rebase /wt/3',
      'exec 3: pnpm install --frozen-lockfile --prefer-offline',
      'exec 3: git diff origin/main...HEAD',
      'exec 3: task lint',
      'close 3',
      `push ${BR}`,
      'checks',
      'comment #42',
      'status In review',
      'notify Penmoss #42 is ready for review',
    ]);
    // The decisions conflict was the harness's to resolve: no agent round for it.
    expect(f.calls.filter((c) => c === 'agent')).toHaveLength(1);
    expect(f.events).toContain('rebased');
  });

  it('rebases a PR that GitHub says conflicts with main, since it gets no CI (A1311)', async () => {
    // PEN-63: rebased at 16:25, pushed at 16:45, and PEN-73's decision row landed between, so
    // #152 conflicted and GitHub ran no CI; the run would have waited on checks that never came.
    const f = fake({ ci: [[], []] });
    let asked = 0;
    const outcome = await runImplement(
      { ...f.deps, conflicts: () => Promise.resolve(++asked === 1) },
      { item: card, spec, prompt: 'p' },
    );
    expect(outcome.kind).toBe('in-review');
    expect(f.events).toContain('pr-conflicts');
    expect(f.calls.filter((c) => c.startsWith('push'))).toHaveLength(2);
  });

  it('sets Blocked when the PR still conflicts after the rebases allowed', async () => {
    const f = fake({ ci: Array.from({ length: 12 }, () => []) });
    const outcome = await runImplement(
      { ...f.deps, conflicts: () => Promise.resolve(true) },
      { item: card, spec, prompt: 'p' },
    );
    expect(outcome).toEqual({ kind: 'blocked', reason: 'rebase-conflict' });
    expect(f.comments.at(-1)).toMatch(/still conflicts with main after 2 rebase/);
    expect(f.calls.filter((c) => c.startsWith('push'))).toHaveLength(3);
  });

  it('keeps waiting for CI that has not started when the PR merges cleanly', async () => {
    const f = fake({ ci: [[], [], []] });
    const outcome = await runImplement(
      { ...f.deps, conflicts: () => Promise.resolve(false) },
      { item: card, spec, prompt: 'p' },
    );
    expect(outcome.kind).toBe('in-review');
    expect(f.events).not.toContain('pr-conflicts');
  });

  it("hands a conflict it can't resolve to one agent round, then goes on to review", async () => {
    const f = fake({ behind: [false, true], rebases: [clean, conflict, clean] });
    const outcome = await runImplement(f.deps, { item: card, spec, prompt: 'p' });
    expect(outcome.kind).toBe('in-review');
    expect(f.prompts[1]).toContain('## `origin/main` moved: rebase onto it');
    expect(f.prompts[1]).toContain('the local `main` branch is stale');
    expect(f.prompts[1]).toContain('stopped on conflicts in `apps/web/src/a.ts`, `docs/cli.md`');
    expect(f.calls.filter((c) => c.startsWith('push'))).toHaveLength(2);
    expect(f.calls.at(-2)).toBe('status In review');
  });

  it("logs the refresh gate's reason, and its pass before the push", async () => {
    // PEN-121's ledger read gate-failed, then pushed: the regate that passed logged nothing.
    const f = fake({
      behind: [false, true],
      workflowIn: (sandbox) => sandbox === 3,
    });
    const outcome = await runImplement(f.deps, { item: card, spec, prompt: 'p' });
    expect(outcome.kind).toBe('in-review');
    expect(f.details).toContainEqual([
      'gate-failed',
      { phase: 'rebase', reason: 'workflow change: .github/workflows/ci.yml' },
    ]);
    const after = f.details.slice(f.events.lastIndexOf('gate-failed'));
    expect(after.map(([e]) => e).filter((e) => e === 'gate-passed' || e === 'pushed')).toEqual([
      'gate-passed',
      'pushed',
    ]);
    expect(after).toContainEqual(['gate-passed', { command: 'task lint', phase: 'rebase' }]);
  });

  it('sets Blocked naming the conflicting files when the fix round leaves them', async () => {
    const f = fake({ behind: [false, true], rebases: [clean, conflict, conflict] });
    const outcome = await runImplement(f.deps, { item: card, spec, prompt: 'p' });
    expect(outcome).toEqual({ kind: 'blocked', reason: 'rebase-conflict' });
    const last = f.comments.at(-1)!;
    expect(last).toContain(
      'no longer rebases onto main: `apps/web/src/a.ts`, `docs/cli.md` conflict',
    );
    expect(last).toContain('event=blocked');
    expect(f.calls.filter((c) => c.startsWith('push'))).toHaveLength(1);
    expect(f.calls).not.toContain('status In review');
    expect(f.calls.at(-1)).toBe('blocked');
  });

  it('sets Blocked when the agent stops in its fix round, without pushing', async () => {
    const f = fake({
      behind: [false, true],
      rebases: [clean, conflict],
      agentRounds: [done, { ...done, status: 'failed', summary: 'both sides rename the route' }],
    });
    const outcome = await runImplement(f.deps, { item: card, spec, prompt: 'p' });
    expect(outcome).toEqual({ kind: 'blocked', reason: 'rebase-conflict' });
    expect(f.comments.at(-1)).toContain(
      "the agent's fix round stopped: both sides rename the route",
    );
    expect(f.calls.filter((c) => c.startsWith('push'))).toHaveLength(1);
  });

  it('gives a gate the rebase broke to the agent with the failure', async () => {
    const f = fake({ behind: [false, true] });
    let gates = 0;
    const base = f.deps;
    f.deps = {
      ...base,
      openSandbox: async (branch) => {
        const box = await base.openSandbox(branch);
        return {
          ...box,
          exec: (command) =>
            command === 'task lint' && ++gates === 2
              ? Promise.resolve({ exitCode: 1, stdout: 'main renamed lint:md', stderr: '' })
              : box.exec(command),
        };
      },
    };
    const outcome = await runImplement(f.deps, { item: card, spec, prompt: 'p' });
    expect(outcome.kind).toBe('in-review');
    expect(f.prompts[1]).toContain('## The gate after rebasing onto `origin/main`');
    expect(f.prompts[1]).toContain('main renamed lint:md');
  });
});

describe('main moves while proof and validation run, before the first push', () => {
  // PEN-63: the gate rebased at 16:25, proof and validation took 20 minutes, another PR's
  // decision row merged at 16:43, and the 16:45 push made a PR that conflicted with main.
  const BR = 'factory/42-fix-the-typo-in-docs-cli';
  /** The sandboxes' `git rev-parse` and `git diff --name-only` (what the rebase changed) and `git log`. */
  function withGit(f: Fake, git: { changed: string[]; log?: string }): RunDeps {
    const base = f.deps;
    return {
      ...base,
      openSandbox: async (branch) => {
        const box = await base.openSandbox(branch);
        const ok = (stdout: string) => Promise.resolve({ exitCode: 0, stdout, stderr: '' });
        return {
          ...box,
          exec: (command) => {
            if (command === 'git rev-parse HEAD') {
              f.calls.push(`exec: ${command}`);
              return ok('0123456789abcdef0123456789abcdef01234567\n');
            }
            if (command.startsWith('git diff --name-only')) {
              f.calls.push(`exec: ${command}`);
              return ok(git.changed.join('\n'));
            }
            if (command.startsWith('git log') && git.log) return ok(git.log);
            return box.exec(command);
          },
        };
      },
    };
  }
  const decisionsOnly: RebaseOutcome = {
    kind: 'rebased',
    resolved: ['docs/decisions.md'],
    renumbered: { A1301: 'A1303' },
  };

  it('rebases again, and pushes without gating again when main brought only decision rows', async () => {
    const f = fake({
      behind: [true],
      rebases: [{ kind: 'rebased', resolved: [], renumbered: {} }, decisionsOnly],
      result: { ...done, decisions: ['A-NEW-1: one download button'] },
    });
    const deps = withGit(f, {
      changed: ['docs/decisions.md'],
      log: 'Docs: fix the typo\nNumber the new decisions: A-NEW-1 is A1301\nRenumber the decisions main already has: A1301 is now A1303\n',
    });
    const outcome = await runImplement(deps, { item: card, spec, prompt: 'p' });
    expect(outcome.kind).toBe('in-review');
    expect(f.calls.slice(f.calls.indexOf('close 2'), f.calls.indexOf('pr') + 1)).toEqual([
      'close 2',
      `behind? ${BR}`,
      `open ${BR}`,
      'exec: git rev-parse HEAD',
      'rebase /wt/3',
      'exec: git diff --name-only 0123456789abcdef0123456789abcdef01234567 HEAD',
      'close 3',
      `push ${BR}`,
      'pr',
    ]);
    // One gate, one agent round: the decisions were the harness's to merge.
    expect(f.calls.filter((c) => c.endsWith('task lint'))).toHaveLength(1);
    expect(f.calls.filter((c) => c === 'agent')).toHaveLength(1);
    expect(f.calls.filter((c) => c.startsWith('push'))).toHaveLength(1);
    // The PR body has the number the branch has after this rebase.
    expect(f.comments[1]).toContain('- A1303: one download button');
  });

  it('gates again, but records no proof again, when main brought code', async () => {
    const f = fake({ behind: [true], paths: ['apps/web/src/a.ts'], result: webDoneForPush });
    const deps = withGit(f, { changed: ['docs/decisions.md', 'apps/web/src/b.ts'] });
    const outcome = await runImplement(deps, { item: card, spec, prompt: 'p' });
    expect(outcome.kind).toBe('in-review');
    expect(f.calls.filter((c) => c.endsWith('task check'))).toHaveLength(2);
    expect(f.calls.filter((c) => c.startsWith('proof web'))).toHaveLength(1);
    const before = f.calls.slice(0, f.calls.indexOf('pr'));
    expect(before.at(-2)).toBe('close 3');
    expect(before.at(-1)).toBe(`push ${BR}`);
    expect(f.calls.filter((c) => c.startsWith('push'))).toHaveLength(1);
  });

  it("hands a conflict it can't resolve to the agent, gates again and pushes once", async () => {
    const f = fake({
      behind: [true],
      rebases: [
        { kind: 'rebased', resolved: [], renumbered: {} },
        {
          kind: 'conflict',
          files: ['apps/web/src/a.ts'],
          output: 'CONFLICT (content): Merge conflict in apps/web/src/a.ts',
        },
      ],
    });
    const deps = withGit(f, { changed: [] });
    const outcome = await runImplement(deps, { item: card, spec, prompt: 'p' });
    expect(outcome.kind).toBe('in-review');
    expect(f.prompts[1]).toContain('## `origin/main` moved: rebase onto it');
    expect(f.prompts[1]).toContain(`\`${BR}\` no longer rebases onto \`origin/main\``);
    // The gate after the agent's fix always runs its check.
    expect(f.calls.filter((c) => c.endsWith('task lint'))).toHaveLength(2);
    expect(f.calls.filter((c) => c.startsWith('push'))).toHaveLength(1);
    expect(f.calls.indexOf(`push ${BR}`)).toBeLessThan(f.calls.indexOf('pr'));
  });

  it("sets Blocked with the files named, and pushes nothing, when the agent can't resolve it", async () => {
    const conflict: RebaseOutcome = {
      kind: 'conflict',
      files: ['apps/web/src/a.ts'],
      output: 'CONFLICT (content): Merge conflict in apps/web/src/a.ts',
    };
    const f = fake({
      behind: [true],
      rebases: [{ kind: 'rebased', resolved: [], renumbered: {} }, conflict, conflict],
    });
    const outcome = await runImplement(withGit(f, { changed: [] }), {
      item: card,
      spec,
      prompt: 'p',
    });
    expect(outcome).toEqual({ kind: 'blocked', reason: 'rebase-conflict' });
    expect(f.comments.at(-1)).toContain(
      'no longer rebases onto main: `apps/web/src/a.ts` conflict',
    );
    expect(f.calls.filter((c) => c.startsWith('push'))).toHaveLength(0);
    expect(f.calls).not.toContain('pr');
    expect(f.calls.at(-1)).toBe('blocked');
  });
});
