import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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

// PEN-121's Mac proof output (12 Nov 2026), trimmed: the vitest run, then Playwright's.
const fixture = (name: string) =>
  readFileSync(fileURLToPath(new URL(`fixtures/${name}`, import.meta.url)), 'utf8');
const count = (text: string, part: string) => text.split(part).length - 1;

describe("a Playwright run's failures in the feedback (A1343)", () => {
  it('keeps the failing block, call log and code frame ahead of the tail, once', () => {
    const shown = excerpt(fixture('proof-mac-pen121-poll.log'));
    const heading =
      '1) test/e2e/packaged-cli.spec.ts:435:1 › agents run the CLI bundle; Penmoss opens from the Dock and Finder while one runs';
    expect(shown).toContain(heading);
    expect(shown).toContain('Error: expect(received).toBe(expected) // Object.is equality');
    expect(shown).toContain('- Timeout 20000ms exceeded while waiting on the predicate');
    expect(shown).toContain(
      '> 149 |   await expect.poll(() => alive(pid), { timeout: 20_000 }).toBe(false);',
    );
    expect(shown).toContain(
      'at quitApp (/Users/admin/penmoss/apps/desktop/test/e2e/packaged-cli.spec.ts:149:60)',
    );
    // Ahead of the tail, and the retry's copy of the same failure left out.
    const tailStart = shown.indexOf('\n…\n');
    expect(shown.indexOf(heading)).toBeLessThan(tailStart);
    expect(shown.indexOf('Timeout 20000ms exceeded')).toBeLessThan(tailStart);
    expect(count(shown, '> 149 |')).toBe(1);
    expect(count(shown, 'Error: expect(received).toBe(expected)')).toBe(1);
    expect(shown).not.toContain('Retry #1');
    // The block ends at its first attachment: the attachments' own lines aren't in it.
    expect(shown).toContain('attachment #1: lsappinfo: the MCP server (text/plain)');
    expect(shown).not.toContain('bundleID="app.penmoss.mac.cli"');
    expect(shown.slice(tailStart)).toContain('Failed to run task "desktop:test": exit status 201');
  });

  it('keeps an error with its cause, its call log and its code frame', () => {
    const shown = excerpt(fixture('proof-mac-pen121-quit.log'));
    expect(shown).toContain(
      'Error: Penmoss (pid 44421) was still running 45 s after it was asked to quit',
    );
    expect(shown).toContain('[cause]: Error: expect(received).toBe(expected)');
    expect(shown).toContain('- Timeout 45000ms exceeded while waiting on the predicate');
    expect(shown).toContain('> 184 |     throw new Error(');
    expect(shown).toContain(
      'at quitApp (/Users/admin/penmoss/apps/desktop/test/e2e/packaged-cli.spec.ts:177:62)',
    );
    // Not the retry's pid: only the first attempt's block.
    expect(shown).not.toContain('pid 46347');
  });

  it('keeps each numbered failure, without colour codes, and caps their size', () => {
    const failure = (n: number) => [
      `  ${n}) [chromium] › comments.spec.ts:${n}:3 › test ${n} ─────────────────────────`,
      '',
      `    \u001b[31mError: expect(locator).toBeVisible() failed\u001b[39m`,
      '',
      `    Locator: getByRole('button', { name: 'Reply ${n}' })`,
      '    Expected: visible',
      '    Timeout: 5000ms',
      '',
      `    > ${n} |   await expect(page.getByRole('button')).toBeVisible();`,
      `        at /repo/apps/web/e2e/comments.spec.ts:${n}:3`,
      '',
      '    Error Context: test-results/proof-5173/comments/error-context.md',
      '',
      ...Array.from({ length: 10 }, (_, i) => `    noise ${n}.${i}`),
    ];
    const two = [
      'Running 2 tests using 1 worker',
      ...failure(1),
      ...failure(2),
      '  2 failed',
      ...Array.from({ length: 40 }, (_, i) => `  tail ${i}`),
    ].join('\n');
    const shown = excerpt(two);
    expect(shown).toContain('1) [chromium] › comments.spec.ts:1:3 › test 1');
    expect(shown).toContain("Locator: getByRole('button', { name: 'Reply 2' })");
    expect(shown).toContain('at /repo/apps/web/e2e/comments.spec.ts:2:3');
    expect(shown).not.toContain('\u001b[');
    expect(shown).not.toContain('noise 1.0');
    expect(shown).not.toContain('─');

    const many = [...Array.from({ length: 400 }, (_, i) => failure(i + 1)).flat(), '  400 failed'];
    const capped = excerpt(many.join('\n'));
    expect(capped.length).toBeLessThan(20_000);
    expect(capped).toMatch(/… and \d+ more failures, in the whole output/);
  });
});
