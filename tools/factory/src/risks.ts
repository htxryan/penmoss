/**
 * The agent's risks as the PR shows them, after the factory has done what the agent couldn't.
 * The agent writes its risks in its sandbox, where the Mac spec (no test VM) and the Android
 * instrumented test (no emulator) can't run, and before the gate numbers its decisions. By the
 * time the PR opens, the factory's proof has run those specs and the gate has numbered and
 * formatted the decisions table, so the PR showed risks that were no longer true (PEN-63, PEN-73).
 *
 * A risk that says an in-scope platform's spec couldn't be run here is kept, with a note that the
 * factory's proof ran it and it passed: the same sentence may carry a real risk too, and a note
 * can't lose one. A risk that is only about the decisions table's padding or numbering, every
 * clause of it, is dropped: that is the factory's own work.
 */
import type { Platform } from './config.ts';

/** The words that name each platform's spec, the app or where it runs. */
const PLATFORM: Readonly<Record<Platform, RegExp>> = {
  web: /\b(?:web|Playwright|Chromium|browser)\b/i,
  mac: /\b(?:Mac|macOS|desktop|Electron|test VM|VM)\b/i,
  android: /\b(?:Android|emulator|instrumented)\b/i,
};

const NAME: Readonly<Record<Platform, string>> = { web: 'web', mac: 'Mac', android: 'Android' };

/** Says something wasn't run (or couldn't be) here. */
const UNRUN =
  /\b(?:could(?:\s*not|n['’]t)|can(?:not|['’]t)|unable to|was(?:\s*not|n['’]t)|were(?:\s*not|n['’]t)|not|never)\s+(?:be\s+|been\s+)?(?:run|ran|executed|started|launched|verified|tested)\b|\bno\s+(?:test\s+)?(?:VM|emulator|simulator|device)\b|\b(?:untested|unverified|not\s+run)\b/i;

/** The decisions table, by name or by a placeholder row. */
const DECISIONS =
  /\bdecisions?(?:\.md)?\s+(?:table|row|rows|file)\b|\bdecisions\.md\b|\bA-NEW-\d+\b/i;

/** What the factory does to that table itself: pads it, numbers its rows, formats it. */
const HOUSEKEEPING =
  /\b(?:re-?pad\w*|padd(?:ed|ing)|pads?|renumber\w*|numbering|numbered|numbers\s+(?:it|them)|reformat\w*|Prettier|column\s+widths?|ID\s+column|whitespace)\b/i;

/** Clauses: split at a full stop or semicolon before a space or the end (not `decisions.md`). */
const clauses = (text: string) =>
  text
    .split(/[.;](?=\s|$)/)
    .map((c) => c.trim())
    .filter(Boolean);

/** Only about the decisions table's padding or numbering, in every clause. */
export function onlyTableHousekeeping(risk: string): boolean {
  const parts = clauses(risk);
  return DECISIONS.test(risk) && parts.length > 0 && parts.every((c) => HOUSEKEEPING.test(c));
}

/** The proved platforms a risk says it couldn't run, in the order given. */
export function unrunPlatforms(risk: string, proved: readonly Platform[]): Platform[] {
  if (!UNRUN.test(risk)) return [];
  return proved.filter((p) => PLATFORM[p].test(risk));
}

/**
 * The risks for the PR body: table housekeeping dropped, and a note on each one that says a
 * platform's spec couldn't be run where the factory's proof has since run it and seen it pass.
 */
export function settleRisks(risks: readonly string[], proved: readonly Platform[]): string[] {
  const out: string[] = [];
  for (const risk of risks) {
    if (onlyTableHousekeeping(risk)) continue;
    const ran = unrunPlatforms(risk, proved);
    if (ran.length === 0) {
      out.push(risk);
      continue;
    }
    const names = ran.map((p) => NAME[p]);
    const list =
      names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0];
    const specs = names.length > 1 ? 'specs' : 'spec';
    out.push(`${risk.trimEnd()} (The factory's proof ran the ${list} ${specs}: passed.)`);
  }
  return out;
}
