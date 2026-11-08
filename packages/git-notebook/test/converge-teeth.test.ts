/**
 * The convergence checks have teeth (G0 showed it for the spike; again here for the engine): each
 * deliberate bug, made in what one clone commits, is caught: all five of G0's (logs dropped,
 * rendered files dropped, purged logs kept, no name claims, a render set that misses notes).
 */
import { describe, expect, it } from 'vitest';
import { CheckError, runOnce, type RunOptions } from './support/converge';

async function failures(
  mutate: RunOptions['mutate'],
  seeds = 12,
  bug?: RunOptions['bug'],
): Promise<number> {
  let failed = 0;
  for (let seed = 1; seed <= seeds; seed++) {
    try {
      await runOnce(seed, { ...(mutate ? { mutate } : {}), ...(bug ? { bug } : {}) });
    } catch (error) {
      if (!(error instanceof CheckError)) throw error;
      failed++;
    }
  }
  return failed;
}

describe('the checks catch deliberate bugs', () => {
  it('a writer that drops its note logs never converges with the others', async () => {
    const dropped = await failures({
      clone: 'B',
      drop: (path, bytes) =>
        bytes !== null && /\/\.penmoss\/notes\/|^\.penmoss\/notes\//.test(path),
    });
    expect(dropped).toBeGreaterThanOrEqual(10);
  });

  it('a writer that commits no rendered files leaves the head stale', async () => {
    const stale = await failures({ clone: 'B', drop: (path) => path.endsWith('.md') });
    expect(stale).toBeGreaterThanOrEqual(10);
  });

  it('a writer that never removes logs brings purged notes back', async () => {
    const back = await failures({
      clone: 'A',
      drop: (path, bytes) => bytes === null && path.includes('.penmoss/notes/'),
    });
    expect(back).toBeGreaterThanOrEqual(3);
  });

  it('a writer that stores no names moves committed files (G0: no claims)', async () => {
    // Measured: caught in 10 of these 12 seeds.
    const moved = await failures(undefined, 12, { clone: 'B', mutation: 'no-claims' });
    expect(moved).toBeGreaterThanOrEqual(8);
  });

  it('a writer whose render set misses linkers leaves stale files (G0: render set)', async () => {
    // Measured: caught in 7 of these 24 seeds (a linker must change in the same round).
    const stale = await failures(undefined, 24, { clone: 'A', mutation: 'narrow-render' });
    expect(stale).toBeGreaterThanOrEqual(4);
  });

  it('and the same seeds pass without the bug', async () => {
    expect(await failures(undefined)).toBe(0);
  });
});
