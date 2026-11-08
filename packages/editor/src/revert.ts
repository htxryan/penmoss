/**
 * Reverting one change of a note (T21, A3, A81): a three-way merge that undoes what a version
 * changed and keeps every later edit. Moved here from the server's `do/versions.ts` (T50 Mac lane,
 * A858) so git notebooks revert an agent's edit the same way, in the apps and the local MCP.
 */
import { merge3, splitLines, type MergeConflict } from '@penmoss/core/diff';
import { frontmatterTagKeys, setBody, setTagKeys } from '@penmoss/sync-client/history';
import { readTitle, setTitle } from '@penmoss/sync-client/note';
import type * as Y from '@y/y';
import { bodyMarkdown, mergedBodyDelta } from './markdown';

export interface RevertConflict extends MergeConflict {
  /** `body` (lines of markdown) or `title`. */
  readonly part: 'body' | 'title';
}

export interface RevertResult {
  readonly conflicts: RevertConflict[];
}

/**
 * Undoes the change from `before` to `after` in `live` (A3): a three-way
 * merge with `after` as the base, `live` as ours and `before` as theirs. The
 * body merges by markdown line; where a later edit overlaps the change, the
 * later text is kept and the region is reported. The title merges as one
 * value, the frontmatter tags one by one. Call inside a transaction.
 *
 * The merged body is applied block by block (`mergedBodyDelta`): a block one
 * of the three documents has as merged keeps its links and attributes; a
 * block the merge combined is parsed, its links resolved from them.
 */
export function revertChange(live: Y.Doc, before: Y.Doc, after: Y.Doc): RevertResult {
  const conflicts: RevertConflict[] = [];

  const ours = splitLines(bodyMarkdown(live));
  const body = merge3(splitLines(bodyMarkdown(after)), ours, splitLines(bodyMarkdown(before)));
  conflicts.push(...body.conflicts.map((conflict) => ({ ...conflict, part: 'body' as const })));
  if (body.lines.join('\n') !== ours.join('\n')) {
    const merged = body.lines.length > 0 ? `${body.lines.join('\n')}\n` : '';
    // Blocks any of the three documents has as merged are kept as they are (links, widths).
    setBody(live, mergedBodyDelta(merged, [live, before, after]));
  }

  const [was, became, now] = [readTitle(before), readTitle(after), readTitle(live)];
  if (was !== became) {
    if (now === became) setTitle(live, was);
    else if (now !== was) {
      conflicts.push({ part: 'title', at: 0, base: [became], ours: [now], theirs: [was] });
    }
  }

  const tagsBefore = frontmatterTagKeys(before);
  const tagsAfter = frontmatterTagKeys(after);
  const tags = new Set(frontmatterTagKeys(live));
  for (const key of new Set([...tagsBefore, ...tagsAfter])) {
    const changed = tagsBefore.has(key) !== tagsAfter.has(key);
    // Only a tag the change touched, and only while it is still as the change left it.
    if (changed && tags.has(key) === tagsAfter.has(key)) {
      if (tagsBefore.has(key)) tags.add(key);
      else tags.delete(key);
    }
  }
  setTagKeys(live, tags);
  return { conflicts };
}
