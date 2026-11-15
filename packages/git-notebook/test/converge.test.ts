/**
 * Convergence at the repository's root, the first half of the seeds (`support/converge-root.ts`
 * says what each seed does; `converge-2.test.ts` runs the second half), and the seeds that once
 * failed.
 */
import { describe, it } from 'vitest';
import { runOnce } from './support/converge';
import { convergeHalf } from './support/converge-root';

convergeHalf(0);

// Seeds that once failed, run on every run. 90667 (CI run 453, A1148): a writer applied the agent's
// file before the copied profile's, which held a struct the agent's depended on; @y/y rc.29 dropped
// the agent's struct for good, and the writer and the agent rendered the same note differently on
// every sync.
describe('per-writer logs converge (seeds that found bugs)', () => {
  it.each([90667])('seed %i', async (seed) => {
    await runOnce(seed);
  });
});
