import { describe, expect, it } from 'vitest';
import type { AgentResult } from '../src/result.ts';
import { runImplement } from '../src/run.ts';
import { card, spec, done, fake } from './run-fake.ts';

describe('the Mac proof waits for the test VM (F7, F10)', () => {
  const macDone: AgentResult = {
    ...done,
    platforms: { mac: { inScope: true, proofSpecs: ['test/e2e/app.spec.ts'] } },
  };
  const mac = { paths: ['apps/desktop/src/main.ts'], result: macDone };
  const count = (calls: string[], prefix: string) =>
    calls.filter((c) => c.startsWith(prefix)).length;

  it("waits a poll at a time while the VM can't take it, then records, with no round used", async () => {
    const f = fake({
      ...mac,
      vmChecks: [
        { ok: false, reason: 'penmoss-test is busy with another run' },
        { ok: false, reason: 'penmoss-test is busy with another run' },
        { ok: false, reason: 'tart is not installed: see docs/ci.md' },
      ],
    });
    const outcome = await runImplement(f.deps, { item: card, spec, prompt: 'p' });
    expect(outcome.kind).toBe('in-review');
    expect(count(f.calls, 'vm check')).toBe(4);
    expect(count(f.calls, 'proof mac')).toBe(1);
    expect(count(f.calls, 'agent')).toBe(1);
    expect(f.calls).not.toContain('blocked');
    expect(f.waits).toEqual([
      'the Mac proof waits for the test VM: penmoss-test is busy with another run',
      'the Mac proof waits for the test VM: penmoss-test is busy with another run',
      'the Mac proof waits for the test VM: tart is not installed: see docs/ci.md',
      null,
    ]);
    // A poll between checks; the ledger says so once per reason.
    expect(f.slept.slice(0, 3)).toEqual([60, 60, 60]);
    expect(f.events.filter((e) => e === 'proof-waiting')).toHaveLength(2);
    // The check comes right before the proof: a VM found free is used at once.
    expect(f.calls.indexOf('proof mac: test/e2e/app.spec.ts') - 1).toBe(
      f.calls.lastIndexOf('vm check'),
    );
  });

  it("treats a VM that doesn't boot (the script's exit 75) as a wait, not a failure", async () => {
    const f = fake({ ...mac, vmBootFails: 2 });
    const outcome = await runImplement(f.deps, { item: card, spec, prompt: 'p' });
    expect(outcome.kind).toBe('in-review');
    expect(count(f.calls, 'proof mac')).toBe(3);
    expect(count(f.calls, 'agent')).toBe(1);
    expect(f.waits[0]).toBe(
      'the Mac proof waits for the test VM: penmoss-test did not answer in 3 minutes',
    );
    expect(f.waits.at(-1)).toBeNull();
  });

  it('stops Blocked with the reason only after macProof.waitHours', async () => {
    const reason = "penmoss-test isn't made yet: run task desktop:test:vm once (docs/ci.md §8)";
    // The fake clock moves 30 minutes on every reading.
    const f = fake({
      ...mac,
      vmChecks: Array.from({ length: 100 }, () => ({ ok: false as const, reason })),
    });
    const outcome = await runImplement(f.deps, { item: card, spec, prompt: 'p' });
    expect(outcome).toEqual({ kind: 'blocked', reason: 'mac-vm' });
    expect(count(f.calls, 'proof mac')).toBe(0);
    // Not the agent's to fix: no gate round, straight to Blocked.
    expect(count(f.calls, 'agent')).toBe(1);
    expect(f.events).not.toContain('gate-failed');
    expect(count(f.calls, 'vm check')).toBeGreaterThan(10);
    expect(count(f.calls, 'vm check')).toBeLessThan(30);
    expect(f.calls.at(-1)).toBe('blocked');
    expect(f.comments.at(-1)).toContain(
      `The Mac proof waited 12 h for the test VM (penmoss-test), which still can't take it: ${reason}.`,
    );
    expect(f.waits.at(-1)).toBeNull();
  });

  it('gives every proof a signal that aborts at its timeout', async () => {
    const f = fake({
      paths: ['apps/web/src/a.ts'],
      result: {
        ...done,
        platforms: {
          web: { inScope: true, proofSpecs: ['a.spec.ts'] },
          mac: { inScope: true, proofSpecs: ['app.spec.ts'] },
          android: { inScope: true, proofSpecs: ['app.penmoss.EditorScreenTest'] },
        },
      },
    });
    await runImplement(f.deps, { item: card, spec, prompt: 'p' });
    expect(f.signals).toHaveLength(3);
    for (const signal of f.signals) {
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal?.aborted).toBe(false);
    }
  });
});
