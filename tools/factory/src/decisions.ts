/**
 * Decisions an agent records as `A-NEW-1`, `A-NEW-2`… get real numbers after the rebase, so
 * two slots never claim the same one (F6). One A-NEW-k becomes the same A-number in every
 * file it appears in.
 */
import { readFileSync, writeFileSync } from 'node:fs';

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

/**
 * Numbers the texts after both main's highest decision and the highest one the factory has
 * already given out (kept in `reservedFile`), then records the new highest. Two slots running
 * at once both rebase onto the same main, so main alone would give them the same number; the
 * file makes the second slot's numbers follow the first's. Reading, numbering and writing the
 * file happen with no `await` between them, so the daemon's runs can't interleave here.
 */
export function reserveDecisionNumbers(
  texts: readonly string[],
  main: string,
  reservedFile: string,
): { texts: string[]; assigned: Record<string, string> } {
  let reserved = 0;
  try {
    reserved = Number(readFileSync(reservedFile, 'utf8').trim()) || 0;
  } catch {
    // None given out yet.
  }
  const result = assignDecisionNumbers(texts, Math.max(maxDecision(main), reserved));
  const given = Object.values(result.assigned).map((a) => Number(a.slice(1)));
  const highest = Math.max(reserved, ...given);
  if (highest > reserved) writeFileSync(reservedFile, `${highest}\n`);
  return result;
}
