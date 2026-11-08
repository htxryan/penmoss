import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { takeHeavySlot, withHeavySlot } from '../src/heavy.ts';

const fresh = () => mkdtempSync(join(tmpdir(), 'heavy-'));

describe('heavy-job slots from the host (W12)', () => {
  it("writes heavy.sh's owner file and frees the slot afterwards", async () => {
    const dir = fresh();
    await withHeavySlot(
      'factory gate #5',
      '/wt',
      async () => {
        expect(readFileSync(join(dir, 'slot-1', 'owner'), 'utf8')).toBe(
          `${process.pid}\nfactory gate #5\n/wt\n`,
        );
        return Promise.resolve();
      },
      { dir },
    );
    expect(existsSync(join(dir, 'slot-1'))).toBe(false);
  });

  it('takes the next slot, and waits when all are held by live jobs', async () => {
    const dir = fresh();
    for (const i of [1, 2]) {
      mkdirSync(join(dir, `slot-${i}`));
      writeFileSync(join(dir, `slot-${i}`, 'owner'), `${100 + i}\ncheck\n/other\n`);
    }
    let waited: string[] = [];
    let sleeps = 0;
    const release = await takeHeavySlot('gate', '/wt', {
      dir,
      // Not the environment's: a factory sandbox sets PENMOSS_HEAVY_SLOTS=1.
      slots: 2,
      alive: (pid) => pid === 101 || (pid === 102 && sleeps < 2),
      sleep: () => Promise.resolve(void sleeps++),
      onWait: (h) => (waited = h),
    });
    expect(waited).toEqual(['check /other', 'check /other']);
    expect(sleeps).toBe(2);
    expect(readFileSync(join(dir, 'slot-2', 'owner'), 'utf8')).toContain('gate');
    release();
  });
});
