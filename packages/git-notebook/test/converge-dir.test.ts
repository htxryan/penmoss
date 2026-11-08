/**
 * Convergence in a directory of a code repository (#149, G0's `--dir` runs): the same random
 * offline edits as converge.test.ts with the notebook in `docs/notes`, while a colleague commits
 * code, foreign Markdown and hand edits to rendered files on the same branch. Nothing outside the
 * directory, and no file Penmoss didn't write, ever changes; every writer still converges.
 */
import { describe, expect, it } from 'vitest';
import { runOnce, type RunSummary } from './support/converge';

const runs = Number(process.env['CONVERGE_DIR_RUNS'] ?? 100);
// In CI the seeds move on with each run, like converge.test.ts's (and apart from them).
const rotation = Number(process.env['GITHUB_RUN_NUMBER'] ?? 0) * runs;
const from = Number(process.env['CONVERGE_DIR_FROM'] ?? 1_000_001 + rotation);
const seeds = Array.from({ length: runs }, (_, i) => from + i);
/** Below this many seeds a foreign file may never take a note's name: not checked then. */
const FOREIGN_RENAME_MIN_SEEDS = 50;

describe(`per-writer logs converge (directory target, seeds ${from}–${from + runs - 1})`, () => {
  const totals: RunSummary[] = [];
  it.each(seeds)('seed %i', async (seed) => {
    totals.push(await runOnce(seed, { dir: 'docs/notes' }));
  });
  it('exercised the colleague, foreign files and hand edits', () => {
    const sum = (pick: (t: RunSummary) => number) => totals.reduce((n, t) => n + pick(t), 0);
    expect(sum((t) => t.colleague)).toBeGreaterThan(0);
    expect(sum((t) => t.handEdits)).toBeGreaterThan(0);
    if (runs >= FOREIGN_RENAME_MIN_SEEDS) expect(sum((t) => t.renames.foreign)).toBeGreaterThan(0);
    expect(sum((t) => t.rejected)).toBeGreaterThan(0);
  });
});
