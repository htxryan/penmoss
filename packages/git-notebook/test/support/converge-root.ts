/**
 * Convergence of a notebook at the repository's root (T50 G1, #149's property test; G0's
 * `converge.mjs`, CI-sized): 200 seeds of three clones (two devices, an agent) making random
 * offline edits (text, renames, moves, folder ops, Trash and restore, folder Trash, tags,
 * attachments, Delete for good, the same daily note) and syncing in random orders, with
 * interleaved pushes rejected and rebuilt, crashes between commit and push, lost pushes and a
 * copied profile. Every writer ends with identical docs and every render equals the head.
 *
 * The 200 run as two files of 100 (`converge.test.ts`, `converge-2.test.ts`), so two workers
 * share them (A1517); each half checks it met every scenario (each is met in over 98% of seeds).
 * In CI the seeds move on with each run (`GITHUB_RUN_NUMBER`), so every run tries new ones; the
 * range is in the suite's name, and `CONVERGE_FROM`/`CONVERGE_RUNS` replay any range locally.
 */
import { describe, expect, it } from 'vitest';
import { runOnce, type RunSummary } from './converge';

const runs = Number(process.env['CONVERGE_RUNS'] ?? 200);
const rotation = Number(process.env['GITHUB_RUN_NUMBER'] ?? 0) * runs;
const from = Number(process.env['CONVERGE_FROM'] ?? 1 + rotation);

/** Half `part` (0 or 1) of the seeds: the first or the second. */
export function convergeHalf(part: 0 | 1): void {
  const half = Math.ceil(runs / 2);
  const first = from + part * half;
  const count = part === 0 ? half : runs - half;
  if (count === 0) {
    it('has no seeds of its own: CONVERGE_RUNS is under 2', () => expect(runs).toBeLessThan(2));
    return;
  }
  const seeds = Array.from({ length: count }, (_, i) => first + i);
  describe(`per-writer logs converge (root target, seeds ${first}–${first + count - 1})`, () => {
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
}
