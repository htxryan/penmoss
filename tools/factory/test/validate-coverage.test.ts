import { describe, expect, it } from 'vitest';
import type { RunSandbox } from '../src/run-deps.ts';
import { validate, type ValidateDeps } from '../src/validate.ts';
import { testConfig } from './helpers.ts';

const PLAN =
  'AC1 When Settings opens on the Mac, Privacy shall be last.\nAC2 When … the dashboard shall show tiles.';

function fake(captures: () => string) {
  const prompts: string[] = [];
  const events: [string, unknown][] = [];
  const sandbox = {
    exec: () => Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }),
  } as unknown as RunSandbox;
  const deps: ValidateDeps = {
    config: testConfig(),
    runAgent: (_s, prompt) => {
      prompts.push(prompt);
      return Promise.resolve({ output: '' });
    },
    now: () => new Date('2026-11-19T12:00:00Z'),
    sleep: () => Promise.resolve(),
    log: (e, d) => events.push([e, d]),
    heavy: (_l, fn) => fn(),
    walk: (_s, platform) => Promise.resolve({ platform, captures: [] }),
    macVmCheck: () => Promise.resolve({ ok: true }),
    waitingFor: () => undefined,
    stageMockups: () => Promise.resolve(),
    keepValidation: () => Promise.resolve(),
    readReview: () =>
      Promise.resolve(JSON.stringify({ rows: [{ criterion: 'AC1', verdict: 'match', note: '' }] })),
    collectFidelity: (_s, rows) => Promise.resolve([...rows]),
    readCaptures: () => Promise.resolve(captures()),
    stageProof: (_s, proof) =>
      Promise.resolve(proof.map((p) => `- **${p.label}**: \`proof-web-1-last.png\``).join('\n')),
  };
  return { deps, sandbox, prompts, events };
}

describe('validation covers every criterion and the proof (A1650)', () => {
  it('sends the capturing session back once for what it left out', async () => {
    let calls = 0;
    const t = fake(() =>
      JSON.stringify({
        captures:
          calls++ === 0
            ? [
                {
                  criterion: 'AC1 When Settings opens on the Mac',
                  platform: 'web',
                  screenshot: 'ac1-mac.png',
                },
              ]
            : [
                {
                  criterion: 'AC1 When Settings opens on the Mac',
                  platform: 'mac',
                  screenshot: 'ac1-mac.png',
                },
                { criterion: 'AC2 the dashboard', platform: 'web', screenshot: 'ac2.png' },
              ],
      }),
    );
    const v = await validate(t.deps, t.sandbox, 'factory/1-x', {
      plan: PLAN,
      platforms: ['web', 'mac'],
      proof: [
        { label: 'web: Privacy is last', phase: 'after', source: 'harness', image: 'web-1.png' },
      ],
    });
    expect(v.ok).toBe(true);
    // Capture, capture again for what was missing, then review: the walkthrough runs between.
    expect(t.prompts).toHaveLength(3);
    expect(t.prompts[1]).toMatch(
      /## Criteria you left out[\s\S]*AC1: it is about the Mac app[\s\S]*AC2: no capture at all/,
    );
    expect(t.events).toContainEqual(['validation-incomplete', { missing: 2 }]);
    expect(t.prompts[2]).toContain('- **web: Privacy is last**: `proof-web-1-last.png`');
  });

  it('asks nothing more when every criterion is captured', async () => {
    const t = fake(() =>
      JSON.stringify({
        captures: [
          {
            criterion: 'AC1 When Settings opens on the Mac',
            platform: 'web',
            screenshot: 'ac1.png',
          },
          { criterion: 'AC2 the dashboard', platform: 'web', screenshot: 'ac2.png' },
        ],
      }),
    );
    await validate(t.deps, t.sandbox, 'factory/1-x', { plan: PLAN, platforms: ['web'] });
    expect(t.prompts).toHaveLength(2);
    expect(t.prompts[1]).toContain('None was recorded for this change.');
  });
});
