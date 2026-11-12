/**
 * The path classifier (Platform scope in the factory plan): which platforms a
 * set of changed paths can affect, and so which need product proof. The
 * harness gate uses it; CI's `pick` job (ci.yml) has its own path rules, which
 * still run a test-only change's tests. It errs wide: a path no rule
 * recognises puts all three platforms in scope. A path only tests read, and
 * the root `scripts/`, change nothing that ships, so they are CI's alone
 * (A1329).
 */
import { PLATFORMS, type Platform } from './config.ts';

/**
 * - `product`: at least one platform needs proof.
 * - `ci-only`: the gate's `task check` plus the full CI run, no product proof: CI, the
 *   factory, the site, the root `scripts/`, and tests alone.
 * - `docs-only`: lint only, no proof.
 */
export type ScopeKind = 'product' | 'ci-only' | 'docs-only';

export interface Scope {
  readonly kind: ScopeKind;
  readonly platforms: readonly Platform[];
}

type Rule = 'all' | 'docs' | 'ci' | Platform;

/** Root files that every package builds with. */
const ROOT_CONFIG = new Set([
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig.base.json',
  'eslint.config.js',
  'stylelint.config.js',
  'Taskfile.yml',
  '.npmrc',
  '.nvmrc',
  '.prettierrc',
  '.prettierignore',
]);

/** A directory whose files tests read. */
const TEST_DATA = /(^|\/)(test|tests|e2e|fixtures|__fixtures__)\//;

/**
 * A path only tests read: anything in a test directory (its fixtures and helpers too), or a
 * JavaScript or TypeScript test file wherever it is. Nothing in one ships (A1329).
 */
const TEST_ONLY = /(^|\/)(test|tests|e2e|androidTest|__tests__)\/|\.(test|spec)\.[cm]?[jt]sx?$/;

/** The root `scripts/` a shipped app's build runs: the web app's Vite config reads the ports. */
const BUILD_SCRIPTS = new Set(['scripts/ports.mjs', 'scripts/ports.d.mts']);

function under(path: string, dir: string): boolean {
  return path.startsWith(`${dir}/`);
}

/** The rule for one changed path, relative to the repository root. */
export function ruleFor(path: string): Rule {
  const p = path.replace(/^\.\//, '');
  // Markdown is prose anywhere, except as test input: Penmoss's fixtures are .md files.
  if (p.endsWith('.md') && !TEST_DATA.test(p)) return 'docs';
  // A test, a fixture or a spec ships in no app: CI and the gate run it, with no product proof.
  if (TEST_ONLY.test(p)) return 'ci';
  if (ROOT_CONFIG.has(p) || under(p, 'packages')) return 'all';
  // The Mac app bundles the web build, and the Android editor imports the web app's styles.
  if (under(p, 'apps/web')) return 'all';
  // Every client syncs through the relay.
  if (under(p, 'apps/relay')) return 'all';
  if (under(p, 'apps/desktop')) return 'mac';
  if (under(p, 'apps/android')) return 'android';
  if (under(p, '.github') || under(p, 'tools/factory')) return 'ci';
  // The marketing site has its own CI job and no client in it.
  if (under(p, 'site')) return 'ci';
  // The root scripts are dev and CI tooling (the gate's slots, the test VM, the brand generator,
  // whose output is committed under the apps it changes), except what a build runs.
  if (under(p, 'scripts')) return BUILD_SCRIPTS.has(p) ? 'all' : 'ci';
  if (under(p, 'docs') || under(p, 'tasks')) return 'docs';
  return 'all';
}

export function classify(paths: readonly string[]): Scope {
  const platforms = new Set<Platform>();
  let ci = false;
  for (const path of paths) {
    const rule = ruleFor(path);
    if (rule === 'all') PLATFORMS.forEach((p) => platforms.add(p));
    else if (rule === 'ci') ci = true;
    else if (rule !== 'docs') platforms.add(rule);
  }
  if (platforms.size > 0)
    return { kind: 'product', platforms: PLATFORMS.filter((p) => platforms.has(p)) };
  return { kind: ci || paths.length === 0 ? 'ci-only' : 'docs-only', platforms: [] };
}

/**
 * The platforms that need proof: `platform:*` labels decide when present
 * (CI still runs everything the classifier selects); otherwise the classifier.
 */
export function proofPlatforms(
  scope: Scope,
  labelled: readonly Platform[] | null,
): readonly Platform[] {
  if (scope.kind !== 'product') return [];
  return labelled ?? scope.platforms;
}

/**
 * The classifier's rules as the build prompt states them, with an example path for each, so
 * the agent plans a proof spec for every platform the gate will want before it starts (PEN-70's
 * agent left Android out, as its plan said, and the gate refused it a round, A1254). The tests
 * check each example against `classify`.
 */
export const SCOPE_RULES: readonly {
  readonly paths: string;
  readonly example: string;
  readonly platforms: readonly Platform[];
  readonly gate: string;
}[] = [
  {
    paths:
      '`packages/`, `apps/web/`, `apps/relay/`, root config (`package.json`, `pnpm-lock.yaml`, `Taskfile.yml`…), `scripts/ports.mjs` (the web build reads it) and any path no rule knows',
    example: 'packages/core/src/settings.ts',
    platforms: ['web', 'mac', 'android'],
    gate: 'web, Mac and Android',
  },
  {
    paths: '`apps/desktop/`',
    example: 'apps/desktop/src/main.ts',
    platforms: ['mac'],
    gate: 'Mac',
  },
  {
    paths: '`apps/android/`',
    example: 'apps/android/app/src/main/java/app/penmoss/Main.kt',
    platforms: ['android'],
    gate: 'Android',
  },
  {
    paths: '`site/`, `.github/`, `tools/factory/`, the rest of the root `scripts/`',
    example: 'tools/factory/src/run.ts',
    platforms: [],
    gate: 'no product proof (the gate runs `task check`)',
  },
  {
    paths:
      'Tests anywhere: files in a `test/`, `tests/`, `e2e/`, `androidTest/` or `__tests__/` directory (fixtures too), and `*.test.*` or `*.spec.*` files',
    example: 'apps/web/test/e2e/notes.spec.ts',
    platforms: [],
    gate: 'no product proof of their own (the gate runs `task check`, and CI runs them)',
  },
  {
    paths: 'Markdown outside test data, and `docs/`',
    example: 'docs/factory.md',
    platforms: [],
    gate: 'no proof (the gate runs `task lint`)',
  },
];

/** The build prompt's Scope section: which platforms the gate will want proof for, and why. */
export function scopeText(labelled: readonly Platform[] | null): string {
  if (labelled)
    return `The issue is labelled for ${labelled.join(', ')}, so once your diff touches app code the gate wants a passing proof spec for each of them, and for no other platform.`;
  return [
    'There are no `platform:*` labels, so the path classifier decides the platforms from your diff, and the gate refuses your result unless `proofSpecs` names a committed spec, which passes, for every platform the classifier puts in scope. It errs wide:',
    '',
    ...SCOPE_RULES.map((r) => `- ${r.paths}: ${r.gate}.`),
    '',
    "This holds even when the plan says a platform doesn't change: then that platform's spec shows it unaffected (an Android instrumented test that the screen has no new row, say). Work out from the files you expect to touch which platforms will be in scope, and plan a proof spec for each before you start.",
  ].join('\n');
}
