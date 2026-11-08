/**
 * Convergence (T50 G1, #149's property test; G0's `converge.mjs`, CI-sized): 200 fixed seeds of
 * three clones (two devices, an agent) making random offline edits (text, renames, moves, folder
 * ops, Trash and restore, folder Trash, tags, attachments, Delete for good, the same daily note)
 * and syncing in random orders, with interleaved pushes rejected and rebuilt, crashes between
 * commit and push, lost pushes and a copied profile. Every writer ends with identical docs and
 * every render equals the head. In CI the seeds move on with each run (`GITHUB_RUN_NUMBER`), so
 * every run tries new ones; the range is in the suite's name, and `CONVERGE_FROM`/`CONVERGE_RUNS`
 * replay any range locally.
 */
import { describe, expect, it } from 'vitest';
import { runOnce, type RunSummary } from './support/converge';

const runs = Number(process.env['CONVERGE_RUNS'] ?? 200);
const rotation = Number(process.env['GITHUB_RUN_NUMBER'] ?? 0) * runs;
const from = Number(process.env['CONVERGE_FROM'] ?? 1 + rotation);
const seeds = Array.from({ length: runs }, (_, i) => from + i);

describe(`per-writer logs converge (root target, seeds ${from}–${from + runs - 1})`, () => {
  const totals: RunSummary[] = [];
  it.each(seeds)('seed %i', async (seed) => {
    totals.push(await runOnce(seed));
  });
  it('exercised every scenario', () => {
    const sum = (key: keyof RunSummary) => totals.reduce((n, t) => n + (t[key] as number), 0);
    expect(sum('rejected')).toBeGreaterThan(0);
    expect(sum('crashes')).toBeGreaterThan(0);
    expect(sum('lostPushes')).toBeGreaterThan(0);
    expect(sum('rollbacks')).toBe(totals.length);
    expect(sum('purges')).toBeGreaterThan(0);
    expect(sum('copies')).toBe(totals.length);
    expect(sum('newWriters')).toBeGreaterThanOrEqual(totals.length);
  });
});

// Seeds that once failed, run on every run. 90667 (CI run 453, A1148): a writer applied the agent's
// file before the copied profile's, which held a struct the agent's depended on; @y/y rc.29 dropped
// the agent's struct for good, and the writer and the agent rendered the same note differently on
// every sync.
describe('per-writer logs converge (seeds that found bugs)', () => {
  it.each([90667])('seed %i', async (seed) => {
    await runOnce(seed);
  });
});
