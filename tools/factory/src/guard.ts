/**
 * R23: the factory never acts on a card with Blocked set. Every side effect a run makes (a
 * comment, a card move, a push, a PR) first re-reads that card's Blocked field; if Ryan set it
 * mid-run, the effect doesn't happen and the run stops right there, posting nothing.
 */
export class BlockedByRyan extends Error {
  readonly issue: number;

  constructor(issue: number) {
    super(`#${issue} has Blocked set: stopping before the next step`);
    this.name = 'BlockedByRyan';
    this.issue = issue;
  }
}

/** Wraps each named method so it checks `isBlocked()` first. */
export function guardEffects<T extends object>(
  target: T,
  keys: readonly (keyof T)[],
  issue: number,
  isBlocked: () => Promise<boolean>,
): T {
  const guarded = { ...target };
  for (const key of keys) {
    const fn = target[key];
    if (typeof fn !== 'function') continue;
    (guarded as Record<keyof T, unknown>)[key] = async (...args: unknown[]) => {
      if (await isBlocked()) throw new BlockedByRyan(issue);
      return (fn as (...a: unknown[]) => unknown).apply(target, args);
    };
  }
  return guarded;
}
