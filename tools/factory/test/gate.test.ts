import { describe, expect, it } from 'vitest';
import { parsePatch, scanWeakenedTests, weakenedFeedback } from '../src/gate.ts';

const patch = (file: string, lines: string) =>
  `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n${lines}\n`;

describe('the scan for weakened tests (F13)', () => {
  it('flags an added test.skip in a test file', () => {
    const f = scanWeakenedTests(
      patch('apps/web/test/e2e/tags.spec.ts', "+test.skip('collapses', async () => {"),
    );
    expect(f).toEqual([
      {
        file: 'apps/web/test/e2e/tags.spec.ts',
        what: 'skips a test',
        line: "test.skip('collapses', async () => {",
      },
    ]);
  });
  it('flags .only, fixme, @Ignore and assumptions', () => {
    const p = [
      patch(
        'packages/core/test/a.test.ts',
        "+  it.only('x', () => {})\n+  test.fixme('y', () => {})",
      ),
      patch(
        'apps/android/app/src/test/kotlin/FooTest.kt',
        '+    @Ignore\n+    Assume.assumeTrue(false)',
      ),
    ].join('');
    expect(scanWeakenedTests(p).map((x) => x.what)).toEqual([
      'focuses a test (the rest stop running)',
      'marks a test fixme, todo or expected to fail',
      'disables a JVM test',
      'skips a JVM test by assumption',
    ]);
  });
  it('flags runner settings that let failures through, in any file', () => {
    const p =
      patch('apps/web/playwright.config.ts', '+  retries: 3,') +
      patch('Taskfile.yml', '+      - pnpm test --passWithNoTests');
    expect(scanWeakenedTests(p).map((x) => x.what)).toEqual([
      'adds retries, which hide flaky failures',
      'lets a suite pass with no tests',
    ]);
  });
  it('flags a test file that loses assertions', () => {
    const p = patch(
      'packages/core/test/b.test.ts',
      '-  expect(a).toBe(1);\n-  expect(b).toBe(2);\n+  expect(a).toBe(1);',
    );
    expect(scanWeakenedTests(p)).toEqual([
      { file: 'packages/core/test/b.test.ts', what: 'removes 1 assertion more than it adds' },
    ]);
  });
  it('passes a skip that an added decision names', () => {
    const p =
      patch('apps/web/test/e2e/tags.spec.ts', "+test.skip('collapses', async () => {") +
      patch('docs/decisions.md', '+| A-NEW-1 | tags.spec.ts: the collapse test waits for #400 |');
    expect(scanWeakenedTests(p)).toEqual([]);
  });
  it('ignores comments, source files and rewritten assertions', () => {
    const p =
      patch(
        'packages/core/test/c.test.ts',
        "+  // don't use test.skip here\n-  expect(x).toBe(1)\n+  expect(x).toEqual(1)",
      ) + patch('packages/core/src/skip.ts', '+export const skip = () => describe.skip;');
    expect(scanWeakenedTests(p)).toEqual([]);
  });
  it('reads files, added and removed lines from a diff', () => {
    expect(parsePatch(patch('a.ts', '+x\n-y'))).toEqual([
      { file: 'a.ts', added: ['x'], removed: ['y'] },
    ]);
  });
  it('tells the agent what to do', () => {
    expect(
      weakenedFeedback([{ file: 'a.spec.ts', what: 'skips a test', line: 'test.skip(' }]),
    ).toContain('A-NEW-n');
  });
});
