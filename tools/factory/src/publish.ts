/**
 * The publish repo (A1230): a bare repository under the state folder (`<stateDir>/publish`)
 * that no sandbox ever mounts, with config the host alone writes (origin, identity). The runs'
 * clone is the agents' (Sandcastle mounts its `.git` into every sandbox), so the host never runs
 * git in it: to read or publish a run, it fetches the run's branch *from* the clone into here
 * (fetching from an untrusted repository is within git's model: upload-pack reads nothing of
 * that repository's config that could run anything or reach the network), checks it descends
 * from the main the run was given, and reads, diffs and pushes here.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expandHome, type FactoryConfig } from './config.ts';
import type { Exec } from './exec.ts';
import { hostGit, mustGit } from './git.ts';

export const MAIN = 'refs/remotes/origin/main';

export function publishDir(config: FactoryConfig): string {
  return join(expandHome(config.stateDir), 'publish');
}

export function githubUrl(config: FactoryConfig): string {
  return `https://github.com/${config.repo}.git`;
}

export interface Identity {
  readonly name: string;
  readonly email: string;
}

/**
 * Makes the publish repo if it isn't there, (re)writes its origin and identity, and fetches
 * main. The first fetch takes every branch: a push's lease is the commit kept in
 * `refs/remotes/origin/<branch>`, so a new publish repo starts from what GitHub has, as a fresh
 * clone did.
 */
export async function preparePublishRepo(
  exec: Exec,
  dir: string,
  url: string,
  identity?: Identity,
): Promise<string> {
  if (!existsSync(join(dir, 'HEAD'))) {
    mkdirSync(dir, { recursive: true });
    await mustGit(exec, dir, ['init', '--quiet', '--bare']);
  }
  await mustGit(exec, dir, ['config', 'remote.origin.url', url]);
  await mustGit(exec, dir, [
    'config',
    '--replace-all',
    'remote.origin.fetch',
    '+refs/heads/*:refs/remotes/origin/*',
  ]);
  if (identity) {
    await mustGit(exec, dir, ['config', 'user.name', identity.name]);
    await mustGit(exec, dir, ['config', 'user.email', identity.email]);
  }
  const known = await hostGit(exec, dir, ['rev-parse', '--verify', '--quiet', MAIN]);
  await mustGit(exec, dir, [
    'fetch',
    '--quiet',
    '--no-tags',
    'origin',
    ...(known.code === 0 ? ['main'] : []),
  ]);
  return dir;
}

export function ensurePublishRepo(
  config: FactoryConfig,
  exec: Exec,
  identity?: Identity,
): Promise<string> {
  return preparePublishRepo(exec, publishDir(config), githubUrl(config), identity);
}

/** Fetches main from GitHub into the publish repo; returns its commit, the base runs are given. */
export async function fetchMainInto(exec: Exec, dir: string): Promise<string> {
  await mustGit(exec, dir, ['fetch', '--quiet', '--no-tags', 'origin', 'main']);
  return mainOf(exec, dir);
}

export async function mainOf(exec: Exec, dir: string): Promise<string> {
  return (await mustGit(exec, dir, ['rev-parse', '--verify', `${MAIN}^{commit}`])).trim();
}

/** Where the publish repo keeps a run's branch, as last fetched from the runs' clone. */
export const runRef = (runId: string) => `refs/factory/${runId}`;

/**
 * Fetches `branch` from the runs' clone into `ref` in the publish repo (no tags, nothing else),
 * and returns its commit. Only git in the publish repo runs: the clone just serves the objects.
 */
export async function fetchRunBranch(
  exec: Exec,
  dir: string,
  runClone: string,
  branch: string,
  ref: string,
): Promise<string> {
  if (!/^[\w.][\w./-]*$/.test(branch) || branch.includes('..'))
    throw new Error(`not a branch the factory makes: ${branch}`);
  await mustGit(exec, dir, [
    'fetch',
    '--quiet',
    '--no-tags',
    '--no-recurse-submodules',
    '--no-write-fetch-head',
    runClone,
    `+refs/heads/${branch}:${ref}`,
  ]);
  return (await mustGit(exec, dir, ['rev-parse', '--verify', `${ref}^{commit}`])).trim();
}

/** Whether `commit` has `base` in its history (git merge-base --is-ancestor). */
export async function descendsFrom(
  exec: Exec,
  dir: string,
  base: string,
  commit: string,
): Promise<boolean> {
  const r = await hostGit(exec, dir, ['merge-base', '--is-ancestor', base, commit]);
  if (r.code > 1) throw new Error(`git merge-base failed: ${r.stderr.trim()}`);
  return r.code === 0;
}

/**
 * Pushes `commit` to `branch` at `url` from the publish repo, leased on what the factory last
 * pushed there. A push to a URL has no remote-tracking ref, so a bare `--force-with-lease`
 * expects the branch not to exist and refuses every later push of it ("stale info"): a CI
 * repair, a review round, a restarted run. So the lease is explicit: none when GitHub has no
 * such branch, otherwise the commit kept in `refs/remotes/origin/<branch>` (written after each
 * push; a new publish repo fills it from GitHub). A push someone else made to the branch is
 * still never overwritten.
 */
export async function pushBranch(
  exec: Exec,
  dir: string,
  url: string,
  branch: string,
  commit: string,
  token: string,
): Promise<void> {
  const ref = `refs/heads/${branch}`;
  const tracking = `refs/remotes/origin/${branch}`;
  const remote = await mustGit(exec, dir, ['ls-remote', url, ref], { token });
  let expect = '';
  if (remote.trim() !== '') {
    const last = await hostGit(exec, dir, ['rev-parse', '--verify', '--quiet', tracking]);
    expect = last.code === 0 ? last.stdout.trim() : '';
  }
  await mustGit(
    exec,
    dir,
    ['push', '--no-verify', url, `--force-with-lease=${ref}:${expect}`, `${commit}:${ref}`],
    { token },
  );
  await mustGit(exec, dir, ['update-ref', tracking, commit]);
}

export interface PublishRun {
  readonly dir: string;
  readonly runClone: string;
  readonly url: string;
  readonly branch: string;
  readonly ref: string;
  /** main as the host fetched it before the run's last rebase: the branch must contain it. */
  readonly base: string | undefined;
  readonly token: string;
}

/**
 * Publishes a run: its branch fetched from the runs' clone, refused unless it descends from
 * `base`, then pushed from the publish repo with the lease. Returns the commit pushed.
 */
export async function publishRun(exec: Exec, run: PublishRun): Promise<string> {
  const commit = await fetchRunBranch(exec, run.dir, run.runClone, run.branch, run.ref);
  if (!run.base) throw new Error(`refusing to push ${run.branch}: main wasn't fetched for it`);
  if (!(await descendsFrom(exec, run.dir, run.base, commit)))
    throw new Error(
      `refusing to push ${run.branch}: ${commit.slice(0, 10)} doesn't descend from main's ${run.base.slice(0, 10)}, the base the run was given`,
    );
  await pushBranch(exec, run.dir, run.url, run.branch, commit, run.token);
  return commit;
}

/** The commit the factory last pushed to `branch` (its tracking ref in the publish repo). */
export async function pushedHead(exec: Exec, dir: string, branch: string): Promise<string> {
  return (
    await mustGit(exec, dir, ['rev-parse', '--verify', `refs/remotes/origin/${branch}^{commit}`])
  ).trim();
}
