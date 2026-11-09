/**
 * R23: the factory never acts on a card with Blocked set. Every side effect a run makes (a
 * comment, a card move, a push, a PR) and every step that starts work (a sandbox, the gate, the
 * proof, an agent round, a merge) first re-reads that card's Blocked field; if Ryan set it
 * mid-run, the step doesn't happen and the run stops right there, posting nothing. A step already
 * running (a gate's `task check`) finishes first: Blocked stops the run at the next boundary.
 */
export class BlockedByRyan extends Error {
  readonly issue: number;
  /** The step it stopped before, as the ledger and the log say it ("the gate"). */
  readonly step: string;

  constructor(issue: number, step = 'the next step') {
    super(`#${issue} has Blocked set: stopped before ${step}`);
    this.name = 'BlockedByRyan';
    this.issue = issue;
    this.step = step;
  }
}

/** What a guarded method's call is, for the stop's reason: a name, or one made from its arguments. */
export type StepName = string | ((...args: never[]) => string);

/**
 * Wraps each named method so it checks `isBlocked()` first. `steps` names what a method's call
 * starts (`push` → "the push"), so the stop says where the run was; the method's name otherwise.
 */
export function guardEffects<T extends object>(
  target: T,
  keys: readonly (keyof T)[],
  issue: number,
  isBlocked: () => Promise<boolean>,
  steps: Partial<Record<keyof T, StepName>> = {},
): T {
  const guarded = { ...target };
  for (const key of keys) {
    const fn = target[key];
    if (typeof fn !== 'function') continue;
    (guarded as Record<keyof T, unknown>)[key] = async (...args: unknown[]) => {
      if (await isBlocked()) {
        const step = steps[key];
        throw new BlockedByRyan(
          issue,
          typeof step === 'function'
            ? (step as (...a: unknown[]) => string)(...args)
            : (step ?? `\`${String(key)}\``),
        );
      }
      return (fn as (...a: unknown[]) => unknown).apply(target, args);
    };
  }
  return guarded;
}

/** The steps of a run (RunDeps) as a stop names them. */
export const RUN_STEPS = {
  // The run's own step boundaries (run.ts calls step('the gate') before it).
  step: (name: string) => name,
  comment: 'a comment on the card',
  setStatus: 'moving the card',
  setBlocked: 'setting Blocked',
  openSandbox: 'opening its next sandbox (an agent round or the gate)',
  runAgent: "the agent's next round",
  numberDecisions: 'numbering its decisions',
  rebase: 'rebasing onto main',
  // `heavy` runs the gate and each proof: its label says which (`factory gate <branch>`).
  heavy: (label: string) => {
    const proof = /^factory proof (\w+)/.exec(label);
    if (proof) return `the ${proof[1]} proof`;
    return label.startsWith('factory gate') ? 'the gate' : label;
  },
  macVmCheck: 'the Mac proof',
  push: 'the push',
  openPr: 'opening the PR',
} as const;

/** The guarded steps of a run: every effect, and every step that starts work. */
export const RUN_GUARDED = Object.keys(RUN_STEPS) as (keyof typeof RUN_STEPS)[];
