/**
 * The validate step (F19, #268), after the gate and proof pass: one agent session walks each
 * acceptance criterion of the agreed plan in the running web app and captures it beside the
 * agreed mockup; a second, independent session compares the pairs and gives each criterion a
 * verdict. Mismatches go back to the builder (the gate's fix rounds); what's left on the last
 * round goes in the PR as a deviation. F7 and F8 add the Mac and Android walkthroughs.
 */
import { parseReview, type FidelityRow } from './fidelity.ts';
import { fill, promptTemplate } from './prompt.ts';
import { runAgentPatiently, type RunDeps, type RunSandbox } from './run.ts';

export interface ValidateDeps extends Pick<
  RunDeps,
  'runAgent' | 'now' | 'sleep' | 'log' | 'heavy'
> {
  /** Copies the agreed mockups into the worktree's `.factory/mockups/`. */
  stageMockups(sandbox: RunSandbox): Promise<void>;
  /**
   * Copies what validation wrote (`.factory/validation/`: review.json, captures.json, the
   * screenshot and mockup pairs) into the run folder, as gate.log is kept: the worktree is gone
   * once the gate's sandbox closes (PEN-70's review was lost, A1256).
   */
  keepValidation(sandbox: RunSandbox): Promise<void>;
  /** `.factory/validation/review.json` from the worktree, as text, if it exists. */
  readReview(sandbox: RunSandbox): Promise<string | null>;
  /** Copies the rows' images into the PR body's folder as `fidelity-*`; returns the renamed rows. */
  collectFidelity(sandbox: RunSandbox, rows: readonly FidelityRow[]): Promise<FidelityRow[]>;
}

export async function validate(
  deps: ValidateDeps,
  sandbox: RunSandbox,
  branch: string,
  plan: string,
  /** What the builder says it couldn't do, and why (`result.json`'s `risks`). */
  builder: readonly string[] = [],
): Promise<{ ok: true; rows: FidelityRow[] } | { ok: false; error: string }> {
  return deps.heavy(`factory validation ${branch}`, async () => {
    await deps.stageMockups(sandbox);
    try {
      await runAgentPatiently(deps, sandbox, fill(promptTemplate('validate'), { branch, plan }));
      // A fresh session: the reviewer hasn't seen the build or the walkthrough, only their
      // results, and the builder's reasons for what it left undone, so a reason that holds is a
      // deviation.
      await runAgentPatiently(
        deps,
        sandbox,
        fill(promptTemplate('review'), {
          plan,
          builder: builder.length ? builder.map((r) => `- ${r}`).join('\n') : 'Nothing.',
        }),
      );
    } finally {
      // Kept whatever happened, a session that failed half-way included.
      await deps.keepValidation(sandbox);
    }
    const text = await deps.readReview(sandbox);
    if (text === null) return { ok: false, error: 'the reviewer wrote no review.json' };
    const parsed = parseReview(text);
    if (!parsed.ok) return parsed;
    deps.log('validated', {
      match: parsed.rows.filter((r) => r.verdict === 'match').length,
      mismatch: parsed.rows.filter((r) => r.verdict === 'mismatch').length,
      deviation: parsed.rows.filter((r) => r.verdict === 'deviation').length,
    });
    return { ok: true, rows: await deps.collectFidelity(sandbox, parsed.rows) };
  });
}
