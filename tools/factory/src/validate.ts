/**
 * The validate step (F19, #268), after the gate and proof pass: one agent session walks each
 * acceptance criterion of the agreed plan in the running web app, writes the Mac and Android
 * walkthroughs the host then runs (walk.ts, PEN-94), and captures each criterion beside the
 * agreed mockup; a second, independent session compares the pairs and gives each criterion a
 * verdict. Mismatches go back to the builder (the gate's fix rounds); what's left on the last
 * round goes in the PR as a deviation.
 */
import type { Platform } from './config.ts';
import { parseReview, type FidelityRow } from './fidelity.ts';
import { fill, promptTemplate } from './prompt.ts';
import {
  runAgentPatiently,
  whenVmFree,
  withTimeout,
  type RunDeps,
  type RunSandbox,
} from './run.ts';
import { walksText, type WalkOutcome, type WalkPlatform } from './walk.ts';

export interface ValidateDeps extends Pick<
  RunDeps,
  'config' | 'runAgent' | 'now' | 'sleep' | 'log' | 'heavy' | 'walk' | 'macVmCheck' | 'waitingFor'
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

/** The images section when the issue has none. */
const NO_IMAGES = 'The issue has none.';

export interface ValidateInput {
  /** The agreed plan's text. */
  readonly plan: string;
  /** What the builder says it couldn't do, and why (`result.json`'s `risks`). */
  readonly builder?: readonly string[];
  /** Where the issue's images are in the sandbox, or empty (A1277). */
  readonly images?: string;
  /** The platforms the change affects: each is walked on its own build (PEN-94). */
  readonly platforms?: readonly Platform[];
}

export async function validate(
  deps: ValidateDeps,
  sandbox: RunSandbox,
  branch: string,
  input: ValidateInput,
): Promise<{ ok: true; rows: FidelityRow[] } | { ok: false; error: string }> {
  const { plan, builder = [], images = '', platforms = ['web'] } = input;
  try {
    await deps.heavy(`factory validation ${branch}`, async () => {
      await deps.stageMockups(sandbox);
      await runAgentPatiently(
        deps,
        sandbox,
        fill(promptTemplate('validate'), {
          branch,
          plan,
          images: images || NO_IMAGES,
          platforms: platforms.join(', '),
        }),
      );
    });
    // The Mac and Android walkthroughs the session wrote, which only the host can run.
    const walks: WalkOutcome[] = [];
    for (const platform of WALKED.filter((p) => platforms.includes(p)))
      walks.push(await walkOn(deps, sandbox, branch, platform));
    // A fresh session: the reviewer hasn't seen the build or the walkthrough, only their
    // results, and the builder's reasons for what it left undone, so a reason that holds is a
    // deviation.
    await deps.heavy(`factory review ${branch}`, () =>
      runAgentPatiently(
        deps,
        sandbox,
        fill(promptTemplate('review'), {
          plan,
          images: images || NO_IMAGES,
          walks: walksText(walks),
          builder: builder.length ? builder.map((r) => `- ${r}`).join('\n') : 'Nothing.',
        }),
      ),
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
}

/** The apps walked by the host, in this order: the VM may make the Mac one wait. */
const WALKED: readonly WalkPlatform[] = ['android', 'mac'];

/**
 * One walkthrough, never a failure of validation: what went wrong goes to the reviewer, who
 * records it as a deviation. The Mac one waits for the test VM as a Mac proof does.
 */
async function walkOn(
  deps: ValidateDeps,
  sandbox: RunSandbox,
  branch: string,
  platform: WalkPlatform,
): Promise<WalkOutcome> {
  const failed = (problem: string): WalkOutcome => ({ platform, captures: [], problem });
  try {
    if (platform === 'mac') {
      const ran = await whenVmFree(
        deps,
        sandbox,
        'the Mac walkthrough',
        `factory walkthrough mac ${branch}`,
        (signal) => deps.walk(sandbox, 'mac', signal),
      );
      return ran.ok ? ran.value : failed(`It couldn't run: ${ran.why}`);
    }
    return await deps.heavy(`factory walkthrough ${platform} ${branch}`, () =>
      withTimeout(
        (signal) => deps.walk(sandbox, platform, signal),
        deps.config.timeouts.proofMinutes,
        `the ${platform} walkthrough`,
      ),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return failed(`It couldn't run: ${message}.`);
  }
}
