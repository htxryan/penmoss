/**
 * Bringing a pushed branch up to date with main (F6): rebased in a fresh sandbox and gated again,
 * with one fix round for the agent before it is Ryan's.
 */
import type { Scope } from './platforms.ts';
import { scanWeakenedTests, weakenedFeedback, workflowChanges, workflowFeedback } from './gate.ts';
import { DECISIONS, sandboxNumbering } from './rebase.ts';
import { excerpt } from './gate-log.ts';
import type { ResultRead, RunDeps } from './run-deps.ts';
import { STALE_MAIN, runAndRead } from './agent-round.ts';
import {
  GATE_INSTALL,
  gateExec,
  installFeedback,
  INSTALL_REASON,
  conflictReason,
  weakenedReason,
  oneLine,
  gateCommand,
  type Rebased,
  conflictFeedback,
  noteRebase,
} from './gate-run.ts';

export type Regated =
  | {
      readonly ok: true;
      readonly rebase: Rebased;
      /** The number each A-NEW-k on the branch has now (`branchNumbering`), when asked for. */
      readonly numbering?: Readonly<Record<string, string>>;
    }
  | {
      readonly ok: false;
      readonly why: string;
      /** The refusal in one short line, for the ledger and daemon.log (`gate-failed`). */
      readonly reason: string;
      readonly conflict?: readonly string[];
    };

/**
 * The branch rebased onto a fresh main in a gate sandbox, and the gate run on it again. `light`:
 * when the rebase changed nothing but docs/decisions.md (main's new decision rows, a number
 * moved), the gate's check is skipped: the code it passed is the code that is there.
 * `numbering`: also read the number each A-NEW-k has on the branch, for a PR body.
 */
export async function regate(
  deps: RunDeps,
  branch: string,
  scope: Scope,
  options: { readonly light?: boolean; readonly numbering?: boolean } = {},
): Promise<Regated> {
  await deps.step('the gate');
  await deps.fetchMain();
  const gate = await deps.openSandbox(branch);
  const numbering = async () =>
    options.numbering ? { numbering: await sandboxNumbering(gate) } : {};
  try {
    const before = options.light ? await gate.exec('git rev-parse HEAD') : undefined;
    const rebased = await deps.rebase(gate);
    if (rebased.kind === 'conflict')
      return {
        ok: false,
        why: conflictFeedback(branch, rebased),
        reason: conflictReason(rebased.files),
        conflict: rebased.files,
      };
    noteRebase(deps, rebased);
    const numbered = await deps.numberDecisions(gate, branch);
    if (Object.keys(numbered).length > 0) deps.log('decisions-numbered', numbered);
    if (before?.exitCode === 0 && /^[0-9a-f]{7,64}$/.test(before.stdout.trim())) {
      const changed = await gate.exec(`git diff --name-only ${before.stdout.trim()} HEAD`);
      const paths = changed.stdout.split('\n').filter(Boolean);
      if (changed.exitCode === 0 && paths.every((path) => path === DECISIONS)) {
        deps.log('rebased', { phase: 'push', gate: 'skipped', changed: paths });
        return { ok: true, rebase: rebased, ...(await numbering()) };
      }
    }
    const installed = await gateExec(gate, GATE_INSTALL, deps.config.timeouts.gateMinutes);
    if (installed.exitCode !== 0)
      return { ok: false, why: installFeedback(installed), reason: INSTALL_REASON };
    const patch = (await gate.exec('git diff origin/main...HEAD')).stdout;
    const weak = scanWeakenedTests(patch);
    if (weak.length > 0)
      return { ok: false, why: weakenedFeedback(weak), reason: weakenedReason(weak) };
    const workflows = workflowChanges(patch);
    if (workflows.length > 0)
      return {
        ok: false,
        why: workflowFeedback(workflows),
        reason: `workflow change: ${workflows.join(', ')}`,
      };
    const command = gateCommand(scope);
    const checked = await deps.heavy(`factory gate ${branch}`, () =>
      gateExec(gate, command, deps.config.timeouts.gateMinutes),
    );
    if (checked.exitCode !== 0) {
      deps.keep?.('gate.log', checked.stdout + checked.stderr);
      return {
        ok: false,
        reason: `${command} failed`,
        why: `\`${command}\` failed:\n\n\`\`\`\n${excerpt(checked.stdout + checked.stderr)}\n\`\`\``,
      };
    }
    deps.log('gate-passed', { command, phase: 'rebase' });
    return { ok: true, rebase: rebased, ...(await numbering()) };
  } finally {
    await gate.close();
  }
}

function stuck(
  branch: string,
  failed: Extract<Regated, { ok: false }>,
  why: string,
): Extract<RefreshOutcome, { ok: false }> {
  const files = failed.conflict?.map((f) => `\`${f}\``).join(', ');
  return failed.conflict
    ? {
        ok: false,
        reason: 'rebase-conflict',
        body: `\`${branch}\` no longer rebases onto main${files ? `: ${files} conflict` : ''}, and a fix round with the agent didn't resolve it${why}. Rebase it yourself or say how in a comment, then clear Blocked.\n\n${failed.why}`,
      }
    : {
        ok: false,
        reason: 'gate-failed',
        body: `After rebasing onto main, the gate still fails${why}: ${failed.why}`,
      };
}

export type RefreshOutcome =
  | {
      readonly ok: true;
      readonly rebase: Rebased;
      readonly numbering?: Readonly<Record<string, string>>;
    }
  | { readonly ok: false; readonly reason: string; readonly body: string };

/**
 * Brings a pushed branch up to date with main (F6): rebase in a fresh sandbox, the gate again,
 * then the host's leased push. A conflict the harness can't resolve, or a gate the rebase broke,
 * gets one fix round with the agent; after that it is Ryan's, with the files named.
 */
export async function refreshBranch(
  deps: RunDeps,
  run: { readonly branch: string; readonly scope: Scope; readonly prompt: string },
): Promise<RefreshOutcome> {
  const fresh = await bringUpToDate(deps, run);
  if (!fresh.ok) return fresh;
  await deps.push(run.branch);
  deps.log('pushed', { branch: run.branch, phase: 'rebase' });
  return fresh;
}

/**
 * `refreshBranch` without the push: the branch rebased onto main and gated again, with one fix
 * round for the agent. `beforePush`, the first push's: the gate's check is skipped when the
 * rebase brought in nothing but docs/decisions.md (`regate`'s `light`; after an agent's fix
 * round it always runs), and the outcome has the branch's decision numbers for the PR body.
 */
export async function bringUpToDate(
  deps: RunDeps,
  run: { readonly branch: string; readonly scope: Scope; readonly prompt: string },
  options: { readonly beforePush?: boolean } = {},
): Promise<RefreshOutcome> {
  const numbering = options.beforePush ?? false;
  let gated = await regate(deps, run.branch, run.scope, { light: numbering, numbering });
  if (!gated.ok) {
    const first = gated;
    deps.log(first.conflict ? 'rebase-conflict' : 'gate-failed', {
      ...(first.conflict ? { files: first.conflict } : {}),
      phase: 'rebase',
      reason: oneLine(first.reason),
    });
    const ask = first.conflict
      ? `## \`origin/main\` moved: rebase onto it\n\n\`${run.branch}\` no longer rebases onto \`origin/main\`. ${first.why}\n\nKeep what \`origin/main\` changed and what this branch changes. ${STALE_MAIN} Run the checks, commit, and write \`.factory/result.json\` again.`
      : `## The gate after rebasing onto \`origin/main\`\n\n\`${run.branch}\` is now on top of \`origin/main\`, and the gate fails there: ${first.why}\n\nFix the cause (never by weakening or skipping tests), commit, and write \`.factory/result.json\` again. ${STALE_MAIN}`;
    const work = await deps.openSandbox(run.branch);
    let read: ResultRead;
    try {
      read = await runAndRead(deps, work, `${run.prompt}\n\n${ask}`, { phase: 'rebase' });
    } finally {
      await work.close();
    }
    const stopped = !read.ok
      ? read.error
      : read.result.status !== 'done'
        ? read.result.summary
        : undefined;
    if (stopped !== undefined)
      return stuck(run.branch, first, ` (the agent's fix round stopped: ${stopped})`);
    gated = await regate(deps, run.branch, run.scope, { numbering });
    if (!gated.ok) return stuck(run.branch, gated, '');
  }
  return {
    ok: true,
    rebase: gated.rebase,
    ...(gated.numbering ? { numbering: gated.numbering } : {}),
  };
}
