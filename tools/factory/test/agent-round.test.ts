import { describe, expect, it } from 'vitest';
import { CONTINUE_MESSAGE, CONTINUE_NOTE } from '../src/agent-round.ts';
import { runImplement } from '../src/run.ts';
import type { RunDeps } from '../src/run-deps.ts';
import { card, spec, fake } from './run-fake.ts';

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
