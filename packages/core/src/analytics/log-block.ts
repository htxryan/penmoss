/**
 * The logs a bug report attaches (PEN-137, Logs in Send Feedback): the newest lines from the last
 * `report.hours` (no more than the logs keep), at most `report.lines` lines and `report.kb` KB,
 * after scrub #2; written into the issue as a collapsed "Anonymised Logs" block in a fence no
 * line can close, and cut from the oldest line so the body stays inside the Linear intake's
 * 60,000 characters.
 */
import { reportHours, type Limits } from './limits';

/** A log line starts with its ISO time: `2026-11-19T11:54:16.525Z info main …`. */
export function lineTime(line: string): number | null {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)\s/.exec(line);
  if (!match) return null;
  const time = Date.parse(match[1]!);
  return Number.isNaN(time) ? null : time;
}

/**
 * The lines to attach from `lines` (oldest first): those from the last hours the limits allow,
 * then the newest that fit the line and byte limits. A line without a time belongs to the line
 * before it (a stack's continuation).
 */
export function reportLines(lines: readonly string[], limits: Limits, now: number): string[] {
  const since = now - reportHours(limits) * 3_600_000;
  const maxLines = limits['report.lines'];
  const maxBytes = limits['report.kb'] * 1024;
  const encoder = new TextEncoder();
  const kept: string[] = [];
  let bytes = 0;
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]!;
    if (line === '') continue;
    const time = lineTime(line);
    if (time !== null && time < since) break;
    const size = encoder.encode(line).length + 1;
    if (kept.length >= maxLines || bytes + size > maxBytes) break;
    kept.push(line);
    bytes += size;
  }
  // Continuation lines whose own line was left out (too old, or past a limit) go with it.
  if (kept.some((each) => lineTime(each) !== null)) {
    while (kept.length > 0 && lineTime(kept.at(-1)!) === null) kept.pop();
  }
  return kept.reverse();
}

/** The byte size of the attached text, as the form writes it. */
export function textBytes(lines: readonly string[]): number {
  return new TextEncoder().encode(lines.join('\n')).length;
}

/** "9.6 KB": the size the form's summary shows. */
export function formatReportSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
}

/** A fence longer than any run of backticks in `text`. */
function fence(text: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  return '`'.repeat(longest + 1);
}

export const LOG_BLOCK_TITLE = 'Anonymised Logs';

/** The issue's collapsed block for `lines`, or '' when there are none. */
export function logBlock(lines: readonly string[]): string {
  if (lines.length === 0) return '';
  const text = lines.join('\n');
  const mark = fence(text);
  const noun = lines.length === 1 ? 'line' : 'lines';
  return [
    '<details>',
    `<summary>${LOG_BLOCK_TITLE} (${lines.length} ${noun})</summary>`,
    '',
    `${mark}text`,
    text,
    mark,
    '',
    '</details>',
  ].join('\n');
}

/** The Linear intake's body limit (`.github/scripts/linear-intake.mjs`). */
export const INTAKE_BODY_LIMIT = 60_000;

/**
 * The lines that fit when the rest of the body is `others` characters long: the oldest go first
 * until the block fits within `limit`.
 */
export function fitLogLines(
  lines: readonly string[],
  others: number,
  limit = INTAKE_BODY_LIMIT,
): string[] {
  let kept = [...lines];
  // The block, a blank line around it, and the margin for the intake's own header.
  const room = limit - others - 400;
  while (kept.length > 0 && logBlock(kept).length + 2 > room) kept = kept.slice(1);
  return kept;
}
