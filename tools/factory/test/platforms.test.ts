import { describe, expect, it } from 'vitest';
import { classify, proofPlatforms, ruleFor, SCOPE_RULES, scopeText } from '../src/platforms.ts';

const ALL = ['web', 'mac', 'android'];

describe('classify (Platform scope table)', () => {
  it.each([
    // Row: packages/**, lockfile, root config → all three
    [['packages/core/src/note.ts'], 'product', ALL],
    [['pnpm-lock.yaml'], 'product', ALL],
    [['package.json'], 'product', ALL],
    [['tsconfig.base.json'], 'product', ALL],
    [['Taskfile.yml'], 'product', ALL],
    // Row: apps/web/** → all three (Mac bundles the web build; Android imports its styles)
    [['apps/web/src/editor.tsx'], 'product', ALL],
    // The relay stands where apps/server stood: every client syncs through it
    [['apps/relay/src/index.ts'], 'product', ALL],
    // Row: apps/desktop/** → Mac only
    [['apps/desktop/src/main.ts'], 'product', ['mac']],
    // Row: apps/android/** → Android only
    [['apps/android/app/src/main/AndroidManifest.xml'], 'product', ['android']],
    // Row: docs/**, tasks/**, *.md only → docs-only
    [['docs/decisions.md', 'tasks/x.html', 'README.md', 'apps/web/NOTES.md'], 'docs-only', []],
    // Markdown test input is not prose: it goes with its tests (A-NEW-2)
    [['packages/core/test/fixtures/callouts.md'], 'ci-only', []],
    [['apps/web/test/e2e/data/note.md'], 'ci-only', []],
    // ... and a fixtures directory outside a test directory follows its own row
    [['packages/core/fixtures/callouts.md'], 'product', ALL],
    // Row: .github/**, tools/factory/** → ci-only
    [['.github/workflows/ci.yml'], 'ci-only', []],
    [['tools/factory/src/pick.ts', 'docs/factory.md'], 'ci-only', []],
    [['site/index.html'], 'ci-only', []],
    // Tests alone ship in no app → ci-only, wherever they are (A-NEW-2)
    [['packages/cli/test/notebook.test.ts'], 'ci-only', []],
    [['packages/core/test/support/checkout-ports.ts'], 'ci-only', []],
    [['apps/web/e2e/foo.spec.ts'], 'ci-only', []],
    [['apps/web/test/e2e/tooltip-delay.spec.ts', 'apps/web/test/unit/a.test.tsx'], 'ci-only', []],
    [['apps/desktop/test/e2e/x.spec.ts'], 'ci-only', []],
    [['apps/relay/test/sync.test.ts'], 'ci-only', []],
    [['apps/web/src/editor.test.tsx', 'packages/ui/src/__tests__/icon.ts'], 'ci-only', []],
    [
      ['apps/android/app/src/androidTest/java/app/penmoss/TypingInstrumentedTest.kt'],
      'ci-only',
      [],
    ],
    [['apps/android/app/src/test/java/app/penmoss/NoteTest.kt'], 'ci-only', []],
    [['apps/android/editor/test/page.test.mjs'], 'ci-only', []],
    // ... but a test beside the code it tests leaves that code's row standing
    [['apps/desktop/test/e2e/x.spec.ts', 'apps/desktop/src/main.ts'], 'product', ['mac']],
    [['packages/cli/test/notebook.test.ts', 'packages/cli/src/notebook.ts'], 'product', ALL],
    // A name that only looks like a test is code
    [['apps/web/src/testing.ts', 'packages/core/src/latest/a.ts'], 'product', ALL],
    [['packages/core/src/api.spec.json'], 'product', ALL],
    // The root scripts are tooling → ci-only (A-NEW-2) ...
    [['scripts/check-changed.sh'], 'ci-only', []],
    [['scripts/vm/desktop-test.sh', 'scripts/heavy.sh'], 'ci-only', []],
    [['scripts/brand-assets.mjs'], 'ci-only', []],
    // ... except the ports, which the web app's Vite config (its build) imports
    [['scripts/ports.mjs'], 'product', ALL],
    [['scripts/ports.d.mts'], 'product', ALL],
    // Unknown paths → all three
    [['some/new/thing.txt'], 'product', ALL],
    [['prototype/index.html'], 'product', ALL],
  ])('%j → %s %j', (paths, kind, platforms) => {
    expect(classify(paths)).toEqual({ kind, platforms });
  });

  it('unions platforms across paths, in a fixed order', () => {
    expect(classify(['apps/android/build.gradle.kts', 'apps/desktop/package.json'])).toEqual({
      kind: 'product',
      platforms: ['mac', 'android'],
    });
  });

  it('lets a product path win over docs and CI paths', () => {
    expect(classify(['docs/a.md', '.github/x.yml', 'apps/desktop/src/a.ts']).kind).toBe('product');
  });

  it('accepts ./-prefixed paths', () => {
    expect(ruleFor('./apps/desktop/a.ts')).toBe('mac');
  });

  it('does not treat a directory name prefix as the directory', () => {
    expect(ruleFor('apps/website/a.ts')).toBe('all');
    expect(ruleFor('docsite/a.ts')).toBe('all');
    expect(ruleFor('scriptsx/a.sh')).toBe('all');
    expect(ruleFor('packages/core/src/contest/a.ts')).toBe('all');
    expect(ruleFor('packages/core/src/e2ee/a.ts')).toBe('all');
  });
});

describe('proofPlatforms', () => {
  it('uses platform:* labels when present', () => {
    expect(
      proofPlatforms({ kind: 'product', platforms: ['web', 'mac', 'android'] }, ['web']),
    ).toEqual(['web']);
  });
  it('falls back to the classifier', () => {
    expect(proofPlatforms({ kind: 'product', platforms: ['mac'] }, null)).toEqual(['mac']);
  });
  it('needs no proof for docs-only or ci-only changes', () => {
    expect(proofPlatforms({ kind: 'docs-only', platforms: [] }, ['web'])).toEqual([]);
    expect(proofPlatforms({ kind: 'ci-only', platforms: [] }, null)).toEqual([]);
  });
});

describe("the build prompt's scope (A1254)", () => {
  it('states each rule as the classifier applies it', () => {
    for (const rule of SCOPE_RULES)
      expect(classify([rule.example]).platforms, rule.example).toEqual(rule.platforms);
  });
  it('tells an unlabelled card that the classifier, not the plan, sets the proof platforms', () => {
    const text = scopeText(null);
    expect(text).toContain('`packages/`, `apps/web/`');
    expect(text).toContain('web, Mac and Android');
    expect(text).toContain("even when the plan says a platform doesn't change");
    // A-NEW-2: a branch of tests alone needs no product proof.
    expect(text).toContain('Tests anywhere: files in a `test/`');
    expect(text).toContain('`scripts/ports.mjs` (the web build reads it)');
    expect(text).toContain('before you start');
  });
  it('names the labelled platforms as the only ones', () => {
    expect(scopeText(['web', 'mac'])).toContain('labelled for web, mac');
  });
});
