import { describe, expect, it } from 'vitest';
import {
  CONTINUE_MESSAGE,
  CONTINUE_NOTE,
  commitMessage,
  commitNote,
  porcelainPaths,
} from '../src/agent-round.ts';
import { runImplement } from '../src/run.ts';
import type { RunDeps } from '../src/run-deps.ts';
import { card, spec, done, fake } from './run-fake.ts';

describe('a session that ends without result.json (A1346)', () => {
  it('continues a session that ended without result.json once, in the same sandbox', async () => {
    // PEN-117's OpenCode session ended on a malformed tool call, and the run Blocked at once.
    const missing = { error: 'the agent wrote no .factory/result.json', missing: true };
    const f = fake({ agentRounds: [missing], resumable: true });
    const outcome = await runImplement(f.deps, { item: card, spec, prompt: 'p' });
    expect(outcome.kind).toBe('in-review');
    expect(f.calls.slice(2, 6)).toEqual([
      'open factory/42-fix-the-typo-in-docs-cli',
      'agent',
      'agent continued',
      'close 1',
    ]);
    expect(f.prompts[1]).toBe(CONTINUE_MESSAGE);
    expect(f.details).toContainEqual(['agent-continued', { round: 0, how: 'resume' }]);
  });

  it("starts a new session with the note when the agent can't resume one", async () => {
    const missing = { error: 'the agent wrote no .factory/result.json', missing: true };
    const f = fake({ agentRounds: [missing] });
    const outcome = await runImplement(f.deps, { item: card, spec, prompt: 'p' });
    expect(outcome.kind).toBe('in-review');
    expect(f.calls.slice(2, 6)).toEqual([
      'open factory/42-fix-the-typo-in-docs-cli',
      'agent',
      'agent',
      'close 1',
    ]);
    expect(f.prompts[1]).toBe(`p\n\n${CONTINUE_NOTE}`);
    expect(f.details).toContainEqual(['agent-continued', { round: 0, how: 'new session' }]);
  });

  it('falls back to a new session when the resume fails', async () => {
    const missing = { error: 'the agent wrote no .factory/result.json', missing: true };
    const f = fake({ agentRounds: [missing], resumable: true });
    const deps: RunDeps = {
      ...f.deps,
      continueAgent: () => Promise.reject(new Error('resumeSession "x" not found')),
    };
    const outcome = await runImplement(deps, { item: card, spec, prompt: 'p' });
    expect(outcome.kind).toBe('in-review');
    expect(f.prompts).toEqual(expect.arrayContaining([`p\n\n${CONTINUE_NOTE}`]));
    expect(f.details).toContainEqual([
      'agent-continued',
      { round: 0, how: 'new session', after: 'resumeSession "x" not found' },
    ]);
  });
});

describe('a session that ends with its work uncommitted (PEN-141)', () => {
  // PEN-140's round 2: the agent wrote a done result.json, started `task check:changed` in the
  // background and ended its turn to wait for it. The sandbox closed, stopping the check, and the
  // gate refused the 16 files it left uncommitted.
  const left = Array.from({ length: 16 }, (_, i) => `apps/web/src/f${i}.ts`);

  it('gives a resumable session one more turn to commit, which is not a round', async () => {
    const f = fake({ uncommitted: [left, []], resumable: true });
    const outcome = await runImplement(f.deps, { item: card, spec, prompt: 'p' });
    expect(outcome.kind).toBe('in-review');
    expect(f.calls.slice(2, 7)).toEqual([
      'open factory/42-fix-the-typo-in-docs-cli',
      'agent',
      'uncommitted?',
      'agent continued',
      'close 1',
    ]);
    expect(f.prompts[1]).toBe(commitMessage(left));
    expect(f.prompts[1]).toContain('`apps/web/src/f0.ts`');
    expect(f.prompts[1]).toContain('and 6 more');
    expect(f.prompts[1]).toContain('in the foreground');
    expect(f.details).toContainEqual([
      'agent-continued',
      { round: 0, how: 'resume', uncommitted: 16 },
    ]);
    // Still round 0: the extra turn isn't a gate round.
    expect(f.details.filter(([e]) => e === 'agent-started')).toEqual([
      ['agent-started', { branch: 'factory/42-fix-the-typo-in-docs-cli', round: 0 }],
    ]);
  });

  it("starts a new session with the note when the agent can't resume one", async () => {
    const f = fake({ uncommitted: [['a.ts']] });
    const outcome = await runImplement(f.deps, { item: card, spec, prompt: 'p' });
    expect(outcome.kind).toBe('in-review');
    expect(f.prompts[1]).toBe(`p\n\n${commitNote(['a.ts'])}`);
    expect(f.details).toContainEqual([
      'agent-continued',
      { round: 0, how: 'new session', uncommitted: 1 },
    ]);
  });

  it('asks only once a round, and the gate names what is still uncommitted', async () => {
    const f = fake({
      uncommitted: [['a.ts'], ['a.ts'], ['a.ts'], ['a.ts'], ['a.ts'], ['a.ts']],
      dirty: true,
      resumable: true,
    });
    const outcome = await runImplement(f.deps, { item: card, spec, prompt: 'p' });
    expect(outcome).toEqual({ kind: 'blocked', reason: 'gate-failed' });
    // One commit turn after each of the 3 rounds, never two in a row.
    expect(f.calls.filter((c) => c === 'agent continued')).toHaveLength(3);
    expect(f.details).toContainEqual([
      'gate-failed',
      { round: 0, reason: 'uncommitted changes (1 file)' },
    ]);
    expect(f.comments.at(-1)).toContain('the agent left 1 tracked file uncommitted: `x`');
  });

  it('leaves a clean session, or one that did not finish, alone', async () => {
    const clean = fake({ uncommitted: [[]], resumable: true });
    await runImplement(clean.deps, { item: card, spec, prompt: 'p' });
    expect(clean.calls).not.toContain('agent continued');

    const failed = fake({
      uncommitted: [['a.ts']],
      resumable: true,
      result: { ...done, status: 'failed', summary: 'gave up' },
    });
    await runImplement(failed.deps, { item: card, spec, prompt: 'p' });
    expect(failed.calls).not.toContain('uncommitted?');
  });

  it("reads git status's paths, a rename by where it went", () => {
    expect(porcelainPaths(' M a.ts\nM  b/c.ts\nR  old.ts -> new.ts\n')).toEqual([
      'a.ts',
      'b/c.ts',
      'new.ts',
    ]);
    expect(porcelainPaths('')).toEqual([]);
  });
});
