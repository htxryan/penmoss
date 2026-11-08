import { describe, expect, it } from 'vitest';
import { classify, proofPlatforms, ruleFor } from '../src/platforms.ts';

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
    // Markdown test input is not prose: it follows its directory's row
    [['packages/core/test/fixtures/callouts.md'], 'product', ALL],
    [['apps/web/test/e2e/data/note.md'], 'product', ALL],
    // Row: .github/**, tools/factory/** → ci-only
    [['.github/workflows/ci.yml'], 'ci-only', []],
    [['tools/factory/src/pick.ts', 'docs/factory.md'], 'ci-only', []],
    [['site/index.html'], 'ci-only', []],
    // Unknown paths → all three
    [['scripts/vm/desktop-test.sh'], 'product', ALL],
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
