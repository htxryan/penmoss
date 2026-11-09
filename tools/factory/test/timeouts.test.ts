/**
 * Every factory suite that runs real git or real processes gives them 30 s, not vitest's 5 s
 * default: under the Mac's load (W12, load averages of 30 to 50) seven such tests timed out in
 * PEN-75's run while their code was fine (A1243).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const dir = fileURLToPath(new URL('.', import.meta.url));
const REAL = /\b(?:nodeExec|spawn|spawnSync|execFileSync|execSync)\(/;

describe('real-process suites have room under load', () => {
  it('give their real git and processes 30 s', () => {
    const short = readdirSync(dir)
      .filter((f) => f.endsWith('.test.ts'))
      .filter((f) => {
        const text = readFileSync(join(dir, f), 'utf8');
        return REAL.test(text) && !text.includes('timeout: 30_000');
      });
    expect(short).toEqual([]);
  });
});
