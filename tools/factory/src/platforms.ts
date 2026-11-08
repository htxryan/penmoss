/**
 * The path classifier (Platform scope in the factory plan): which platforms a
 * set of changed paths can affect. The harness gate and CI's changes job both
 * use it, so they never disagree. It errs wide: a path no rule recognises
 * puts all three platforms in scope.
 */
import { PLATFORMS, type Platform } from './config.ts';

/**
 * - `product`: at least one platform needs proof.
 * - `ci-only`: factory and CI unit tests plus the full CI run, no product proof.
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

function under(path: string, dir: string): boolean {
  return path.startsWith(`${dir}/`);
}

/** The rule for one changed path, relative to the repository root. */
export function ruleFor(path: string): Rule {
  const p = path.replace(/^\.\//, '');
  // Markdown is prose anywhere, except as test input: Penmoss's fixtures are .md files.
  if (p.endsWith('.md') && !TEST_DATA.test(p)) return 'docs';
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
