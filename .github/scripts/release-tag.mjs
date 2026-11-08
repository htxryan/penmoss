// `task release -- X.Y.Z` (P3, A1189): tags a stable release, which .github/workflows/release.yml
// builds into a draft for Ryan to publish. Only Ryan runs it for real.
//
//   node .github/scripts/release-tag.mjs 0.2.0            check, then push the annotated tag v0.2.0
//   node .github/scripts/release-tag.mjs 0.2.0-rc.1       a rehearsal: its draft is a prerelease
//   node .github/scripts/release-tag.mjs 0.2.0 --dry-run  check, and print what it would run
//
// It refuses unless this checkout is on main, clean and the same commit as origin/main (after a
// fetch), the tag is new here and on origin, and the version is newer than the newest stable tag.
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { newestStable, parseReleaseTag } from './releases.mjs';

/**
 * @typedef {{
 *   version: string,
 *   branch: string,
 *   dirty: boolean,
 *   head: string,
 *   upstream: string,
 *   tags: string[],
 *   remoteHasTag: boolean,
 * }} TagState
 */

/**
 * Why `state` must not be tagged (empty: it may be).
 * @param {TagState} state @returns {string[]}
 */
export function releaseProblems({ version, branch, dirty, head, upstream, tags, remoteHasTag }) {
  /** @type {string[]} */
  const problems = [];
  const tag = `v${version}`;
  const parsed = parseReleaseTag(tag);
  if (parsed === null) {
    return [`${version} is not X.Y.Z or X.Y.Z-rc.N (for example 0.2.0, or 0.2.0-rc.1).`];
  }
  if (branch !== 'main') problems.push(`This checkout is on ${branch}, not main.`);
  if (dirty) problems.push('The checkout has uncommitted or untracked changes.');
  if (head !== upstream) {
    problems.push(
      `HEAD (${head.slice(0, 7)}) is not origin/main (${upstream.slice(0, 7)}): pull or push first.`,
    );
  }
  if (tags.includes(tag)) problems.push(`The tag ${tag} already exists here.`);
  if (remoteHasTag) problems.push(`The tag ${tag} already exists on origin.`);
  const stable = newestStable(tags);
  if (stable !== null && compare(parsed.core, stable) <= 0) {
    problems.push(
      `${parsed.core.join('.')} is not newer than the newest stable release, v${stable.join('.')}.`,
    );
  }
  return problems;
}

/** @param {number[]} a @param {number[]} b */
function compare(a, b) {
  for (let i = 0; i < 3; i += 1) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * @typedef {(args: string[]) => string} Git  runs git with `args` and returns its stdout
 */

/**
 * Checks, then tags and pushes (or, with `dryRun`, says what it would run). Returns the
 * commands that change something, in order.
 * @param {{ version: string, dryRun?: boolean, git: Git, log?: (line: string) => void }} options
 */
export function release({ version, dryRun = false, git, log = console.log }) {
  const tag = `v${version}`;
  // Reads, done in a dry run too: the newest main and tags from origin. `--force` because the
  // rolling `alpha` tag moves with every main build (A1188): without it the fetch refuses to
  // update an older local `alpha` and fails. A `v*` tag never moves, so this changes no release.
  git(['fetch', '--quiet', '--force', '--tags', 'origin', 'main']);
  const state = {
    version,
    branch: git(['rev-parse', '--abbrev-ref', 'HEAD']).trim(),
    dirty: git(['status', '--porcelain']).trim() !== '',
    head: git(['rev-parse', 'HEAD']).trim(),
    upstream: git(['rev-parse', 'origin/main']).trim(),
    tags: git(['tag', '--list', 'v*'])
      .split('\n')
      .map((t) => t.trim())
      .filter(Boolean),
    remoteHasTag: git(['ls-remote', '--tags', 'origin', `refs/tags/${tag}`]).trim() !== '',
  };
  const problems = releaseProblems(state);
  if (problems.length > 0) {
    throw new Error(`Not tagging ${tag}:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  }
  const parsed = /** @type {NonNullable<ReturnType<typeof parseReleaseTag>>} */ (
    parseReleaseTag(tag)
  );
  const changes = [
    ['tag', '--annotate', tag, '--message', `Penmoss ${version}`, state.head],
    ['push', 'origin', `refs/tags/${tag}`],
  ];
  for (const args of changes) {
    if (dryRun) log(`[dry run] git ${args.join(' ')}`);
    else git(args);
  }
  log(
    dryRun
      ? `[dry run] ${tag} would go on ${state.head.slice(0, 7)}; nothing was tagged or pushed.`
      : `Pushed ${tag} (${state.head.slice(0, 7)}). release.yml now builds the ${parsed.prerelease ? 'draft prerelease (a rehearsal)' : 'draft'}; publish it on the Releases page once checked.`,
  );
  return changes;
}

function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { 'dry-run': { type: 'boolean', default: false } },
  });
  const [version] = positionals;
  if (!version || positionals.length !== 1) {
    throw new Error('Usage: task release -- X.Y.Z [--dry-run]   (or X.Y.Z-rc.N for a rehearsal)');
  }
  /** @type {Git} */
  const git = (args) =>
    execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  release({ version: version.replace(/^v/, ''), dryRun: values['dry-run'], git });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
