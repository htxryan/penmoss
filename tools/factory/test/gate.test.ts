import { describe, expect, it } from 'vitest';
import {
  parsePatch,
  scanWeakenedTests,
  weakenedFeedback,
  workflowChanges,
  workflowFeedback,
} from '../src/gate.ts';

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
  it('passes a skip on the platform alone in a spec the branch adds, and nowhere else (PEN-67)', () => {
    const created = (file: string, lines: string) =>
      `diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1 @@\n${lines}\n`;
    const dock = 'apps/desktop/test/e2e/dock.spec.ts';
    expect(scanWeakenedTests(created(dock, "+test.skip(!mac, 'Minimizing is macOS’s');"))).toEqual(
      [],
    );
    expect(
      scanWeakenedTests(
        created(dock, "+it.skipIf(process.platform !== 'darwin')('restores', () => {"),
      ),
    ).toEqual([]);
    // A skip on anything else, even in a new spec, still counts.
    expect(
      scanWeakenedTests(created(dock, "+test.skip('restores', async () => {")).map((f) => f.what),
    ).toEqual(['skips a test']);
    // An existing spec made one platform's only hides its failures elsewhere.
    expect(
      scanWeakenedTests(patch(dock, "+test.skip(!mac, 'Minimizing is macOS’s');")).map(
        (f) => f.what,
      ),
    ).toEqual(['skips a test']);
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
      { file: 'a.ts', added: ['x'], removed: ['y'], created: false },
    ]);
  });
  it('tells the agent what to do', () => {
    expect(
      weakenedFeedback([{ file: 'a.spec.ts', what: 'skips a test', line: 'test.skip(' }]),
    ).toContain('A-NEW-n');
  });
});

describe("the gate's refusal of workflow changes (A1314)", () => {
  it('names each workflow file the branch changes, adds, deletes or renames', () => {
    const p =
      patch(
        '.github/workflows/ci.yml',
        '+          for i in 1 2 3; do apt-get update && break; done',
      ) +
      patch('site/src/pages/index.astro', '+<p>hi</p>') +
      'diff --git a/.github/workflows/old.yml b/.github/old.yml\nsimilarity index 100%\n' +
      'diff --git a/.github/workflows/new.yml b/.github/workflows/new.yml\nnew file mode 100644\n';
    expect(workflowChanges(p)).toEqual([
      '.github/workflows/ci.yml',
      '.github/workflows/old.yml',
      '.github/workflows/new.yml',
    ]);
  });
  it('lets everything else through, the CI scripts the workflows call included', () => {
    expect(workflowChanges(patch('.github/scripts/mac-runner.sh', '+echo'))).toEqual([]);
    expect(workflowChanges(patch('docs/ci.md', '+.github/workflows/ci.yml'))).toEqual([]);
  });
  it("tells the agent the factory can't push it, and what to do", () => {
    const text = workflowFeedback(['.github/workflows/ci.yml']);
    expect(text).toContain('`.github/workflows/ci.yml`');
    expect(text).toContain("the factory can't push");
    expect(text).toContain('`git diff origin/main...HEAD -- .github/workflows/`');
    expect(text).toContain('status `failed`');
  });
});
