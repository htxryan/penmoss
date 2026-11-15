/**
 * A pushed PR on its way to In review (R4, F6): its CI watched until green, infrastructure
 * failures re-run (A1312), a flaky test re-run once (A1328), red checks repaired by the agent, and
 * a PR that conflicts with main rebased (A1311).
 */
import type { BoardItem } from './board.ts';
import { type CheckRun, runIdOf, summarizeChecks } from './checks.ts';
import {
  flakeCandidate,
  infraFailure,
  type InfraFailure,
  MAX_FLAKE_RERUNS,
  MAX_INFRA_RERUNS,
  passedOnMain,
  touchedBy,
} from './ci-failure.ts';
import type { RunJob } from './merge.ts';
import type { Scope } from './platforms.ts';
import type { AgentResult } from './result.ts';
import type { RunDeps, RunOutcome } from './run-deps.ts';
import { STALE_MAIN, runAndRead } from './agent-round.ts';
import { regate, refreshBranch } from './refresh.ts';

/** Stops the run: says why on the issue, with the marker, and sets Blocked. */
export async function stopRun(
  deps: RunDeps,
  run: { readonly item: BoardItem; readonly marker: (event: string) => string },
  reason: string,
  text: string,
): Promise<RunOutcome> {
  deps.log('blocked', { reason });
  await deps.comment(run.item.number, `${text}\n\n${run.marker('blocked')}`);
  await deps.setBlocked(run.item);
  return { kind: 'blocked', reason };
}

/** A pushed PR to In review: CI green (repaired if red), on top of main. */
export async function awaitReview(
  deps: RunDeps,
  run: {
    item: BoardItem;
    branch: string;
    scope: Scope;
    result: AgentResult;
    marker: (event: string) => string;
    prompt: string;
  },
  pr: string,
): Promise<RunOutcome> {
  const { config } = deps;
  const stop = (reason: string, text: string) => stopRun(deps, run, reason, text);
  // In review only once CI is green (R4); red checks go to a repair session (F6). A PR that
  // conflicts with main gets no CI: rebase it (gate, push) and watch again, a few times at most.
  let ci = await watchCi(deps, { ...run, pr });
  for (let refreshed = 0; ci.kind === 'conflict'; refreshed++) {
    if (refreshed >= MAX_CONFLICT_REFRESHES)
      return stop(
        'rebase-conflict',
        `${pr} still conflicts with main after ${refreshed} rebase(s), so GitHub runs no CI on it. Rebase it yourself, then clear Blocked.`,
      );
    deps.log('pr-conflicts', { pr });
    const fresh = await refreshBranch(deps, run);
    if (!fresh.ok) return stop(fresh.reason, fresh.body);
    ci = await watchCi(deps, { ...run, pr });
  }
  if (ci.kind === 'blocked') return stop(ci.reason, ci.body);
  // main may have moved while CI ran: rebase once more, so the PR reaches review on top of it.
  await deps.fetchMain();
  if (await deps.behindMain(run.branch)) {
    const fresh = await refreshBranch(deps, run);
    if (!fresh.ok) return stop(fresh.reason, fresh.body);
    const again = await watchCi(deps, { ...run, pr });
    if (again.kind === 'blocked') return stop(again.reason, again.body);
    if (again.kind === 'conflict')
      return stop(
        'rebase-conflict',
        `${pr} conflicts with main again right after a rebase, so GitHub runs no CI on it. Rebase it yourself, then clear Blocked.`,
      );
  }
  await deps.comment(
    run.item.number,
    `Ready for review, with CI green: ${pr}\n\n${run.marker('in-review')}`,
  );
  await deps.setStatus(run.item, config.status.review);
  await deps.notify(`Penmoss ${run.item.key} is ready for review`, run.result.summary);
  deps.log('in-review', { pr });
  return { kind: 'in-review', pr, scope: run.scope };
}

export type CiOutcome =
  | { readonly kind: 'green' }
  | { readonly kind: 'conflict' }
  | { readonly kind: 'blocked'; readonly reason: string; readonly body: string };

/** How often a run rebases a PR that GitHub says conflicts with main before Ryan hears (A1311). */
export const MAX_CONFLICT_REFRESHES = 2;

export async function watchCi(
  deps: RunDeps,
  run: { item: BoardItem; branch: string; scope: Scope; pr: string; prompt: string },
): Promise<CiOutcome> {
  const { config } = deps;
  let since = deps.now();
  // Counted for the PR, not for this call: a restart (Ryan clearing Blocked) doesn't give the
  // agent `rounds.ciRepair` more rounds (A1313).
  const history = deps.ciHistory?.(run.item.number, run.pr);
  let repairs = history?.repairs ?? 0;
  const reruns = new Map(history?.reruns);
  let flakeReruns = history?.flakeReruns ?? 0;
  let saidStalled = false;
  let empty = 0;
  for (;;) {
    await deps.sleep(config.pollSeconds);
    const checks = await deps.checks(run.pr);
    const summary = summarizeChecks(checks, deps.now(), config.timeouts.ciMinutes, since);
    if (summary.kind === 'green') return { kind: 'green' };
    // No checks at all after a couple of polls: GitHub runs no CI on a PR that conflicts with main.
    empty = checks.length === 0 ? empty + 1 : 0;
    if (empty >= 2 && deps.conflicts && (await deps.conflicts(run.pr).catch(() => false)))
      return { kind: 'conflict' };
    if (summary.kind === 'pending') continue;
    if (summary.kind === 'stalled') {
      // No runner has taken the jobs: a pause, not a failure. Say so once and keep waiting.
      if (!saidStalled) {
        deps.log('ci-stalled', { queued: summary.queued.map((c) => c.name) });
        await deps.comment(
          run.item.number,
          `CI is waiting for a free Mac runner (${summary.queued.map((c) => c.name).join(', ')}). The run carries on when one picks it up.`,
        );
        saidStalled = true;
      }
      continue;
    }
    const logs = await failedLogs(deps, summary.failed);
    deps.log('ci-red', { failed: summary.failed.map((c) => c.name), repairs });
    // Ryan's comment names the failing jobs and their last log lines, whichever way it stops.
    const failure = ciFailureText(run.pr, summary.failed, logs);
    // The runners' infrastructure, not the branch: re-run the failed jobs, no agent (A1312).
    const infra = infraFailure(summary.failed, logs);
    if (infra) {
      const rerun = await rerunInfra(deps, run, infra, reruns, failure);
      if (rerun.kind === 'blocked') return rerun;
      since = deps.now();
      saidStalled = false;
      continue;
    }
    // Tests the branch doesn't touch, in jobs that pass on main: one re-run first (A1328).
    if (flakeReruns < MAX_FLAKE_RERUNS && (await rerunFlake(deps, run, summary.failed, logs))) {
      flakeReruns++;
      since = deps.now();
      saidStalled = false;
      continue;
    }
    if (repairs >= config.rounds.ciRepair) {
      return {
        kind: 'blocked',
        reason: 'ci-red',
        body: `CI is still red after ${repairs} repair round(s): ${failure}`,
      };
    }
    repairs++;
    const repaired = await repair(deps, run, logs.join('\n\n'), repairs);
    if (!repaired.ok)
      return {
        kind: 'blocked',
        reason: 'ci-red',
        body: `A CI repair round couldn't finish: ${repaired.why}\n\nCI is red: ${failure}`,
      };
    deps.log('ci-repaired', { round: repairs, pr: run.pr });
    since = deps.now();
    saidStalled = false;
  }
}

/** The PR, its failed jobs (linked, with their Actions run) and their last log lines. */
export function ciFailureText(
  pr: string,
  failed: readonly CheckRun[],
  logs: readonly string[],
): string {
  return `${pr}\n\n${failed.map((c) => `- [${c.name}](${c.link})${runIdOf(c) ? ` (run ${runIdOf(c)})` : ''}`).join('\n')}\n\n${logs.join('\n\n')}`;
}

/**
 * Re-runs the failed jobs of an infrastructure failure (A1312), each Actions run at most
 * `MAX_INFRA_RERUNS` times (counted from the ledger too, so a restart doesn't reset it), and says
 * so on the issue the first time. After that the failure is Ryan's: no agent can fix the runners.
 * `reruns` is updated in place.
 */
export async function rerunInfra(
  deps: Pick<RunDeps, 'rerunFailed' | 'comment' | 'log'>,
  run: { readonly item: BoardItem; readonly pr: string },
  infra: InfraFailure,
  reruns: Map<string, number>,
  failure: string,
): Promise<{ readonly kind: 'rerun' } | Extract<CiOutcome, { kind: 'blocked' }>> {
  if ([...infra.runs.keys()].some((id) => (reruns.get(id) ?? 0) >= MAX_INFRA_RERUNS))
    return {
      kind: 'blocked',
      reason: 'ci-infra',
      body: `CI failed on the runners' infrastructure, not on this branch (${infra.signature}), and again after ${MAX_INFRA_RERUNS} re-runs, so no agent was asked to change anything: ${failure}\n\nRe-run the failed jobs once GitHub has recovered. When they pass, clear Blocked: the run goes back to waiting on CI (A1298).`,
    };
  let first = false;
  for (const [id, jobs] of infra.runs) {
    const attempt = (reruns.get(id) ?? 0) + 1;
    await deps.rerunFailed(id);
    reruns.set(id, attempt);
    deps.log('ci-rerun', { actionsRun: id, jobs, signature: infra.signature, attempt, pr: run.pr });
    if (attempt === 1) first = true;
  }
  if (first)
    await deps.comment(
      run.item.number,
      `CI failed on an infrastructure problem, not on this branch (${infra.signature}): ${[...infra.runs.values()].flat().join(', ')}. The factory is re-running the failed jobs, up to ${MAX_INFRA_RERUNS} times, rather than giving the agent a repair round. ${run.pr}`,
    );
  return { kind: 'rerun' };
}

/**
 * Re-runs the failed jobs, once per PR, when they look like a flaky test rather than the branch
 * (A1328, amending A1312): every failed job's log names the tests that failed, the branch's diff
 * against main touches none of them (nor a file with their stem), and each job passed the last
 * time main's CI ran it. Logs `ci-flake-rerun` (the ledger counts it per PR, so clearing Blocked
 * buys no more) and says so on the issue. False, with nothing done, when any of that doesn't hold
 * or can't be read: the failure is the branch's and gets a repair round, as before.
 */
export async function rerunFlake(
  deps: Pick<RunDeps, 'rerunFailed' | 'comment' | 'log'> &
    Partial<Pick<RunDeps, 'diff' | 'mainRunJobs'>>,
  run: { readonly item: BoardItem; readonly pr: string; readonly branch: string },
  failed: readonly CheckRun[],
  logs: readonly string[],
): Promise<boolean> {
  const { diff, mainRunJobs } = deps;
  if (!diff || !mainRunJobs) return false;
  const flake = flakeCandidate(failed, logs);
  if (!flake) return false;
  try {
    const { paths } = await diff(run.branch);
    if (flake.tests.some((t) => touchedBy(t, paths))) return false;
    const onMain = new Map<string, readonly (readonly RunJob[])[]>();
    for (const check of failed) {
      if (!check.workflow) return false;
      const runs = onMain.get(check.workflow) ?? (await mainRunJobs(check.workflow));
      onMain.set(check.workflow, runs);
      if (!passedOnMain(check.name, runs)) return false;
    }
  } catch {
    return false;
  }
  try {
    for (const id of flake.runs.keys()) await deps.rerunFailed(id);
  } catch {
    // GitHub refused the re-run (a run still going, say): the repair round goes ahead.
    return false;
  }
  const jobs = [...flake.runs.values()].flat();
  deps.log('ci-flake-rerun', {
    pr: run.pr,
    jobs,
    tests: flake.tests,
    actionsRuns: [...flake.runs.keys()],
  });
  await deps.comment(
    run.item.number,
    `CI failed in tests this branch doesn't change, in jobs that pass on main (${flake.tests.join(', ')}): ${jobs.join(', ')}. The factory is re-running the failed jobs once, in case the tests are flaky, before giving the agent a repair round. ${run.pr}`,
  );
  return true;
}

/** Each failed job's last log lines, as the repair prompt and Ryan's comment show them. */
export function failedLogs(
  deps: Pick<RunDeps, 'failedLog'>,
  failed: readonly CheckRun[],
): Promise<string[]> {
  return Promise.all(
    failed.map(async (c) => `### ${c.name}\n\n\`\`\`\n${await deps.failedLog(c)}\n\`\`\``),
  );
}

/** One repair session: the failed logs to the agent, then the gate again, then a push. */
async function repair(
  deps: RunDeps,
  run: { branch: string; scope: Scope; prompt: string },
  logs: string,
  round: number,
): Promise<{ ok: true } | { ok: false; why: string }> {
  await deps.step(`CI repair round ${round}`);
  const work = await deps.openSandbox(run.branch);
  try {
    const read = await runAndRead(
      deps,
      work,
      `${run.prompt}\n\n## CI failed (repair round ${round})\n\nThe PR from \`${run.branch}\` is open and its CI failed. The failed jobs' last log lines:\n\n${logs}\n\nFix the cause (never by weakening or skipping tests), commit, and write \`.factory/result.json\` again. ${CI_REPAIR_LIMITS} ${STALE_MAIN}`,
      { phase: 'ci-repair', round },
    );
    if (!read.ok) return { ok: false, why: read.error };
    if (read.result.status !== 'done') return { ok: false, why: read.result.summary };
  } finally {
    await work.close();
  }
  const gated = await regate(deps, run.branch, run.scope);
  if (!gated.ok)
    return {
      ok: false,
      why: gated.conflict
        ? `the repaired branch no longer rebases cleanly onto main (${gated.conflict.map((f) => `\`${f}\``).join(', ')} conflict)`
        : gated.why,
    };
  await deps.push(run.branch);
  return { ok: true };
}

/**
 * What a CI repair round can't change (A1314). Given only an apt log, PEN-73's repair round
 * added a retry loop to `ci.yml`, a change unrelated to its PR that GitHub then refused to take
 * from the factory's app.
 */
export const CI_REPAIR_LIMITS =
  "The factory can't push changes under `.github/workflows/` (its GitHub App has no workflows permission, and the gate refuses them), so never edit those files. A failure in the runner's network or in a hosted service (a name that doesn't resolve, a registry's 5xx, a runner that shut down, an apt mirror that can't be reached) isn't this branch's to fix: change nothing, and write `.factory/result.json` with status `failed` and the log lines that show it in `summary`.";
