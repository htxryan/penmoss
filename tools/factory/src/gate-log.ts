/**
 * What a failed check's log says, short enough for a comment and the agent's feedback (F9: out of
 * run.ts): the error lines, Playwright's failure blocks, and an excerpt of the rest.
 */

export function tail(text: string): string {
  return text.trim().split('\n').slice(-30).join('\n');
}

const ERROR_LINE = /\berror\b|✖|✘|×|\bFAIL\b|\bfailed\b/i;

/** A terminal colour code (ESC, then `[…m` and the like). */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, 'g');
/** A failure's heading in Playwright's list reporter: `  1) [chromium] › a.spec.ts:12:3 › title`. */
const PW_FAILURE = /^ {2}(\d+)\) (\S.*(›|:\d+:\d+).*)$/;
/** The line that ends a failure's own block: its first attachment or its error context. */
const PW_BLOCK_END = /^\s+(attachment #\d+:|Error Context:)/;
/** The line after Playwright's failures: its summary, `  1 failed` and the like. */
const PW_SUMMARY = /^ {2}\d+ (failed|flaky|passed|skipped|interrupted|did not run)\b/;
/** A failing test's retry: the same failure again. */
const PW_RETRY = /^\s+Retry #\d+\b/;
/** A failure's block, and all of them, at most. */
const BLOCK_LINES = 60;
const BLOCKS_CHARS = 12_000;

/** A line as the excerpt shows it: no colour codes, no box-drawing rule at its end. */
function plain(line: string): string {
  return line
    .replaceAll(ANSI, '')
    .replace(/\s*─+\s*$/, '')
    .trimEnd();
}

/**
 * Each Playwright failure in a test run's output: from its `  1) <title>` heading through its
 * first `attachment #` or `Error Context:` line, so the error, its call log, the code frame with
 * its `>` line and the `at file:line` lines, without colour codes. A failing test's retry is the
 * same failure again and is left out, as is a heading seen before. `span` is the lines the
 * failures take, from the first heading up to the summary.
 */
export function playwrightFailures(text: string): {
  blocks: string[];
  span?: { from: number; to: number };
} {
  const lines = text.split('\n').map(plain);
  const blocks: string[] = [];
  const seen = new Set<string>();
  let chars = 0;
  let more = 0;
  let from: number | undefined;
  let to = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (from !== undefined && PW_SUMMARY.test(line)) {
      to = i;
      break;
    }
    const heading = PW_FAILURE.exec(line);
    if (!heading) continue;
    from ??= i;
    const block = [line];
    let j = i + 1;
    for (; j < lines.length && block.length < BLOCK_LINES; j++) {
      const next = lines[j] ?? '';
      if (PW_FAILURE.test(next) || PW_RETRY.test(next) || PW_SUMMARY.test(next)) break;
      block.push(next);
      if (PW_BLOCK_END.test(next)) break;
    }
    const title = (heading[2] ?? '').trim();
    if (seen.has(title)) continue;
    seen.add(title);
    while (block.length > 1 && !block.at(-1)?.trim()) block.pop();
    const shown = block.join('\n');
    if (blocks.length > 0 && chars + shown.length > BLOCKS_CHARS) {
      more++;
      continue;
    }
    chars += shown.length;
    blocks.push(shown);
  }
  if (more > 0) blocks.push(`… and ${more} more failures, in the whole output`);
  return from === undefined ? { blocks } : { blocks, span: { from, to } };
}

/**
 * A failed check's or proof's Playwright failures (each one's error, call log and code frame),
 * then its other lines that name an error (up to 40), then its last lines. The tail alone stopped
 * before ESLint's errors in PEN-70's gate, so neither the agent nor the log said what failed; the
 * whole output is kept in the run folder too (`gate.log`, A1250). In a Playwright run the tail is
 * retries and attachments, and its error lines alone lose the call log and the code frame:
 * PEN-121's agent guessed the wrong assertion (A1343). The error lines leave out the failures'
 * own span, which their blocks show.
 */
export function excerpt(text: string): string {
  const last = tail(text);
  const { blocks, span } = playwrightFailures(text);
  const shown = new Set(last.split('\n'));
  const errors = text
    .split('\n')
    .filter(
      (line, i) =>
        ERROR_LINE.test(line) && !shown.has(line) && !(span && i >= span.from && i < span.to),
    )
    .slice(0, 40);
  const before = [...blocks, ...(errors.length ? [errors.join('\n')] : [])];
  return before.length ? `${before.join('\n\n')}\n…\n${last}` : last;
}
