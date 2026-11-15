/**
 * One implementation run, start to finish (F4, #263): claim the card, give the agent a sandbox
 * on its own branch, gate its work in a fresh sandbox, then push, open the PR and move the card
 * to In review. Every outside effect goes through `RunDeps`, so the sequence is tested without
 * GitHub, git or an agent.
 *
 * The harness owns every side effect (R18): the agent only commits. A run that needs Ryan, or
 * that fails, says why on the issue and sets Blocked; the card keeps its status (R5).
 */
import type { BoardItem } from './board.ts';
import type { Platform } from './config.ts';
import { classify, type Scope } from './platforms.ts';
import { type FidelityRow, renderFidelity } from './fidelity.ts';
import { type AttachedProof, renderPrBody } from './proof/body.ts';
import { formatMarker } from './pick.ts';
import { numberText } from './decisions.ts';
import { settleRisks } from './risks.ts';
import type { AgentResult } from './result.ts';
import { branchName, prTitle } from './pr-title.ts';
import type { RunDeps, RunInput, RunOutcome } from './run-deps.ts';
import {
  repliesSection,
  STALE_MAIN,
  agentRound,
  releaseNoteOf,
  releaseNotePrompt,
} from './agent-round.ts';
import { oneLine, gateCommand, type Carried, gateAndProve } from './gate-run.ts';
import { bringUpToDate } from './refresh.ts';
import { stopRun, awaitReview } from './ci-watch.ts';

export async function runImplement(deps: RunDeps, input: RunInput): Promise<RunOutcome> {
  const { config, item, spec } = { config: deps.config, ...input };
  const marker = (event: string) =>
    formatMarker({
      run: deps.runId,
      agent: spec.agent,
      model: spec.modelAlias,
      phase: 'implement',
      event,
    });
  const block = async (reason: string, body: string): Promise<RunOutcome> => {
    deps.log('blocked', { reason });
    await deps.comment(item.number, `${body}\n\n${marker('blocked')}`);
    await deps.setBlocked(item);
    return { kind: 'blocked', reason };
  };

  const branch = branchName(config, item);
  // A recovered run whose agent had finished goes on from the gate, if its commits are there.
  const resumed =
    input.recovered && input.resume?.result.status === 'done'
      ? await deps.diff(branch).then(
          (d) => (d.commits > 0 ? input.resume : undefined),
          () => undefined,
        )
      : undefined;

  // Blocked after its PR was pushed (CI red, then a job re-run by hand): nothing changed since,
  // so the gate, proof and validation would only repeat themselves. Back to waiting on CI.
  const pr =
    resumed && deps.pushedPr ? await deps.pushedPr(branch).catch(() => undefined) : undefined;
  if (resumed && pr) {
    await deps.comment(
      item.number,
      `Restarted: ${pr} is as the factory last pushed it, so the run goes back to waiting on its CI, without running the gate, proof and validation again (A1298). ${spec.agent} (${spec.modelAlias}) on slot ${deps.slot.id}.\n\n${marker('claim')}`,
    );
    await deps.setStatus(item, config.status.working);
    deps.log('claimed', { issue: item.number });
    // As a resumed round logs it, so a later restart still finds the result.
    deps.log('agent-finished', { status: 'done', from: resumed.run });
    deps.log('resumed-at-ci', { pr });
    const { paths } = await deps.diff(branch);
    return awaitReview(
      deps,
      {
        item,
        branch,
        scope: classify(paths),
        result: resumed.result,
        marker,
        prompt: input.prompt,
      },
      pr,
    );
  }

  // Claim: the comment first, so a crash after it is recoverable from GitHub (the source of truth).
  const how = resumed
    ? `Restarted: this run stopped after its agent had finished (its work is committed on the branch), so it goes on from the gate rather than running the agent again (R12). ${spec.agent} (${spec.modelAlias}) on slot ${deps.slot.id}.`
    : input.recovered && input.replies?.length
      ? `Restarted: you commented after this run stopped, so its agent runs again on the same branch with your ${input.replies.length === 1 ? 'comment' : `${input.replies.length} comments`}, before the gate (R12). ${spec.agent} (${spec.modelAlias}) on slot ${deps.slot.id}.`
      : input.recovered
        ? `Restarted: this run stopped before it finished (the factory's daemon stopped, or Blocked paused it and has been cleared), so it runs again on the same branch (R12). ${spec.agent} (${spec.modelAlias}) on slot ${deps.slot.id}.`
        : `Started: ${spec.agent} (${spec.modelAlias}) on slot ${deps.slot.id}, implementing straight away${spec.planSkip ? ' (`plan:skip`)' : ''}.`;
  await deps.comment(
    item.number,
    `${how} Scope: ${spec.platforms?.join(', ') ?? 'decided by the path classifier'}.\n\n${marker('claim')}`,
  );
  await deps.setStatus(item, config.status.working);
  deps.log('claimed', { issue: item.number });

  // Recovered with Ryan's replies since its agent finished: the agent's round comes first.
  let prompt =
    input.recovered && input.replies?.length
      ? `${input.prompt}\n\n${repliesSection(branch, input.replies)}`
      : input.prompt;
  for (let round = 0; ; round++) {
    let result: AgentResult;
    if (round === 0 && resumed) {
      // The same event a finished round writes, naming where its result is, for a later restart.
      deps.log('agent-finished', { status: 'done', from: resumed.run });
      result = resumed.result;
    } else {
      const ran = await agentRound(deps, branch, prompt, round);
      if (!ran.ok)
        return block(ran.error, `The agent finished without a usable result: ${ran.error}.`);
      result = ran.result;
    }

    if (result.status === 'needs-info') {
      deps.log('needs-info', { questions: result.questions.length });
      const questions = result.questions.map((q, i) => `${i + 1}. ${q}`).join('\n');
      return block(
        'needs-info',
        `The agent needs your answers before it can go on:\n\n${questions}\n\nAnswer here, then clear **${config.blockedField}**.`,
      );
    }
    if (result.status === 'failed') {
      deps.log('failed', { summary: result.summary });
      return block('failed', `The agent couldn't finish: ${result.summary}`);
    }

    // Every PR carries a Release note (PEN-105, A1294). A missing or bad one goes back to the
    // agent once, with the check's own words, and blocks the run if it is still wrong.
    let note = releaseNoteOf(result);
    if (!note.ok) {
      deps.log('release-note-refused', { round, errors: note.errors.length });
      await deps.step('release-note round');
      const again = await agentRound(
        deps,
        branch,
        releaseNotePrompt(input.prompt, note.errors),
        round,
      );
      if (!again.ok)
        return block(again.error, `The agent finished without a usable result: ${again.error}.`);
      if (again.result.status !== 'done')
        return block(
          'release-note',
          `Asked only for its Release note, the agent stopped instead: ${again.result.summary}`,
        );
      result = again.result;
      note = releaseNoteOf(result);
      if (!note.ok)
        return block(
          'release-note',
          `The agent's Release note still doesn't pass the check, after one more try:\n\n${note.errors.map((e) => `- ${e}`).join('\n')}\n\nWrite it in \`.factory/result.json\` (\`releaseNote\`), or tell the agent what it is, then clear **${config.blockedField}**.`,
        );
    }

    const { paths, commits, subject } = await deps.diff(branch);
    if (commits === 0) return block('no-commits', 'The agent reported done but committed nothing.');
    // Commits that cancel out (PEN-80: a skip, then the gate's round took it back out) leave
    // nothing to review; a PR would be empty, titled after the undone commit (A1268).
    if (paths.length === 0)
      return block(
        'no-changes',
        `The agent reported done, but the branch's ${commits} commit(s) change nothing against main, so there is no PR to open: ${result.summary}`,
      );
    const scope = classify(paths);
    const verdict = await gateAndProve(
      deps,
      branch,
      scope,
      spec,
      result,
      input.plan
        ? { plan: input.plan, final: round >= config.rounds.gateFix, images: input.images ?? '' }
        : undefined,
      { carry: true },
    );
    if (verdict.ok) {
      return publish(deps, {
        item,
        branch,
        scope,
        result,
        releaseNote: note.text,
        ...(subject ? { subject } : {}),
        proof: verdict.proof,
        ...(verdict.fidelity ? { fidelity: verdict.fidelity } : {}),
        numbering: verdict.numbering,
        proved: verdict.proved,
        ...(verdict.carried ? { carried: verdict.carried } : {}),
        marker,
        prompt: input.prompt,
        ...(input.artifacts ? { artifacts: input.artifacts } : {}),
      });
    }
    if (verdict.block) return block(verdict.block, verdict.feedback);
    // A validation mismatch isn't a failed check: the ledger and the Factory UI say which it was.
    if (verdict.mismatches)
      deps.log('validation-mismatch', { round, criteria: verdict.mismatches });
    else deps.log('gate-failed', { round, reason: oneLine(verdict.reason) });
    if (round >= config.rounds.gateFix) {
      return block(
        'gate-failed',
        `The gate stopped this run after ${round + 1} round(s): ${verdict.feedback}`,
      );
    }
    // Another round: the agent sees exactly what the gate saw.
    await deps.step(`gate-fix round ${round + 1}`);
    prompt = `${input.prompt}\n\n## The gate's feedback (round ${round + 1})\n\nYour last attempt was committed on \`${branch}\`, but the gate refused it: ${verdict.feedback}\n\nFix that, commit, and write \`.factory/result.json\` again. ${STALE_MAIN}`;
  }
}

async function publish(
  deps: RunDeps,
  run: {
    item: BoardItem;
    branch: string;
    scope: Scope;
    result: AgentResult;
    /** The checked Release note, as the PR shows it. */
    releaseNote: string;
    /** The branch's first commit subject, for the title. */
    subject?: string;
    proof: readonly AttachedProof[];
    marker: (event: string) => string;
    prompt: string;
    artifacts?: RunInput['artifacts'];
    fidelity?: readonly FidelityRow[];
    /** The number each A-NEW-k on the branch has now: the body says those, not the placeholders. */
    numbering?: Readonly<Record<string, string>>;
    /** The platforms whose proof the harness ran and saw pass. */
    proved?: readonly Platform[];
    /** The earlier run the proof was carried over from, which the body says. */
    carried?: Carried;
  },
): Promise<RunOutcome> {
  // main may have moved while proof and validation ran (PEN-63's: 20 minutes, and another PR's
  // decision row merged meanwhile, so the PR it pushed conflicted and got no CI). Rebase once
  // more first; the gate runs again only when that brought in more than docs/decisions.md.
  let numbering = run.numbering ?? {};
  await deps.fetchMain();
  if (await deps.behindMain(run.branch)) {
    const fresh = await bringUpToDate(deps, run, { beforePush: true });
    if (!fresh.ok) return stopRun(deps, run, fresh.reason, fresh.body);
    numbering = fresh.numbering ?? numbering;
  }
  await deps.push(run.branch);
  deps.log('pushed', { branch: run.branch });
  const shown = forTheBody(run.result, run.fidelity, numbering, run.proved ?? []);
  const body = renderPrBody({
    issue: run.item.number,
    key: run.item.key,
    summary: shown.result.summary,
    releaseNote: run.releaseNote,
    scope: run.scope,
    gate: gateCommand(run.scope),
    proof: run.proof,
    decisions: shown.result.decisions,
    risks: shown.result.risks,
    marker: run.marker('pr'),
    ...(run.artifacts ? { artifacts: run.artifacts } : {}),
    ...(shown.fidelity ? { fidelity: renderFidelity(shown.fidelity) } : {}),
    ...(run.carried ? { carried: run.carried } : {}),
  });
  const pr = await deps.openPr({
    branch: run.branch,
    title: prTitle({
      title: shown.result.title,
      subject: run.subject,
      summary: shown.result.summary,
      key: run.item.key,
    }),
    body,
    proof: run.proof,
    files: (run.fidelity ?? []).flatMap((r) =>
      [r.mockup, r.screenshot].filter((f): f is string => Boolean(f)),
    ),
    ...(run.carried ? { proofFrom: run.carried.run } : {}),
  });
  deps.log('pr-opened', { pr });
  return awaitReview(deps, { ...run, result: shown.result }, pr);
}

/**
 * The agent's and the reviewer's text as the PR shows it: each A-NEW-k the gate numbered says
 * its number (in the summary, decisions, risks and the fidelity table's criteria and notes), and
 * the risks are settled against what the factory has since done (risks.ts).
 */
export function forTheBody(
  result: AgentResult,
  fidelity: readonly FidelityRow[] | undefined,
  numbering: Readonly<Record<string, string>>,
  proved: readonly Platform[],
): { result: AgentResult; fidelity?: FidelityRow[] } {
  const n = (text: string) => numberText(text, numbering);
  return {
    result: {
      ...result,
      summary: n(result.summary),
      decisions: result.decisions.map(n),
      risks: settleRisks(result.risks.map(n), proved),
    },
    ...(fidelity
      ? { fidelity: fidelity.map((r) => ({ ...r, criterion: n(r.criterion), note: n(r.note) })) }
      : {}),
  };
}
