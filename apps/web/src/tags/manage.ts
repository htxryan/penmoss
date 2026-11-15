/**
 * What the Tags page shows and works out before it changes anything (finding 8 of Ryan's review
 * of #192): one row per tag, the filter, and the counts and description moves a rename, merge or
 * delete makes. Pure, so the page and its tests share it.
 */
import { normaliseTag, tagMatches, tagTree, type TagNode } from '@penmoss/core/tags';
import type { TagChange } from '@penmoss/sync-client/tags';

/** One row of the table: a tag, or a level other tags are nested under. */
export interface TagRow {
  readonly tag: string;
  /** What comes before the last level, with its slash (`android/`); empty at the top level. */
  readonly parent: string;
  /** The last level (`dev-builds`). */
  readonly name: string;
  /** Notes with the tag or one nested under it. */
  readonly count: number;
  /** Notes with exactly this tag (0 for a level only other tags are under). */
  readonly own: number;
  /** The tags nested under it, at every depth. */
  readonly nested: readonly string[];
}

/** Every tag and level in `notes` (each note's tags), sorted by name. */
export function tagRows(notes: readonly (readonly string[])[]): TagRow[] {
  const own = new Map<string, number>();
  for (const tags of notes) for (const tag of new Set(tags)) own.set(tag, (own.get(tag) ?? 0) + 1);
  const rows: TagRow[] = [];
  const walk = (nodes: readonly TagNode[]): string[] => {
    const all: string[] = [];
    for (const node of nodes) {
      const at = rows.length;
      rows.push({
        tag: node.tag,
        parent: node.tag.slice(0, node.tag.length - node.name.length),
        name: node.name,
        count: node.count,
        own: own.get(node.tag) ?? 0,
        nested: [],
      });
      const nested = walk(node.children);
      rows[at] = { ...rows[at]!, nested };
      all.push(node.tag, ...nested);
    }
    return all;
  };
  walk(tagTree(notes));
  return rows.sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));
}

/** The filter's words as a tag name compares them: lower case, without a leading `#`. */
export function filterKey(query: string): string {
  return query.trim().replace(/^#+/, '').toLowerCase();
}

/** Whether a row matches the filter: in its name or its description. */
export function rowMatches(row: TagRow, description: string, key: string): boolean {
  if (!key) return true;
  return row.tag.includes(key) || description.toLowerCase().includes(key);
}

/** `n notes`, `1 note`. */
export const notesText = (n: number) => `${n} ${n === 1 ? 'note' : 'notes'}`;

/** `#a`, `#a and #b`, `#a, #b and #c`. */
export function tagList(tags: readonly string[]): string {
  const named = tags.map((tag) => `#${tag}`);
  if (named.length <= 1) return named.join('');
  return `${named.slice(0, -1).join(', ')} and ${named.at(-1)!}`;
}

const hasAny = (tags: readonly string[], wanted: readonly string[]) =>
  tags.some((tag) => wanted.some((each) => tagMatches(tag, each)));

/** The notes a delete of `tags` (and those nested under them) changes. */
export function deleteCount(
  notes: readonly (readonly string[])[],
  tags: readonly string[],
): number {
  return notes.filter((each) => hasAny(each, tags)).length;
}

/** What merging `sources` into `target` does to the notes: retagged, and those that had it. */
export interface MergeCounts {
  /** Notes with a source that did not have the target: they gain it. */
  readonly retagged: number;
  /** Notes with a source that had the target already. */
  readonly had: number;
  /** Notes with the target afterwards. */
  readonly after: number;
}

export function mergeCounts(
  notes: readonly (readonly string[])[],
  sources: readonly string[],
  target: string,
): MergeCounts {
  let retagged = 0;
  let had = 0;
  let after = 0;
  for (const tags of notes) {
    const source = hasAny(tags, sources);
    const has = hasAny(tags, [target]);
    if (source && has) had++;
    else if (source) retagged++;
    if (source || has) after++;
  }
  return { retagged, had, after };
}

/** Why `to` cannot be the new name of `from` (null: it can). */
export function renameProblem(from: string, raw: string): string | null {
  const to = normaliseTag(raw);
  if (!to || /\s/.test(raw.trim())) return 'Spaces and # are not allowed in a tag, as in a note.';
  if (to.startsWith(`${from}/`)) return `#${from} cannot move inside itself.`;
  return null;
}

/** Why `target` cannot be what `sources` merge into (null: it can). */
export function mergeProblem(sources: readonly string[], target: string): string | null {
  const inside = sources.find((source) => source !== target && target.startsWith(`${source}/`));
  return inside ? `#${target} is inside #${inside}, so it cannot take its notes.` : null;
}

/** The changes that merge `sources` into `target` (the target itself, if listed, stays). */
export function mergeChanges(sources: readonly string[], target: string): TagChange[] {
  return sources.filter((source) => source !== target).map((from) => ({ from, to: target }));
}

/**
 * What the descriptions become after `changes` (each tag the description was for, and the new
 * text, '' for none): a renamed tag's goes with it, unless the tag it becomes has one of its own,
 * which is kept (so a merge keeps the target's, or takes the first merged tag's that has one);
 * a deleted tag's goes. The tags nested under a changed tag go along as the change says.
 */
export function describedAfter(
  descriptions: Readonly<Record<string, string>>,
  changes: readonly TagChange[],
): Record<string, string> {
  const now = new Map(Object.entries(descriptions).filter(([, text]) => text.trim() !== ''));
  const touched = new Set<string>();
  for (const change of changes) {
    const nested = change.nested ?? true;
    const moved = [...now.keys()].filter(
      (tag) => tag === change.from || (nested && tag.startsWith(`${change.from}/`)),
    );
    for (const tag of moved) {
      const text = now.get(tag)!;
      now.delete(tag);
      touched.add(tag);
      if (change.to === null) continue;
      const renamed = change.to + tag.slice(change.from.length);
      if (!now.has(renamed)) {
        now.set(renamed, text);
        touched.add(renamed);
      }
    }
  }
  const out: Record<string, string> = {};
  for (const tag of touched) {
    const text = now.get(tag) ?? '';
    if (text !== (descriptions[tag] ?? '')) out[tag] = text;
  }
  return out;
}

/** The description a merge leaves on `target`, and which tag it came from (null: none). */
export function mergedDescription(
  descriptions: Readonly<Record<string, string>>,
  sources: readonly string[],
  target: string,
): string | null {
  if (descriptions[target]?.trim()) return target;
  return sources.find((source) => descriptions[source]?.trim()) ?? null;
}
