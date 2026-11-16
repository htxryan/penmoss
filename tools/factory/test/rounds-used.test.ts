import { describe, expect, it } from 'vitest';
import { roundsUsed } from '../src/start.ts';
import { runImplement } from '../src/run.ts';
import { config, card, spec, done, fake } from './run-fake.ts';

const line = (run: string, event: string, detail: Record<string, unknown> = {}) =>
  JSON.stringify({ at: '2026-11-15T10:00:00Z', run, slot: 1, event, ...detail });

describe('the gate rounds a card has used (PEN-142)', () => {
  // PEN-140, 15 Nov: run adb8 reached validation round 1, then its next round's gate failed and
  // the run was Blocked. Cleared, the recovered run's first validation was round 0 again.
  const pen140 = [
    line('140-a', 'claimed', { issue: 140 }),
    line('140-a', 'validation-mismatch', { round: 0, criteria: ['AC5'] }),
    line('140-a', 'validation-mismatch', { round: 1, criteria: ['AC3'] }),
    line('140-a', 'gate-failed', { round: 2, reason: 'uncommitted changes' }),
    line('140-a', 'blocked', { reason: 'gate-failed' }),
  ];

  it('counts the rounds the runs a recovered run carries on from used', () => {
    expect(roundsUsed(pen140.join('\n'), 140)).toBe(3);
    const recovered = [...pen140, line('140-b', 'claimed', { issue: 140, recovered: true })];
    expect(roundsUsed(recovered.join('\n'), 140)).toBe(3);
    // The recovered run's own rounds go on from there.
    const more = [...recovered, line('140-b', 'validation-mismatch', { round: 3, criteria: [] })];
    expect(roundsUsed(more.join('\n'), 140)).toBe(4);
  });

  it('starts again at a fresh claim, and leaves out other cards and later gates', () => {
    const fresh = [...pen140, line('140-c', 'claimed', { issue: 140 })];
    expect(roundsUsed(fresh.join('\n'), 140)).toBe(0);
    expect(roundsUsed(pen140.join('\n'), 141)).toBe(0);
    // A rebase's gate after the PR (refresh.ts) logs a phase, and isn't an implementation round.
    const rebase = [
      line('140-a', 'claimed', { issue: 140 }),
      line('140-a', 'gate-failed', { phase: 'rebase', reason: 'task check failed' }),
    ];
    expect(roundsUsed(rebase.join('\n'), 140)).toBe(0);
    expect(roundsUsed(`${pen140.join('\n')}\n{"torn`, 140)).toBe(3);
  });
});

describe('a recovered run goes on with the rounds its card has used (PEN-142)', () => {
  const recovered = {
    item: card,
    spec,
    prompt: 'p',
    recovered: true,
    resume: { run: '42-old', result: done },
  } as const;

  it('numbers its rounds after the earlier runs and stops at the limit', async () => {
    const f = fake({ gateExit: 1 });
    const outcome = await runImplement(f.deps, { ...recovered, firstRound: 1 });
    expect(outcome).toEqual({ kind: 'blocked', reason: 'gate-failed' });
    const rounds = f.details.filter(([e]) => e === 'gate-failed').map(([, d]) => d?.['round']);
    expect(rounds).toEqual([1, 2]);
    // The gate from the resumed result, then one fix round: 3 rounds in all, not 3 more.
    expect(f.calls.filter((c) => c === 'agent')).toHaveLength(1);
    expect(f.comments[0]).toContain(`Earlier runs used 1 of this card's 3 gate rounds`);
    expect(f.comments.at(-1)).toContain('after 3 round(s) on this card, counting earlier runs');
    expect(f.details).toContainEqual(['claimed', { issue: 42, recovered: true }]);
  });

  it('gets one try at the gate when the earlier runs used every round', async () => {
    const f = fake({ gateExit: 1 });
    await runImplement(f.deps, { ...recovered, firstRound: config.rounds.gateFix + 1 });
    expect(f.calls).not.toContain('agent');
    expect(f.calls.at(-1)).toBe('blocked');
  });

  it("validates with the last round's rules once the rounds are used", async () => {
    const mismatch = JSON.stringify({
      rows: [
        {
          criterion: 'AC1 x',
          verdict: 'mismatch',
          note: 'n',
          mockup: 'm.png',
          screenshot: 's.png',
        },
      ],
    });
    // Web paths put every platform in scope, so each names a proof spec.
    const webDone = {
      ...done,
      platforms: {
        web: { inScope: true, proofSpecs: ['comments.spec.ts'] },
        mac: { inScope: true, proofSpecs: ['app.spec.ts'] },
        android: { inScope: true, proofSpecs: ['app.penmoss.EditorScreenTest'] },
      },
    };
    const f = fake({ paths: ['apps/web/src/a.ts'], result: webDone, reviews: [mismatch] });
    const outcome = await runImplement(f.deps, {
      ...recovered,
      resume: { run: '42-old', result: webDone },
      plan: 'AC1 x',
      firstRound: config.rounds.gateFix,
    });
    // The final round's mismatch goes to the PR's fidelity table rather than another round.
    expect(outcome.kind).toBe('in-review');
    expect(f.events).not.toContain('validation-mismatch');
  });

  it('ignores firstRound on a fresh run', async () => {
    const f = fake({ gateExit: 1 });
    await runImplement(f.deps, { item: card, spec, prompt: 'p', firstRound: 2 });
    expect(f.calls.filter((c) => c === 'agent')).toHaveLength(config.rounds.gateFix + 1);
    expect(f.details).toContainEqual(['claimed', { issue: 42 }]);
  });
});
