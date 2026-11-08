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
  const reserved = readReserved(reservedFile);
  const result = assignDecisionNumbers(texts, Math.max(maxDecision(main), reserved));
  writeReserved(reservedFile, reserved, result.assigned);
  return result;
}

function readReserved(reservedFile: string): number {
  try {
    return Number(readFileSync(reservedFile, 'utf8').trim()) || 0;
  } catch {
    return 0; // None given out yet.
  }
}

function writeReserved(
  reservedFile: string,
  reserved: number,
  assigned: Readonly<Record<string, string>>,
): void {
  const given = Object.values(assigned).map((a) => Number(a.slice(1)));
  const highest = Math.max(reserved, ...given);
  if (highest > reserved) writeFileSync(reservedFile, `${highest}\n`);
}

const ROW_ID = /^\|\s*A(\d{1,5})\s*\|/;

/**
 * After a rebase, the decision rows the branch added whose number main has since given to a
 * row of its own (a PR merged by hand, or one numbered before the factory's reservation file
 * knew of it), each with a new number after main's, the branch's and the reserved highest.
 * `added` holds the 1-based lines of `current` (the rebased docs/decisions.md) that the branch
 * added. A row the branch only edited keeps its number: main's copy of it is gone.
 */
export function takenDecisions(
  current: string,
  added: ReadonlySet<number>,
  main: string,
  reservedFile: string,
): Record<string, string> {
  const ids = new Map<string, number[]>();
  current.split('\n').forEach((line, i) => {
    const m = ROW_ID.exec(line);
    if (m) ids.set(`A${m[1]}`, [...(ids.get(`A${m[1]}`) ?? []), i + 1]);
  });
  const onMain = new Set(
    main
      .split('\n')
      .map((l) => ROW_ID.exec(l)?.[1])
      .filter(Boolean)
      .map((n) => `A${n}`),
  );
  const reserved = readReserved(reservedFile);
  let next = Math.max(maxDecision(main), maxDecision(current), reserved);
  const renumbered: Record<string, string> = {};
  for (const [id, lines] of ids)
    if (lines.length > 1 && onMain.has(id) && lines.some((l) => added.has(l)))
      renumbered[id] = `A${++next}`;
  writeReserved(reservedFile, reserved, renumbered);
  return renumbered;
}

/** `text` with each `A<n>` in `renumbered` replaced, on the given 1-based lines only. */
export function renumberLines(
  text: string,
  lines: ReadonlySet<number>,
  renumbered: Readonly<Record<string, string>>,
): string {
  return text
    .split('\n')
    .map((line, i) =>
      lines.has(i + 1) ? line.replaceAll(/\bA\d{1,5}\b/g, (id) => renumbered[id] ?? id) : line,
    )
    .join('\n');
}
