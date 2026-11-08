/**
 * Decisions an agent records as `A-NEW-1`, `A-NEW-2`… get real numbers after the rebase, so
 * two slots never claim the same one (F6). One A-NEW-k becomes the same A-number in every
 * file it appears in.
 */

/** The highest `A<n>` decision number in a text. */
export function maxDecision(text: string): number {
  let max = 0;
  for (const m of text.matchAll(/\bA(\d{1,5})\b/g)) max = Math.max(max, Number(m[1]));
  return max;
}

/** A-NEW-k → A<max + order of first appearance>, across all the given texts in order. */
export function assignDecisionNumbers(
  texts: readonly string[],
  max: number,
): { texts: string[]; assigned: Record<string, string> } {
  const assigned: Record<string, string> = {};
  let next = max;
  for (const text of texts) {
    for (const m of text.matchAll(/\bA-NEW-(\d+)\b/g)) {
      const key = `A-NEW-${m[1]}`;
      assigned[key] ??= `A${++next}`;
    }
  }
  return {
    texts: texts.map((t) => t.replaceAll(/\bA-NEW-(\d+)\b/g, (key) => assigned[key] ?? key)),
    assigned,
  };
}
