import { describe, expect, it } from 'vitest';
import { excerpt } from '../src/run.ts';

describe("the gate's feedback on a failed check (A1250)", () => {
  it('puts the error lines above the tail when the tail has none', () => {
    const lint = [
      'task: [lint] pnpm exec eslint .',
      '/repo/site/src/site.ts',
      '  12:3  error  Unsafe member access .glob on an `error` typed value',
      ...Array.from({ length: 40 }, (_, i) => `  progress ${i}`),
      'task: Failed to run task "check": exit status 201',
    ].join('\n');
    const shown = excerpt(lint);
    expect(shown.split('\n')[0]).toContain('Unsafe member access');
    expect(shown).toContain('…');
    expect(shown.split('\n').at(-1)).toBe('task: Failed to run task "check": exit status 201');
  });

  it('is the tail alone when the tail already shows the errors', () => {
    const short = 'Checking formatting...\n[warn] docs/decisions.md\nexit status 1';
    expect(excerpt(short)).toBe(short);
  });
});
