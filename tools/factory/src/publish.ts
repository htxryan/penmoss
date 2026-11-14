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
import { ensureConfig, hostGit, mustGit } from './git.ts';

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
  await ensureConfig(exec, dir, 'remote.origin.url', url);
  await ensureConfig(exec, dir, 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*');
  if (identity) {
    await ensureConfig(exec, dir, 'user.name', identity.name);
    await ensureConfig(exec, dir, 'user.email', identity.email);
  }
  const known = await hostGit(exec, dir, ['rev-parse', '--verify', '--quiet', MAIN]);
  await fetchOrigin(exec, dir, [
    'fetch',
    '--quiet',
    '--no-tags',
    'origin',
    ...(known.code === 0 ? ['main'] : []),
  ]);
  return dir;
}

/** The fetch of origin each repo is running, so the next waits for it (A1377). */
const fetching = new Map<string, Promise<void>>();

/** How long a fetch that found `origin/main` locked waits before its one retry. */
export const LOCKED_RETRY_MS = 2_000;

/**
 * Fetches origin into `dir` one fetch at a time, and retries once when another git still held
 * the ref (A1377). Two picks in one poll fetched main into the publish repo together, and the
 * second failed with "cannot lock ref 'refs/remotes/origin/main'", which Blocked its card: twice
 * on 14 Nov 2026, once at a pick and once rebasing PRs after main moved.
 */
export async function fetchOrigin(
  exec: Exec,
  dir: string,
  args: readonly string[],
  retryMs = LOCKED_RETRY_MS,
): Promise<void> {
  const before = fetching.get(dir) ?? Promise.resolve();
  const mine = before.then(async () => {
    try {
      await mustGit(exec, dir, args);
    } catch (error) {
      if (!(error instanceof Error) || !/cannot lock ref/i.test(error.message)) throw error;
      await new Promise((resolve) => setTimeout(resolve, retryMs));
      await mustGit(exec, dir, args);
    }
  });
  // The next fetch waits for this one whether or not it fails.
  const settled = mine.catch(() => undefined);
  fetching.set(dir, settled);
  try {
    await mine;
  } finally {
    if (fetching.get(dir) === settled) fetching.delete(dir);
  }
}

export function ensurePublishRepo(
  config: FactoryConfig,
  exec: Exec,
  identity?: Identity,
): Promise<string> {
  return preparePublishRepo(exec, publishDir(config), githubUrl(config), identity);
}

/** Fetches main from GitHub into the publish repo; returns its commit, the base runs are given. */
export async function fetchMainInto(
  exec: Exec,
  dir: string,
  retryMs = LOCKED_RETRY_MS,
): Promise<string> {
  await fetchOrigin(exec, dir, ['fetch', '--quiet', '--no-tags', 'origin', 'main'], retryMs);
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

/**
 * What GitHub has on a run's branch, against what the factory last pushed there (PEN-101).
 * `ahead`: someone pushed commits on top of the factory's (Ryan fixing up a PR by hand); a
 * sandbox takes them before it works, and the push's lease moves to their head.
 * `rewritten`: the branch no longer holds the factory's last push (a force-push); the factory
 * won't build on it or push over it.
 */
export type RemoteBranch =
  | { readonly kind: 'ours' }
  | { readonly kind: 'ahead'; readonly from: string; readonly to: string }
  | { readonly kind: 'rewritten'; readonly head: string; readonly ours: string };

export async function remoteBranch(
  exec: Exec,
  dir: string,
  url: string,
  branch: string,
  token: string,
): Promise<RemoteBranch> {
  const ref = `refs/heads/${branch}`;
  const listed = await mustGit(exec, dir, ['ls-remote', url, ref], { token });
  const head = listed.trim().split(/\s+/)[0] ?? '';
  if (!head) return { kind: 'ours' };
  const last = await hostGit(exec, dir, [
    'rev-parse',
    '--verify',
    '--quiet',
    `refs/remotes/origin/${branch}`,
  ]);
  // No push of the factory's to compare with: as before, the push decides.
  if (last.code !== 0) return { kind: 'ours' };
  const ours = last.stdout.trim();
  if (head === ours) return { kind: 'ours' };
  // By URL, not by the remote's name, so git doesn't move the tracking ref (the lease) itself.
  await mustGit(
    exec,
    dir,
    [
      'fetch',
      '--quiet',
      '--no-tags',
      '--no-write-fetch-head',
      url,
      `+${ref}:refs/factory-remote/${branch}`,
    ],
    { token },
  );
  return (await descendsFrom(exec, dir, ours, head))
    ? { kind: 'ahead', from: ours, to: head }
    : { kind: 'rewritten', head, ours };
}

/**
 * The commit GitHub has on a run's branch when it is the factory's last push there; undefined
 * when GitHub has none, the factory never pushed, or someone else pushed since (A1298).
 */
export async function unchangedSincePush(
  exec: Exec,
  dir: string,
  url: string,
  branch: string,
  token: string,
): Promise<string | undefined> {
  const listed = await mustGit(exec, dir, ['ls-remote', url, `refs/heads/${branch}`], { token });
  const head = listed.trim().split(/\s+/)[0] ?? '';
  const last = await hostGit(exec, dir, [
    'rev-parse',
    '--verify',
    '--quiet',
    `refs/remotes/origin/${branch}`,
  ]);
  return head && last.code === 0 && last.stdout.trim() === head ? head : undefined;
}

/** An open PR as `gh pr list --json url,headRefOid,mergeable` lists it. */
export interface OpenPr {
  readonly url: string;
  readonly headRefOid: string;
  readonly mergeable?: string;
}

/**
 * The PR a recovered run can go back to watching CI on (A1298): the open one whose head is the
 * factory's last push, and only while GitHub can merge it into main (A1310). A PR that
 * conflicts with main gets no new CI run, not even when it's closed and reopened, so watching
 * it would only read its old checks; the run goes back through the gate, whose rebase resolves
 * the conflict. `UNKNOWN` (GitHub hasn't worked it out yet) counts as not mergeable: the gate
 * costs minutes, a repair round on stale checks costs more.
 */
export function resumablePr(open: readonly OpenPr[], head: string): string | undefined {
  const pr = open.find((each) => each.headRefOid === head);
  return pr && pr.mergeable === 'MERGEABLE' ? pr.url : undefined;
}

/** After a sandbox took the commits GitHub had on top (`ahead`), the next push is leased on them. */
export async function adoptRemoteHead(
  exec: Exec,
  dir: string,
  branch: string,
  head: string,
): Promise<void> {
  await mustGit(exec, dir, ['update-ref', `refs/remotes/origin/${branch}`, head]);
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
