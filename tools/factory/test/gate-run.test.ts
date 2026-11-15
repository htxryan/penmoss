import { describe, expect, it } from 'vitest';
import type { AgentResult } from '../src/result.ts';
import { gateCommand, oneLine, proofReason } from '../src/gate-run.ts';
import { runImplement } from '../src/run.ts';
import type { RunDeps } from '../src/run-deps.ts';
import { parseProven, PROVEN, provenRuns } from '../src/carry.ts';
import { card, spec, done, type Fake, fake } from './run-fake.ts';

describe("the gate's words", () => {
  it('gates docs with lint and everything else with task check', () => {
    expect(gateCommand({ kind: 'docs-only', platforms: [] })).toBe('task lint');
    expect(gateCommand({ kind: 'ci-only', platforms: [] })).toBe('task check');
  });

  it('says which proof tests failed, by platform, and keeps a reason to one line', () => {
    expect(
      proofReason([
        'mac: packaged-cli.spec.ts › the CLI opens the app',
        'mac: packaged-cli.spec.ts › it reopens',
        'web: comments.spec.ts › AC1',
      ]),
    ).toBe(
      'mac proof: 2 failed (packaged-cli.spec.ts › the CLI opens the app, …); web proof: 1 failed (comments.spec.ts › AC1)',
    );
    expect(oneLine('`task check`\n  failed:\n\nerror')).toBe('`task check` failed: error');
    expect(oneLine('x'.repeat(300))).toHaveLength(200);
    expect(oneLine('x'.repeat(300)).endsWith('…')).toBe(true);
  });
});

describe('proof and validation carried over from an earlier run (PEN-63)', () => {
  // PEN-63's recovered run rebased because another PR's decision row landed beside its own, then
  // recorded web, Mac and Android proof and validated for about 19 minutes, on changes that were
  // byte for byte the ones already proved and validated.
  const RAW = [
    `:100644 100644 ${'1'.repeat(40)} ${'2'.repeat(40)} M\tapps/web/src/a.ts`,
    `:000000 100644 ${'0'.repeat(40)} ${'3'.repeat(40)} A\tapps/web/test/e2e/a.spec.ts`,
  ].join('\n');
  const result: AgentResult = {
    ...done,
    platforms: {
      web: { inScope: true, proofSpecs: ['comments.spec.ts'] },
      mac: { inScope: true, proofSpecs: ['app.spec.ts'] },
      android: { inScope: true, proofSpecs: ['app.penmoss.EditorScreenTest'] },
    },
  };
  const review = (verdict: string, note = '') =>
    JSON.stringify({
      rows: [
        {
          criterion: 'AC1 the snackbar says so once',
          verdict,
          note,
          mockup: 'ac1-mockup.png',
          screenshot: 'ac1.png',
        },
      ],
    });
  const plan = 'AC1 the snackbar says so once';

  /** A run whose kept files and ledger lines are collected, and whose PR input is seen. */
  function run(f: Fake, runId: string, earlier?: { kept: Map<string, string>; ledger: string[] }) {
    const kept = new Map<string, string>();
    const ledger: string[] = [];
    const prs: Parameters<RunDeps['openPr']>[0][] = [];
    const deps: RunDeps = {
      ...f.deps,
      runId,
      keep: (name, text) => void kept.set(name, text),
      log: (event, detail) => {
        f.deps.log(event, detail);
        ledger.push(JSON.stringify({ at: 'x', run: runId, event, ...detail }));
      },
      openPr: (pr) => {
        prs.push(pr);
        return f.deps.openPr(pr);
      },
      // As the host finds it (findProven): the ledger's candidates, then their proven.json.
      ...(earlier
        ? {
            provenBefore: (diff: string) => {
              const text = earlier.kept.get(PROVEN);
              const record = text ? parseProven(text) : undefined;
              const runs = provenRuns(earlier.ledger.join('\n'), 42, diff, runId);
              return record && runs.includes(record.run) ? record : undefined;
            },
          }
        : {}),
    };
    return { deps, kept, ledger, prs };
  }
  const recovered = { recovered: true, resume: { run: '42-old', result } } as const;

  async function firstRun() {
    const f = fake({ paths: ['apps/web/src/a.ts'], result, raw: RAW, reviews: [review('match')] });
    const r = run(f, '42-old');
    const outcome = await runImplement(r.deps, { item: card, spec, prompt: 'p', plan });
    expect(outcome.kind).toBe('in-review');
    return { f, ...r };
  }

  it("keeps what passed, with the print of the branch's own diff", async () => {
    const first = await firstRun();
    const record = parseProven(first.kept.get(PROVEN) ?? '');
    expect(record?.diff).toMatch(/^[0-9a-f]{64}$/);
    expect(record).toMatchObject({
      run: '42-old',
      specs: {
        web: ['comments.spec.ts'],
        mac: ['app.spec.ts'],
        android: ['app.penmoss.EditorScreenTest'],
      },
      validation: { rows: [{ verdict: 'match' }] },
    });
    expect(record?.proof).toHaveLength(3);
    // The ledger's proof-recorded names the same print, for a later run to find.
    expect(first.f.details).toContainEqual(['proof-recorded', { files: 3, diff: record?.diff }]);
  });

  it("reuses the earlier run's proof and verdict when the branch's own diff is unchanged", async () => {
    const first = await firstRun();
    // The recovered run: its rebase moved only docs/decisions.md, so the print is the same.
    const f = fake({ paths: ['apps/web/src/a.ts'], result, raw: RAW, reviews: [review('match')] });
    const again = run(f, '42-new', first);
    const outcome = await runImplement(again.deps, {
      item: card,
      spec,
      prompt: 'p',
      plan,
      ...recovered,
    });
    expect(outcome.kind).toBe('in-review');
    // The gate still ran; no proof was recorded and no validation session ran.
    expect(f.calls).toContain('exec 1: task check');
    expect(f.calls.filter((c) => c.startsWith('proof '))).toEqual([]);
    expect(f.calls).not.toContain('mockups');
    expect(f.calls.filter((c) => c.startsWith('walk '))).toEqual([]);
    expect(f.prompts).toEqual([]);
    expect(f.events).not.toContain('proof-recorded');
    expect(f.events).not.toContain('validated');
    expect(f.details).toContainEqual([
      'proof-reused',
      { from: '42-old', files: 3, diff: parseProven(first.kept.get(PROVEN) ?? '')?.diff },
    ]);
    expect(f.details).toContainEqual([
      'validation-reused',
      { from: '42-old', match: 1, mismatch: 0, deviation: 0 },
    ]);
    // The PR links the earlier run's files, says where they came from, and shows its table.
    expect(again.prs[0]?.proofFrom).toBe('42-old');
    expect(again.prs[0]?.files).toEqual(['ac1-mockup.png', 'ac1.png']);
    const body = again.prs[0]?.body ?? '';
    expect(body).toContain('Carried over from run `42-old`');
    expect(body).toContain('proof and validation passed on');
    expect(body).toContain('[▶ Watch the recording (MP4)](./web-1.mp4)');
    expect(body).toContain('| ✅ Match | ![mockup](./ac1-mockup.png) | ![screenshot](./ac1.png) |');
    // Nothing new to keep: the earlier run's record still stands.
    expect(again.kept.has(PROVEN)).toBe(false);
  });

  it('proves and validates again when anything else in the branch changed', async () => {
    const first = await firstRun();
    const changed = RAW.replace('2'.repeat(40), '4'.repeat(40));
    const f = fake({
      paths: ['apps/web/src/a.ts'],
      result,
      raw: changed,
      reviews: [review('match')],
    });
    const again = run(f, '42-new', first);
    await runImplement(again.deps, { item: card, spec, prompt: 'p', plan, ...recovered });
    expect(f.calls.filter((c) => c.startsWith('proof '))).toHaveLength(3);
    expect(f.calls).toContain('mockups');
    expect(f.events).not.toContain('proof-reused');
    expect(again.prs[0]?.proofFrom).toBeUndefined();
    expect(again.prs[0]?.body).not.toContain('Carried over');
  });

  it('proves and validates again when the plan changed', async () => {
    const first = await firstRun();
    const f = fake({ paths: ['apps/web/src/a.ts'], result, raw: RAW, reviews: [review('match')] });
    const again = run(f, '42-new', first);
    await runImplement(again.deps, {
      item: card,
      spec,
      prompt: 'p',
      plan: `${plan}, in the accent colour`,
      ...recovered,
    });
    expect(f.calls.filter((c) => c.startsWith('proof '))).toHaveLength(3);
    expect(f.events).toContain('validated');
    expect(f.events).not.toContain('proof-reused');
  });

  it('proves again when git gives no print of the diff', async () => {
    const first = await firstRun();
    const f = fake({ paths: ['apps/web/src/a.ts'], result, reviews: [review('match')] });
    const again = run(f, '42-new', first);
    await runImplement(again.deps, { item: card, spec, prompt: 'p', plan, ...recovered });
    expect(f.calls.filter((c) => c.startsWith('proof '))).toHaveLength(3);
    expect(again.kept.has(PROVEN)).toBe(false);
  });

  it('keeps only the round that passed when validation sent the change back', async () => {
    const f = fake({
      paths: ['apps/web/src/a.ts'],
      result,
      raw: RAW,
      reviews: [review('mismatch', 'Twice'), review('match')],
    });
    const r = run(f, '42-old');
    const kept: string[] = [];
    const deps: RunDeps = {
      ...r.deps,
      keep: (name, text) => {
        if (name === PROVEN) kept.push(text);
        r.deps.keep?.(name, text);
      },
    };
    await runImplement(deps, { item: card, spec, prompt: 'p', plan });
    expect(kept).toHaveLength(1);
    expect(parseProven(kept[0] ?? '')?.validation?.rows[0]?.verdict).toBe('match');
  });
});
