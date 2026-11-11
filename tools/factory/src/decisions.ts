/**
 * Decisions an agent records as `A-NEW-1`, `A-NEW-2`… get real numbers after the rebase, so
 * two slots never claim the same one (F6). Only placeholders the branch added are numbered: a
 * `| A-NEW-k |` row it added to docs/decisions.md defines one, and its other added lines that
 * name a defined key get the same number. A placeholder in text the branch didn't add (AGENTS.md's
 * own instructions, say) or one it never defined is left alone.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';

/** The highest `A<n>` decision number in a text. */
export function maxDecision(text: string): number {
  let max = 0;
  for (const m of text.matchAll(/\bA(\d{1,5})\b/g)) max = Math.max(max, Number(m[1]));
  return max;
}

const NEW_ROW = /^\|\s*(A-NEW-\d+)\s*\|/;
const PLACEHOLDER = /\bA-NEW-\d+\b/g;

/**
 * The A-NEW-k keys a branch defines, in order of their rows: the decision rows among `added`,
 * the 1-based lines of docs/decisions.md that the branch added.
 */
export function definedPlaceholders(decisions: string, added: ReadonlySet<number>): string[] {
  const keys: string[] = [];
  decisions.split('\n').forEach((line, i) => {
    const key = added.has(i + 1) ? NEW_ROW.exec(line)?.[1] : undefined;
    if (key && !keys.includes(key)) keys.push(key);
  });
  return keys;
}

/**
 * Real numbers for `keys`, in order, after both main's highest decision and the highest one the
 * factory has already given out (kept in `reservedFile`), then records the new highest. Two
 * slots running at once both rebase onto the same main, so main alone would give them the same
 * number; the file makes the second slot's numbers follow the first's. Reading, numbering and
 * writing the file happen with no `await` between them, so the daemon's runs can't interleave
 * here. No keys: nothing is reserved and the file isn't touched.
 */
export function reserveDecisionNumbers(
  keys: readonly string[],
  main: string,
  reservedFile: string,
): Record<string, string> {
  if (keys.length === 0) return {};
  const reserved = readReserved(reservedFile);
  let next = Math.max(maxDecision(main), reserved);
  const assigned: Record<string, string> = {};
  for (const key of keys) assigned[key] ??= `A${++next}`;
  writeReserved(reservedFile, reserved, assigned);
  return assigned;
}

/**
 * `text` with each assigned A-NEW-k replaced on the given 1-based lines only. Lines the branch
 * didn't add, and placeholders it didn't define, stay as they are.
 */
export function numberLines(
  text: string,
  lines: ReadonlySet<number>,
  assigned: Readonly<Record<string, string>>,
): string {
  return text
    .split('\n')
    .map((line, i) =>
      lines.has(i + 1) ? line.replaceAll(PLACEHOLDER, (key) => assigned[key] ?? key) : line,
    )
    .join('\n');
}

/**
 * `text` with each assigned A-NEW-k replaced, whole words only (`A-NEW-1` is not inside
 * `A-NEW-10`): the agent's and the reviewer's text in the PR body, written before the gate
 * numbered the decisions.
 */
export function numberText(text: string, assigned: Readonly<Record<string, string>>): string {
  return text.replaceAll(PLACEHOLDER, (key) => assigned[key] ?? key);
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

/** The factory's own docs/decisions.md: where its Prettier settings are read, never the branch's. */
const OWN_DECISIONS = fileURLToPath(new URL('../../../docs/decisions.md', import.meta.url));

/**
 * docs/decisions.md formatted as `task check` wants it, once its placeholders are numbered.
 * `A-NEW-1` is wider than the table's ID column, so an agent's own Prettier run pads every row
 * to fit it; the number that replaces it is narrower, and the gate's Prettier check failed on
 * the table (PEN-70's run, 9 Nov 2026). The settings are the factory's own, with no plugins:
 * a branch's Prettier config could load code on the host.
 */
export async function formatDecisions(text: string): Promise<string> {
  const options = (await resolveConfig(OWN_DECISIONS, { editorconfig: false })) ?? {};
  return format(text, { ...options, plugins: [], filepath: OWN_DECISIONS });
}
