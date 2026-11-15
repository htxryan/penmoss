// The GitHub Releases page as releases.mjs sees it: the `Gh` operations, and `cliGh`, which runs
// them through the `gh` CLI. The tests use an in-memory page instead (release-fake-gh.mjs).
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * @typedef {{ tag: string, target: string, body: string, prerelease: boolean, assets: { name: string }[] }} Release
 * @typedef {{ tag: string, sha: string, title: string, notes: string, files: string[] }} NewRelease
 * @typedef {{ tag: string, title: string, files: string[], prerelease: boolean, notes: string }} NewDraft
 * @typedef {{
 *   list(): Promise<Release[]>,
 *   tags(): Promise<string[]>,
 *   subject(sha: string): Promise<string>,
 *   create(r: NewRelease): Promise<void>,
 *   findRelease(tag: string): Promise<(Release & { draft: boolean }) | null>,
 *   createDraft(r: NewDraft): Promise<void>,
 *   upload(tag: string, file: string): Promise<void>,
 *   deleteAsset(tag: string, name: string): Promise<void>,
 *   download(tag: string, name: string, dir: string): Promise<string>,
 *   editNotes(tag: string, notes: string): Promise<void>,
 *   markPrerelease(tag: string): Promise<void>,
 *   moveTag(tag: string, sha: string): Promise<void>,
 *   remove(tag: string): Promise<void>,
 *   compare(base: string, head: string): Promise<string[]>,
 *   pullsOf(sha: string): Promise<import('./release-notes.mjs').PullRequest[]>,
 *   pull(number: number): Promise<import('./release-notes.mjs').PullRequest>,
 *   log(message: string): void,
 * }} Gh
 * `create` makes a prerelease that is never Latest, with `files` uploaded in order. `findRelease`
 * sees drafts too. `createDraft` makes a draft of an existing tag, with `notes` (the Release
 */

/**
 * The `gh` CLI as a Gh. With `dryRun`, changes are printed, not made; reads still happen.
 * @param {{ repo: string, dryRun?: boolean }} options @returns {Gh}
 */
export function cliGh({ repo, dryRun = false }) {
  /** @param {string[]} args @param {string} [input] */
  const run = (args, input) =>
    execFileSync('gh', args, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'inherit'] });
  /** @param {string[]} args @param {string} [input] */
  const change = async (args, input) => {
    if (dryRun) console.log(`[dry run] gh ${args.join(' ')}${input ? `\n${input}\n[end]` : ''}`);
    else run(args, input);
  };
  return {
    async list() {
      /** @type {{ tag_name: string, target_commitish: string, body: string | null, draft: boolean, prerelease: boolean, assets: { name: string }[] }[]} */
      const releases = JSON.parse(run(['api', `repos/${repo}/releases?per_page=100`]));
      return releases
        .filter((release) => !release.draft)
        .map((release) => ({
          tag: release.tag_name,
          target: release.target_commitish,
          body: release.body ?? '',
          prerelease: release.prerelease,
          assets: release.assets.map(({ name }) => ({ name })),
        }));
    },
    async tags() {
      const out = run([
        'api',
        '--paginate',
        `repos/${repo}/git/matching-refs/tags/v`,
        '--jq',
        '.[].ref',
      ]);
      return out
        .split('\n')
        .filter(Boolean)
        .map((ref) => ref.replace(/^refs\/tags\//, ''));
    },
    async subject(sha) {
      return run([
        'api',
        `repos/${repo}/commits/${sha}`,
        '--jq',
        '.commit.message | split("\\n")[0]',
      ]).trim();
    },
    create: ({ tag, sha, title, notes, files }) =>
      change(
        [
          'release',
          'create',
          tag,
          ...files,
          '--repo',
          repo,
          '--target',
          sha,
          '--title',
          title,
          '--notes-file',
          '-',
          '--prerelease',
          '--latest=false',
        ],
        notes,
      ),
    async findRelease(tag) {
      /** @type {{ tag_name: string, target_commitish: string, body: string | null, draft: boolean, prerelease: boolean, assets: { name: string }[] }[]} */
      const releases = JSON.parse(run(['api', `repos/${repo}/releases?per_page=100`]));
      const found = releases.find((release) => release.tag_name === tag);
      if (!found) return null;
      return {
        tag: found.tag_name,
        target: found.target_commitish,
        body: found.body ?? '',
        prerelease: found.prerelease,
        draft: found.draft,
        assets: found.assets.map(({ name }) => ({ name })),
      };
    },
    createDraft: ({ tag, title, files, prerelease, notes }) =>
      change(
        [
          'release',
          'create',
          tag,
          ...files,
          '--repo',
          repo,
          '--draft',
          '--verify-tag',
          '--title',
          title,
          '--notes-file',
          '-',
          ...(prerelease ? ['--prerelease'] : []),
        ],
        notes,
      ),
    upload: (tag, file) => change(['release', 'upload', tag, file, '--repo', repo, '--clobber']),
    deleteAsset: (tag, name) =>
      change(['release', 'delete-asset', tag, name, '--repo', repo, '--yes']),
    async download(tag, name, dir) {
      // A dry run downloads nothing (a dmg is 230 MB): it leaves an empty file in its place.
      const args = ['release', 'download', tag, '--repo', repo, '--pattern', name, '--dir', dir];
      if (dryRun) {
        console.log(`[dry run] gh ${args.join(' ')} (an empty stand-in)`);
        writeFileSync(path.join(dir, name), '');
      } else run(args);
      return path.join(dir, name);
    },
    editNotes: (tag, notes) =>
      change(['release', 'edit', tag, '--repo', repo, '--notes-file', '-'], notes),
    markPrerelease: (tag) =>
      change(['release', 'edit', tag, '--repo', repo, '--prerelease', '--latest=false']),
    moveTag: (tag, sha) =>
      change([
        'api',
        '-X',
        'PATCH',
        `repos/${repo}/git/refs/tags/${tag}`,
        '-f',
        `sha=${sha}`,
        '-F',
        'force=true',
      ]),
    remove: (tag) => change(['release', 'delete', tag, '--repo', repo, '--cleanup-tag', '--yes']),
    async compare(base, head) {
      const out = run(['api', `repos/${repo}/compare/${base}...${head}`, '--jq', '.commits[].sha']);
      return out.split('\n').filter(Boolean);
    },
    async pullsOf(sha) {
      return JSON.parse(
        run([
          'api',
          `repos/${repo}/commits/${sha}/pulls`,
          '--jq',
          '[.[] | { number, body, mergedTo: (if .merged_at then .base.ref else null end) }]',
        ]),
      );
    },
    async pull(number) {
      return JSON.parse(
        run([
          'api',
          `repos/${repo}/pulls/${number}`,
          '--jq',
          '{ number, body, mergedTo: (if .merged_at then .base.ref else null end) }',
        ]),
      );
    },
    log: (message) => console.log(message),
  };
}
