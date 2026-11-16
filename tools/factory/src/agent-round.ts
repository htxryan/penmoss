/**
 * One agent round: a session in a sandbox on the branch, waiting out usage limits (R13) and
 * continuing a session that ended without `result.json` (A1346), and the Release note it wrote
 * (PEN-105), with the prompt sections the rounds add (Ryan's comments, A1347).
 */
import { USAGE_LIMIT_WAIT, usageLimitReset } from './limits.ts';
import type { AgentResult } from './result.ts';
import type { IssueComment } from './issue.ts';
import { formatNote, parseReleaseNote } from '../../../.github/scripts/release-note.mjs';
import type { ResultRead, RunSandbox, RunDeps } from './run-deps.ts';

/** How many usage-limit waits one agent round gets before the run stops. */
export const MAX_LIMIT_WAITS = 3;

/**
 * Runs the agent, and when it stops on a usage limit, waits for the reset and runs the same
 * prompt again in the same worktree (R13). A limit never counts as a round.
 */
export async function runAgentPatiently(
  deps: Pick<RunDeps, 'runAgent' | 'now' | 'sleep' | 'log'> & Partial<Pick<RunDeps, 'waitingFor'>>,
  sandbox: RunSandbox,
  prompt: string,
  run: RunDeps['runAgent'] = (s, p) => deps.runAgent(s, p),
): Promise<void> {
  for (let waits = 0; ; waits++) {
    const ran = await run(sandbox, prompt);
    const reset = ran ? usageLimitReset(ran.output, deps.now()) : null;
    if (!reset) return;
    if (waits >= MAX_LIMIT_WAITS)
      throw new Error(`the agent hit its usage limit ${waits + 1} times in a row`);
    deps.log('usage-limited', { until: reset.toISOString() });
    deps.waitingFor?.(`${USAGE_LIMIT_WAIT} at ${reset.toISOString()}`);
    await deps.sleep(Math.ceil((reset.getTime() - deps.now().getTime()) / 1000) + 60);
    deps.waitingFor?.(null);
  }
}

/** Ryan's comments as the issue's text shows them: his words, as they are (R14). */
function ownerCommentLines(comments: readonly IssueComment[]): string {
  return comments
    .map((c) => `**${c.authorName ?? c.author}** (${c.createdAt}):\n${c.body}`)
    .join('\n\n');
}

/** Ryan's card comments that arrived while the run went on, for the next round (A1347). */
export function ownerCommentsSection(comments: readonly IssueComment[]): string {
  return `## Ryan's new comments on the issue\n\nRyan, the repository's owner, commented on the issue after this run read it. His comments are instructions, like the issue's; take them into account in this round:\n\n${ownerCommentLines(comments)}`;
}

/** Ryan's replies after a run whose agent had finished stopped (A1347), for its next round. */
export function repliesSection(branch: string, comments: readonly IssueComment[]): string {
  return `## Ryan's reply after the run stopped\n\nThis run stopped after its agent had finished, and Ryan, the repository's owner, commented on the issue since. His comments are instructions, like the issue's:\n\n${ownerCommentLines(comments)}\n\nThe earlier work is committed on \`${branch}\`: build on it, do what he asks, commit, and write \`.factory/result.json\` again. ${STALE_MAIN}`;
}

/**
 * In a sandbox, main is `origin/main` (the host's fetch); the clone's local `main` is stale, and an
 * agent that diffed against it saw every factory change since the run began (PEN-70's run).
 */
export const STALE_MAIN =
  'Main is `origin/main` here; the local `main` branch is stale, so diff and rebase against `origin/main` (`git diff origin/main...HEAD`).';

/** What a session that ended without `result.json` is told when it is continued (A1346). */
export const CONTINUE_MESSAGE =
  'Your session ended before you wrote `.factory/result.json`, so the factory has nothing to check yet. Continue the task from where you stopped, and write `.factory/result.json` when you are done, as the prompt says.';

/** What a new session is told when the last one, which wrote no `result.json`, can't be resumed. */
export const CONTINUE_NOTE = `## The last session ended early\n\nA session on this task ended before it wrote \`.factory/result.json\` (its final message may have been a malformed tool call). What it did is in this worktree and on the branch: read \`git status\` and \`git log origin/main..HEAD\` first. Continue the task from there, and write \`.factory/result.json\` when you are done.`;

/**
 * What a session that ended with uncommitted work is told (PEN-141): PEN-140's agent started its
 * check in the background and ended its turn to wait for it, so the sandbox closed, stopped the
 * check and left 16 files uncommitted for the gate to refuse.
 */
export function commitMessage(files: readonly string[]): string {
  const shown = files.slice(0, 10).map((f) => `\`${f}\``);
  const more = files.length > shown.length ? `, and ${files.length - shown.length} more` : '';
  return `Your session ended with work on the branch that isn't committed (${shown.join(', ')}${more}), so the gate would refuse it. Anything you left running in the background stopped when your turn ended. Run the checks again in the foreground and wait for them to finish, fix what they find, commit your work, and write \`.factory/result.json\` again. Don't end your turn while a command is still running.`;
}

/** The paths in `git status --porcelain` output (a rename names where it went). */
export function porcelainPaths(stdout: string): string[] {
  return stdout
    .split('\n')
    .filter((line) => line.length > 3)
    .map((line) => line.slice(3).split(' -> ').at(-1)!);
}

/** What a new session is told when the last one, which left work uncommitted, can't be resumed. */
export function commitNote(files: readonly string[]): string {
  return `## The last session left its work uncommitted\n\n${commitMessage(files)} What it did is in this worktree: read \`git status\` and \`git log origin/main..HEAD\` first.`;
}

/**
 * One agent session and the result it wrote. A session that ends without writing
 * `.factory/result.json` at all (PEN-117's OpenCode session took a malformed tool call for its
 * final answer) is continued once, in the same sandbox, before the run gives up on it
 * (A1346): the same session resumed with `CONTINUE_MESSAGE` when its agent can resume one,
 * else a new session with the prompt and `CONTINUE_NOTE`. Only once per call, so it can't loop.
 */
export async function runAndRead(
  deps: Pick<
    RunDeps,
    | 'runAgent'
    | 'canContinue'
    | 'continueAgent'
    | 'ownerComments'
    | 'readResult'
    | 'uncommitted'
    | 'now'
    | 'sleep'
    | 'log'
  > &
    Partial<Pick<RunDeps, 'waitingFor'>>,
  sandbox: RunSandbox,
  prompt: string,
  at: Readonly<Record<string, unknown>> = {},
): Promise<ResultRead> {
  // What Ryan said on the card since the prompt was built goes with every round (A1347).
  const said = deps.ownerComments ? await deps.ownerComments().catch(() => []) : [];
  if (said.length > 0) {
    deps.log('owner-comments', { ...at, comments: said.length });
    prompt = `${prompt}\n\n${ownerCommentsSection(said)}`;
  }
  await runAgentPatiently(deps, sandbox, prompt);
  return commitLeftovers(
    deps,
    sandbox,
    prompt,
    await continueMissing(deps, sandbox, prompt, at),
    at,
  );
}

/** `runAndRead`'s continuation of a session that wrote no `result.json` (A1346), once. */
async function continueMissing(
  deps: Parameters<typeof runAndRead>[0],
  sandbox: RunSandbox,
  prompt: string,
  at: Readonly<Record<string, unknown>>,
): Promise<ResultRead> {
  const read = await deps.readResult(sandbox);
  if (read.ok || !read.missing) return read;
  const resume = deps.continueAgent && deps.canContinue?.(sandbox) === true;
  if (resume) {
    deps.log('agent-continued', { ...at, how: 'resume' });
    try {
      await runAgentPatiently(deps, sandbox, CONTINUE_MESSAGE, (s, m) => deps.continueAgent!(s, m));
      return await deps.readResult(sandbox);
    } catch (error) {
      // A session that can't be resumed after all gets the new session instead.
      deps.log('agent-continued', {
        ...at,
        how: 'new session',
        after: error instanceof Error ? error.message : String(error),
      });
    }
  } else deps.log('agent-continued', { ...at, how: 'new session' });
  await runAgentPatiently(deps, sandbox, `${prompt}\n\n${CONTINUE_NOTE}`);
  return deps.readResult(sandbox);
}

/**
 * A session that reported done but left tracked files uncommitted (PEN-141) gets one more turn
 * to commit them, in the same sandbox, which isn't a round: resumed with `commitMessage` when its
 * agent can resume, else a new session with the prompt and `commitNote`. Only once, so it can't
 * loop; what is still uncommitted after it goes to the gate, which names the files.
 */
async function commitLeftovers(
  deps: Parameters<typeof runAndRead>[0],
  sandbox: RunSandbox,
  prompt: string,
  read: ResultRead,
  at: Readonly<Record<string, unknown>>,
): Promise<ResultRead> {
  if (!deps.uncommitted || !read.ok || read.result.status !== 'done') return read;
  const files = await deps.uncommitted(sandbox).catch(() => []);
  if (files.length === 0) return read;
  const resume = deps.continueAgent && deps.canContinue?.(sandbox) === true;
  deps.log('agent-continued', {
    ...at,
    how: resume ? 'resume' : 'new session',
    uncommitted: files.length,
  });
  if (resume) {
    try {
      await runAgentPatiently(deps, sandbox, commitMessage(files), (s, m) =>
        deps.continueAgent!(s, m),
      );
      return await deps.readResult(sandbox);
    } catch {
      // A session that can't be resumed after all gets the new session instead.
    }
  }
  await runAgentPatiently(deps, sandbox, `${prompt}\n\n${commitNote(files)}`);
  return deps.readResult(sandbox);
}

/** One agent round in a sandbox on the branch, and the result it wrote. */
export async function agentRound(
  deps: RunDeps,
  branch: string,
  prompt: string,
  round: number,
): Promise<ResultRead> {
  const work = await deps.openSandbox(branch);
  try {
    deps.log('agent-started', { branch, round });
    let read: ResultRead;
    try {
      read = await runAndRead(deps, work, prompt, { round });
    } catch (error) {
      // The agent may have finished before a later step failed (PEN-72: Sandcastle's session
      // capture). Keep its result, so a recovered run goes on from the gate (A1266).
      const read = await deps.readResult(work).catch(() => undefined);
      if (read?.ok && read.result.status === 'done')
        deps.log('agent-finished', {
          status: 'done',
          after: error instanceof Error ? error.message : String(error),
        });
      throw error;
    }
    deps.log('agent-finished', read.ok ? { status: read.result.status } : { error: read.error });
    return read;
  } finally {
    await work.close();
  }
}

/**
 * The agent's Release note, checked as the PR's own Release note check will check it, and as
 * the PR shows it: the notes one per line, or `none`.
 */
export function releaseNoteOf(
  result: AgentResult,
):
  { readonly ok: true; readonly text: string } | { readonly ok: false; readonly errors: string[] } {
  if (!result.releaseNote)
    return {
      ok: false,
      errors: ['`.factory/result.json` has no `releaseNote`.'],
    };
  const parsed = parseReleaseNote(`## Release note\n\n${result.releaseNote}`);
  if (!parsed.ok) return { ok: false, errors: parsed.errors };
  return { ok: true, text: parsed.none ? 'none' : parsed.notes.map(formatNote).join('\n') };
}

/** The prompt for a round that only fixes the Release note. */
export function releaseNotePrompt(prompt: string, errors: readonly string[]): string {
  return `${prompt}\n\n## Your Release note\n\nYour work is committed and needs no change, but the PR's Release note isn't right:\n\n${errors.map((e) => `- ${e}`).join('\n')}\n\nWrite \`.factory/result.json\` again, the same as before, with \`releaseNote\` set as "When you're done" says above. Don't change or commit anything else.`;
}
