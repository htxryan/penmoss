/**
 * The shell commands the host runs in a run's sandbox (F9: out of host.ts): put the branch on the
 * main the host fetched (A1232), take commits pushed to the PR by hand (PEN-101), get the sandbox
 * ready (A1289), and go again past the other slot's ref lock (A1267).
 */
import type { RunSandbox } from './run-deps.ts';

/**
 * The gate sandbox's fetch of main into the runs' clone, with the sandbox's read-only token, and
 * main put at `base`: the commit the host fetched into the publish repo, which the push then
 * checks the branch descends from. The host never fetches into the clone itself.
 */
export function sandboxMainCommand(base: string): string {
  if (!/^[0-9a-f]{40,64}$/.test(base)) throw new Error(`not a commit: ${base}`);
  return [
    `git -c credential.helper= -c 'credential.helper=!f() { test "$1" = get || exit 0; echo username=x-access-token; echo "password=$GH_TOKEN"; }; f'`,
    'fetch --quiet --no-tags origin main',
    `&& git update-ref refs/remotes/origin/main ${base}`,
  ].join(' ');
}

/**
 * The first command in every sandbox the host opens: main fetched and put at `base`, as for the
 * gate, then a branch with no commits of its own (one Sandcastle has just made from the clone's
 * main, which only the last gate moved) fast-forwarded onto `base`. A branch with commits of its
 * own (a restarted run's, R12, or a fix or review round's) is rebased onto `base` when its
 * tracked files are clean and the rebase goes through, so the agent works on today's main
 * rather than re-reporting what main has fixed since (PEN-75's restarted run); otherwise it is
 * left where it is, and the gate's rebase, which resolves decision rows, deals with it.
 */
export function sandboxStartCommand(base: string): string {
  return [
    `${sandboxMainCommand(base)} && if git merge-base --is-ancestor HEAD ${base}; then git merge --ff-only --quiet ${base};`,
    `elif test -z "$(git status --porcelain --untracked-files=no)"; then git rebase --quiet ${base} >/dev/null 2>&1 || git rebase --abort; fi`,
  ].join(' ');
}

/**
 * Gets a new sandbox ready before its agent starts, so the agent goes straight to the work
 * (A1289). Past runs lost their first minutes to these:
 *
 * - the workspace's dependencies, which a new worktree doesn't have (PEN-64, PEN-71, and two
 *   more ran `task setup` or failed on missing modules first): installed from the factory's pnpm
 *   store, offline and frozen, in seconds;
 * - zsh's here-documents, which it writes to `/tmp` (TMPPREFIX), outside the sandbox: 17 of the
 *   agents' heredocs failed, and each fell back to another way. The sandbox's own temp folder
 *   instead;
 * - Java's temp folder and home (KSP, Robolectric, the debug keystore in `~/.android`), which an
 *   agent had to remember to export before Gradle: set for every shell.
 *
 * `$HOME/.zshenv` is read by every zsh, which is the shell Claude Code's and OpenCode's Bash
 * tools run. A failed install doesn't stop the run: the agent sees it and can install itself.
 */
export const SANDBOX_READY = [
  `printf '%s\\n' '# The factory writes this when the sandbox starts (A1289).' 'export TMPPREFIX="$TMPDIR/zsh"' 'export JAVA_TOOL_OPTIONS="-Djava.io.tmpdir=$TMPDIR -Duser.home=$HOME"' > "$HOME/.zshenv"`,
  'corepack pnpm install --frozen-lockfile --prefer-offline --reporter=silent',
].join(' && ');

/**
 * Takes the commits someone pushed on top of the factory's last push to `branch` (PEN-101): the
 * sandbox fetches the branch, checks GitHub still has `to`, and fast-forwards onto it, or, when
 * the run's branch has commits GitHub doesn't (a rebase, a round that didn't push), cherry-picks
 * `from..to` onto them. A pick that conflicts is undone, and the command fails (exit 3).
 */
export function sandboxTakeCommand(branch: string, from: string, to: string): string {
  if (!/^[\w.][\w./-]*$/.test(branch) || branch.includes('..'))
    throw new Error(`not a branch the factory makes: ${branch}`);
  for (const sha of [from, to])
    if (!/^[0-9a-f]{40,64}$/.test(sha)) throw new Error(`not a commit: ${sha}`);
  return [
    `git -c credential.helper= -c 'credential.helper=!f() { test "$1" = get || exit 0; echo username=x-access-token; echo "password=$GH_TOKEN"; }; f'`,
    `fetch --quiet --no-tags origin refs/heads/${branch}`,
    `&& test "$(git rev-parse FETCH_HEAD)" = ${to}`,
    `&& if git merge-base --is-ancestor HEAD ${to}; then git merge --ff-only --quiet ${to};`,
    `elif git cherry-pick --allow-empty ${from}..${to} >/dev/null 2>&1; then :;`,
    'else git cherry-pick --abort >/dev/null 2>&1; exit 3; fi',
  ].join(' ');
}

/**
 * Both slots' sandboxes are worktrees of one clone, so two starting together both fetch main into
 * its `refs/remotes/origin/main`, and one can lose the ref's lock ("cannot lock ref"): PEN-79 and
 * PEN-80 were picked in the same second. A start that lost it goes again (A1267).
 */
const REF_LOCK = /cannot lock ref|unable to update local ref|\.lock': File exists/;

export async function execPastRefLocks(
  handle: Pick<RunSandbox, 'exec'>,
  command: string,
  pause: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  for (let attempt = 1; ; attempt++) {
    const ran = await handle.exec(command);
    if (ran.exitCode === 0 || attempt >= 4 || !REF_LOCK.test(ran.stderr)) return ran;
    await pause(500 * attempt + Math.floor(Math.random() * 500));
  }
}
