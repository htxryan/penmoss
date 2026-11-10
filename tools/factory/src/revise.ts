/**
 * A review round (F11, #275): Ryan's new threads and comments go to the agent on the PR's own
 * branch; the gate and proof run again; the harness pushes, replies on each thread with the
 * commit that addresses it, posts new proof with `gh pr comment --attach`, and watches CI.
 * The card stays In review throughout.
 *
 * The round's marker comment goes up when the round starts, so anything Ryan adds while it
 * runs is after it, and the next round picks it up.
 */
import type { BoardItem } from './board.ts';
import type { IssueSpec } from './labels.ts';
import { classify } from './platforms.ts';
import { formatMarker } from './pick.ts';
import type { AttachedProof } from './proof/body.ts';
import type { AgentResult } from './result.ts';
import type { RoundItem } from './review.ts';
import {
  gateAndProve,
  refreshBranch,
  runAgentPatiently,
  STALE_MAIN,
  watchCi,
  type RunDeps,
} from './run.ts';

export interface ReviseDeps extends RunDeps {
  prComment(pr: string, body: string, proof?: readonly AttachedProof[]): Promise<void>;
  replyToThread(threadId: string, body: string): Promise<void>;
  headSha(branch: string): Promise<string>;
}

export interface ReviseInput {
  readonly item: BoardItem;
  readonly spec: IssueSpec;
  readonly pr: string;
  readonly branch: string;
  readonly items: readonly RoundItem[];
  /** The implement prompt, with the round's items (Ryan's words plain, others fenced) added. */
  readonly prompt: string;
}

export type ReviseOutcome =
  | { readonly kind: 'addressed'; readonly sha: string }
  | { readonly kind: 'blocked'; readonly reason: string };

export async function runRevise(deps: ReviseDeps, input: ReviseInput): Promise<ReviseOutcome> {
  const { item, spec, pr, branch } = input;
  const marker = (event: string) =>
    formatMarker({
      run: deps.runId,
      agent: spec.agent,
      model: spec.modelAlias,
      phase: 'revise',
      event,
    });
  const block = async (reason: string, body: string): Promise<ReviseOutcome> => {
    deps.log('blocked', { reason });
    await deps.comment(item.number, `${body}\n\n${marker('blocked')}`);
    await deps.setBlocked(item);
    return { kind: 'blocked', reason };
  };
  const threads = input.items.filter((i) => i.kind === 'thread' && i.trusted).length;
  await deps.prComment(
    pr,
    `Working on your review: ${input.items.filter((i) => i.trusted).length} item(s)${threads ? `, ${threads} in review threads` : ''}.\n\n${marker('round')}`,
  );
  deps.log('claimed', { issue: item.number, phase: 'revise' });

  let prompt = input.prompt;
  for (let round = 0; ; round++) {
    const work = await deps.openSandbox(branch);
    let result: AgentResult;
    try {
      await runAgentPatiently(deps, work, prompt);
      const read = await deps.readResult(work);
      if (!read.ok)
        return await block(
          read.error,
          `The review round finished without a usable result: ${read.error}.`,
        );
      if (read.result.status === 'needs-info') {
        const questions = read.result.questions.map((q, i) => `${i + 1}. ${q}`).join('\n');
        return await block(
          'needs-info',
          `To address your review, the agent needs answers first:\n\n${questions}`,
        );
      }
      if (read.result.status === 'failed')
        return await block('failed', `The review round couldn't finish: ${read.result.summary}`);
      result = read.result;
    } finally {
      await work.close();
    }
    const { paths } = await deps.diff(branch);
    // The round's own result, so the gate records the proof specs it names (R9).
    const verdict = await gateAndProve(deps, branch, classify(paths), spec, result);
    const { replies, summary } = result;
    if (verdict.ok) {
      await deps.push(branch);
      const sha = (await deps.headSha(branch)).slice(0, 10);
      for (const i of input.items) {
        if (i.kind !== 'thread' || !i.threadId || !i.trusted) continue;
        await deps.replyToThread(i.threadId, `${replies[i.threadId] ?? 'Addressed'} (${sha})`);
      }
      await deps.prComment(
        pr,
        `Addressed in ${sha}: ${summary}${verdict.proof.length ? '\n\nNew proof, recorded by the factory:' : ''}`,
        verdict.proof,
      );
      const ci = await watchCi(deps, {
        item,
        branch,
        scope: classify(paths),
        pr,
        prompt: input.prompt,
      });
      if (ci.kind === 'blocked') return block(ci.reason, ci.body);
      deps.log('in-review', { pr, round: 'addressed' });
      return { kind: 'addressed', sha };
    }
    if (verdict.block) return block(verdict.block, verdict.feedback);
    if (round >= deps.config.rounds.gateFix)
      return block(
        'gate-failed',
        `The review round's gate failed after ${round + 1} round(s): ${verdict.feedback}`,
      );
    prompt = `${input.prompt}\n\n## The gate's feedback (round ${round + 1})\n\n${verdict.feedback}\n\n${STALE_MAIN}`;
  }
}

/**
 * main moved and GitHub says the PR can't merge as it is (F6): rebase it onto main in a fresh
 * sandbox (new decision rows on both sides kept, renumbered if main took a number), gate it
 * again, push with the lease, and watch CI. A conflict the harness can't resolve gets one fix
 * round with the agent, then Blocked with the files named. The card stays In review.
 */
export async function runRebase(deps: ReviseDeps, input: ReviseInput): Promise<ReviseOutcome> {
  const { item, spec, pr, branch } = input;
  const marker = (event: string) =>
    formatMarker({
      run: deps.runId,
      agent: spec.agent,
      model: spec.modelAlias,
      phase: 'rebase',
      event,
    });
  const block = async (reason: string, body: string): Promise<ReviseOutcome> => {
    deps.log('blocked', { reason });
    await deps.comment(item.number, `${body}\n\n${marker('blocked')}`);
    await deps.setBlocked(item);
    return { kind: 'blocked', reason };
  };
  deps.log('claimed', { issue: item.number, phase: 'rebase' });
  const scope = classify((await deps.diff(branch)).paths);
  const fresh = await refreshBranch(deps, { branch, scope, prompt: input.prompt });
  if (!fresh.ok) return block(fresh.reason, fresh.body);
  const sha = (await deps.headSha(branch)).slice(0, 10);
  const kept = fresh.rebase.resolved.length
    ? ' Both sides added decisions, so `docs/decisions.md` keeps all the new rows, main’s first.'
    : '';
  const moved = Object.entries(fresh.rebase.renumbered);
  const renumbered = moved.length
    ? ` main already had ${moved.map(([from, to]) => `${from}, so this PR’s is now ${to}`).join('; ')}.`
    : '';
  // No marker in a PR comment: it would hide what Ryan said before it from the next round.
  await deps.prComment(
    pr,
    `main moved on, so this branch is rebased onto it as ${sha}, gated again and pushed.${kept}${renumbered}`,
  );
  const ci = await watchCi(deps, { item, branch, scope, pr, prompt: input.prompt });
  if (ci.kind === 'blocked') return block(ci.reason, ci.body);
  deps.log('in-review', { pr, round: 'rebased' });
  return { kind: 'addressed', sha };
}
