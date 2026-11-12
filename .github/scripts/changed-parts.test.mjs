// Which parts a change touches (A1095) and whether it ships (A1349, PEN-128):
// .github/scripts/changed-parts.sh on file lists, and the ci.yml jobs that use it. Part of
// `task workflows:test`.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(here, 'changed-parts.sh');
const CI = path.join(here, '..', 'workflows', 'ci.yml');

/** The parts the script reports for these changed files. */
function parts(files, args = []) {
  const r = spawnSync('bash', [SCRIPT, ...args], {
    input: files.join('\n') + '\n',
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  return Object.fromEntries(
    r.stdout
      .trim()
      .split('\n')
      .map((line) => line.split('='))
      .map(([k, v]) => [k, v === 'true']),
  );
}

describe('what ships', () => {
  it("a merge of CI, the Taskfile or the lint configs builds everything, and ships nothing (build-1292's #171)", () => {
    const p = parts([
      '.github/workflows/ci.yml',
      '.github/scripts/runner-policy.mjs',
      '.github/actions/setup/action.yml',
      'Taskfile.yml',
      'docs/ci.md',
      'docs/decisions.md',
    ]);
    assert.equal(p.ships, false);
    assert.equal(p.desktop, true);
    assert.equal(p.android, true);
    for (const file of [
      'package.json',
      'eslint.config.js',
      '.prettierrc.json',
      'pnpm-workspace.yaml',
      '.node-version',
    ]) {
      assert.equal(parts([file]).ships, false, file);
    }
  });

  it("a merge of tests alone tests the apps, and ships nothing (build-1278's #159)", () => {
    const tests = [
      'apps/web/test/unit/engine-host.test.ts',
      'apps/desktop/test/e2e/mac-window.spec.ts',
      'apps/android/editor/test/git-page.test.ts',
      'packages/cli/test/notebook.test.ts',
      'packages/editor/src/lists.test.ts',
      'apps/android/app/src/test/java/app/penmoss/SyncTest.kt',
      'apps/android/app/src/androidTest/java/app/penmoss/TypingInstrumentedTest.kt',
      'apps/web/playwright.config.ts',
      'packages/core/vitest.config.ts',
      'apps/desktop/test/fixtures/notes/a.md',
    ];
    for (const file of tests) assert.equal(parts([file]).ships, false, file);
    const p = parts(tests);
    assert.equal(p.desktop, true);
    assert.equal(p.web, true);
  });

  it('docs, the site, the factory, the relay and scripts ship nothing', () => {
    for (const file of [
      'docs/architecture.md',
      'site/src/pages/index.astro',
      'tools/factory/src/run.ts',
      'apps/relay/src/index.ts',
      'scripts/vm/desktop-test.sh',
      'apps/android/play/upload.mjs',
      '.claude/skills/factory-foreman/SKILL.md',
    ]) {
      assert.equal(parts([file]).ships, false, file);
    }
  });

  it('what the apps are built from ships: their source, their build configuration, and the lockfile', () => {
    for (const file of [
      'apps/desktop/src/main.ts',
      'apps/desktop/electron-builder.config.cjs',
      'apps/desktop/scripts/cli-bundle.mjs',
      'apps/web/src/App.tsx',
      'apps/web/package.json',
      'packages/editor/src/lists.ts',
      'packages/ui/src/toast.css',
      'packages/cli/src/cli.ts',
      'packages/embed/src/manifest.ts',
      'apps/android/app/src/main/java/app/penmoss/MainActivity.kt',
      'apps/android/app/build.gradle.kts',
      'apps/android/editor/src/page.ts',
      'pnpm-lock.yaml',
    ]) {
      assert.equal(parts([file]).ships, true, file);
    }
  });

  it('one shipping file among CI and test changes ships the build', () => {
    const p = parts([
      '.github/workflows/ci.yml',
      'apps/web/test/e2e/a.spec.ts',
      'apps/web/src/App.tsx',
    ]);
    assert.equal(p.ships, true);
  });

  it('a list GitHub could not give ships, as it builds everything', () => {
    assert.deepEqual(parts([], ['--all']), {
      check: true,
      web: true,
      android: true,
      desktop: true,
      site: true,
      ships: true,
    });
  });

  it('an empty list runs and ships nothing', () => {
    const p = parts([]);
    assert.ok(Object.values(p).every((v) => v === false));
  });

  it('keeps which jobs a change runs (A1095)', () => {
    assert.deepEqual(parts(['apps/android/app/src/main/java/A.kt']), {
      check: false,
      web: false,
      android: true,
      desktop: false,
      site: false,
      ships: true,
    });
    assert.deepEqual(parts(['site/src/pages/index.astro']), {
      check: false,
      web: false,
      android: false,
      desktop: false,
      site: true,
      ships: false,
    });
    assert.deepEqual(parts(['packages/cli/src/cli.ts']), {
      check: true,
      web: false,
      android: false,
      desktop: true,
      site: false,
      ships: true,
    });
  });
});

describe('ci.yml', () => {
  const ci = readFileSync(CI, 'utf8');
  const job = (name) => {
    const start = ci.indexOf(`\n  ${name}:\n`);
    assert.ok(start > 0, name);
    const next = ci.slice(start + 1).search(/\n {2}[a-z][\w-]*:\n/);
    return ci.slice(start, next < 0 ? undefined : start + 1 + next);
  };

  it("pick's classifier is the script, and pick reports ships", () => {
    const pick = job('pick');
    assert.match(pick, /bash \.github\/scripts\/changed-parts\.sh/);
    assert.match(pick, /ships: \$\{\{ steps\.changes\.outputs\.ships \}\}/);
    assert.match(pick, /sparse-checkout: \.github\/scripts/);
  });

  it('main publishes a build only when it ships', () => {
    for (const name of ['android-release', 'mac-release']) {
      const j = job(name);
      assert.match(j, /needs\.pick\.outputs\.ships == 'true'/, name);
      assert.match(j, /needs: \[pick, /, name);
    }
  });
});
