/**
 * Usage limits (F13, R13): when the agent stops because its plan's limit is reached, the run
 * waits for the reset and runs the same round again. A limit isn't the agent's failure, so it
 * never uses up a gate or CI round.
 */

/**
 * What a run waiting on a usage limit says it waits for (`waitingFor`). An update doesn't wait
 * for such a run: it can sleep for hours (PEN-117: OpenCode Go's 5-hour limit), and the update
 * holds every other card's new work meanwhile (A1336). The restart stops it, and recovery runs the same
 * round again, which waits again until the reset.
 */
export const USAGE_LIMIT_WAIT = 'the usage limit to reset';

/** The longest the factory waits on one limit; anything longer is a mistake in the parse. */
const MAX_WAIT_MS = 6 * 3600_000;
/** When the message names no reset time. */
const DEFAULT_WAIT_MS = 30 * 60_000;

const LIMIT =
  /usage limit reached|(?:5-hour|weekly|session) limit reached|you['’]ve hit your (?:usage )?limit|rate[_ ]limit(?:ed)?|\b429\b.*too many requests/i;

/** Terminal colour codes, which OpenCode puts round its error line. */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

/**
 * The line that says the agent hit a usage limit, colours stripped, or `null` when none does. The
 * doctor shows it when a check couldn't run for that reason (A1376).
 */
export function usageLimitLine(output: string): string | null {
  const line = output
    .slice(-8000)
    .replaceAll(ANSI, '')
    .split('\n')
    .findLast((l) => LIMIT.test(l));
  return line === undefined ? null : line.trim().slice(0, 300);
}

/**
 * When the agent may run again, if its output says it hit a usage limit; `null` otherwise.
 * Understands Claude Code's `Claude AI usage limit reached|<epoch>` and `… resets 3pm`, and
 * OpenCode's `"retryAfterMs":…`, and falls back to a 30-minute wait for any other limit message.
 */
export function usageLimitReset(output: string, now: Date): Date | null {
  const tail = output.slice(-8000);
  if (!LIMIT.test(tail)) return null;
  const clamp = (at: number) =>
    new Date(Math.min(Math.max(at, now.getTime() + 60_000), now.getTime() + MAX_WAIT_MS));
  const epoch = /usage limit reached\|(\d{10})/i.exec(tail)?.[1];
  if (epoch) return clamp(Number(epoch) * 1000);
  // OpenCode's provider errors carry the wait: `"retryAfterMs":16032000` (OpenCode Go's 5-hour
  // limit, PEN-117), the last one in the output being the latest.
  const after = [...tail.matchAll(/"retryAfterMs"\s*:\s*(\d+)/g)].at(-1)?.[1];
  if (after) return clamp(now.getTime() + Number(after));
  const clock = /resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i.exec(tail);
  if (clock) {
    let hour = Number(clock[1]) % 12;
    if (clock[3]!.toLowerCase() === 'pm') hour += 12;
    const at = new Date(now);
    at.setHours(hour, Number(clock[2] ?? 0), 0, 0);
    if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
    return clamp(at.getTime());
  }
  return clamp(now.getTime() + DEFAULT_WAIT_MS);
}
