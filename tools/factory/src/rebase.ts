/**
 * Keeping a factory branch on top of main (F6, PEN-40). Two factory PRs that each add a
 * decision append rows at the same place in docs/decisions.md, so the second conflicts once the
 * first merges. That conflict, and only that one, the harness resolves itself: main's rows,
 * then the branch's. A branch whose own Prettier run re-padded the table (an `A-NEW-1` is wider
 * than the ID column) conflicts on every row; that is merged with the padding taken out, then
 * formatted again (A1250). A row whose number main has meanwhile given to another decision is
 * renumbered after the rebase. Any other conflict aborts the rebase and goes to the agent.
 *
 * Runs in a gate sandbox's worktree (git through the sandbox, the files read on the host as
 * `numberDecisions` does); the push stays the host's (R18).
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatDecisions, renumberLines, takenDecisions } from './decisions.ts';
import type { RunSandbox } from './run.ts';

export const DECISIONS = 'docs/decisions.md';

export type RebaseOutcome =
  | {
      readonly kind: 'rebased';
      /** Files whose conflicts the harness resolved (only docs/decisions.md). */
      readonly resolved: readonly string[];
      /** Decision numbers main had taken, and the branch's rows' new ones. */
      readonly renumbered: Readonly<Record<string, string>>;
    }
  | {
      readonly kind: 'conflict';
      /** The files git left unmerged when the rebase stopped (it is aborted). */
      readonly files: readonly string[];
      readonly output: string;
    };

// diff3 shows the merge base, so an insertion on both sides is told from an edit. No rerere:
// a resolution recorded once must never be replayed silently.
const GIT = 'GIT_EDITOR=true git -c merge.conflictStyle=diff3 -c rerere.enabled=false';

/** How many of the branch's commits may stop on a decisions conflict in one rebase. */
const MAX_STOPS = 50;

const isRow = (line: string) => /^\|.*\|\s*$/.test(line);

/**
 * A docs/decisions.md left with diff3 conflict markers, resolved when every conflict is both
 * sides adding table rows at the same place (an empty merge base): HEAD's rows (main, during a
 * rebase) first, then the incoming commit's (the branch). Anything else is null.
 */
export function resolveAppendConflicts(text: string): string | null {
  const lines = text.split('\n');
  const out: string[] = [];
  let hunks = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!/^<{7}( |$)/.test(line)) {
      out.push(line);
      continue;
    }
    const ours: string[] = [];
    const base: string[] = [];
    const theirs: string[] = [];
    let part: 'ours' | 'base' | 'theirs' = 'ours';
    let sawBase = false;
    for (i++; ; i++) {
      const l = lines[i];
      if (l === undefined) return null;
      if (/^>{7}( |$)/.test(l)) break;
      if (/^\|{7}( |$)/.test(l)) {
        if (part !== 'ours') return null;
        part = 'base';
        sawBase = true;
      } else if (l === '=======') {
        if (part === 'theirs') return null;
        part = 'theirs';
      } else (part === 'ours' ? ours : part === 'base' ? base : theirs).push(l);
    }
    if (!sawBase || base.length > 0 || ours.length === 0 || theirs.length === 0) return null;
    if (![...ours, ...theirs].every(isRow)) return null;
    out.push(...ours, ...theirs);
    hunks++;
  }
  return hunks > 0 ? out.join('\n') : null;
}

/** A table row with each cell's padding taken out, so rows Prettier padded differently compare equal. */
export function unpadRow(line: string): string {
  if (!isRow(line)) return line;
  const cells = line
    .trim()
    .slice(1, -1)
    .split(/(?<!\\)\|/)
    .map((c) => c.trim())
    .map((c) => (/^:?-+:?$/.test(c) ? c.replace(/-+/, '---') : c));
  return `| ${cells.join(' | ')} |`;
}

export const unpad = (text: string): string => text.split('\n').map(unpadRow).join('\n');

/**
 * The stopped commit's docs/decisions.md merged with padding ignored: the merge base, main's side
 * and the branch's side, each unpadded, merged by `git merge-file`; both sides adding rows at
 * one place resolves as above; then Prettier pads the table again. Null when a real conflict
 * remains, or a side is missing.
 */
async function mergeUnpadded(sandbox: RunSandbox): Promise<string | null> {
  const dir = join(sandbox.worktreePath, '.factory', 'merge');
  mkdirSync(dir, { recursive: true });
  const files = ['base', 'ours', 'theirs'];
  for (const [i, name] of files.entries()) {
    const stage = await sandbox.exec(`git show :${i + 1}:${DECISIONS}`);
    if (stage.exitCode !== 0) return null;
    writeFileSync(join(dir, name), unpad(stage.stdout));
  }
  const merged = await sandbox.exec(
    'git merge-file -p --diff3 .factory/merge/ours .factory/merge/base .factory/merge/theirs',
  );
  rmSync(dir, { recursive: true, force: true });
  // The exit code is the number of conflicts (at most 127); above that, merge-file failed.
  if (merged.exitCode > 127) return null;
  const text = merged.exitCode === 0 ? merged.stdout : resolveAppendConflicts(merged.stdout);
  return text === null ? null : formatDecisions(text);
}

/**
 * `git rebase origin/main` in the sandbox's worktree, resolving decisions-only conflicts as
 * above, then renumbering any row main has taken (one more commit). `reservedFile` is the
 * factory's record of the highest number it has given out (decisions.ts).
 */
export async function rebaseOntoMain(
  sandbox: RunSandbox,
  reservedFile: string,
): Promise<RebaseOutcome> {
  const resolved = new Set<string>();
  let step = await sandbox.exec(`${GIT} rebase origin/main`);
  let output = step.stdout + step.stderr;
  for (let stops = 0; step.exitCode !== 0; stops++) {
    const unmerged = (await sandbox.exec('git diff --name-only --diff-filter=U')).stdout
      .split('\n')
      .filter(Boolean);
    const path = join(sandbox.worktreePath, DECISIONS);
    const decisionsOnly =
      stops < MAX_STOPS && unmerged.length > 0 && unmerged.every((f) => f === DECISIONS);
    const text = decisionsOnly
      ? (resolveAppendConflicts(readFileSync(path, 'utf8')) ?? (await mergeUnpadded(sandbox)))
      : null;
    if (text === null) {
      await sandbox.exec('git rebase --abort');
      return { kind: 'conflict', files: unmerged, output };
    }
    writeFileSync(path, text);
    resolved.add(DECISIONS);
    await sandbox.exec(`git add -- ${DECISIONS}`);
    step = await sandbox.exec(`${GIT} rebase --continue`);
    output = step.stdout + step.stderr;
  }
  return {
    kind: 'rebased',
    resolved: [...resolved],
    renumbered: await renumber(sandbox, reservedFile),
  };
}

/** Each changed file's added lines (1-based, in the new file) from `git diff -U0`. */
export function addedLines(diff: string): Map<string, Set<number>> {
  const files = new Map<string, Set<number>>();
  let current: Set<number> | undefined;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      const path = line.slice(4);
      current = path.startsWith('b/') ? new Set() : undefined;
      if (current) files.set(path.slice(2), current);
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk && current) {
      const start = Number(hunk[1]);
      const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
      for (let n = start; n < start + count; n++) current.add(n);
    }
  }
  return files;
}

async function renumber(
  sandbox: RunSandbox,
  reservedFile: string,
): Promise<Record<string, string>> {
  const path = join(sandbox.worktreePath, DECISIONS);
  const main = await sandbox.exec(`git show origin/main:${DECISIONS}`);
  if (main.exitCode !== 0 || !existsSync(path)) return {};
  const diff = await sandbox.exec(
    'git diff -U0 --no-color --no-ext-diff --no-renames origin/main HEAD',
  );
  const added = addedLines(diff.stdout);
  const renumbered = takenDecisions(
    readFileSync(path, 'utf8'),
    added.get(DECISIONS) ?? new Set(),
    main.stdout,
    reservedFile,
  );
  if (Object.keys(renumbered).length === 0) return {};
  // The new number goes wherever the branch wrote the old one: its row and its references.
  for (const [file, lines] of added) {
    const at = join(sandbox.worktreePath, file);
    if (!existsSync(at)) continue;
    const before = readFileSync(at, 'utf8');
    const after = renumberLines(before, lines, renumbered);
    if (after !== before) writeFileSync(at, after);
  }
  const message = `Renumber the decisions main already has: ${Object.entries(renumbered)
    .map(([from, to]) => `${from} is now ${to}`)
    .join(', ')}`;
  const committed = await sandbox.exec(`git commit -q -am '${message}'`);
  if (committed.exitCode !== 0)
    throw new Error(`couldn't commit the renumbered decisions: ${committed.stderr.trim()}`);
  return renumbered;
}
