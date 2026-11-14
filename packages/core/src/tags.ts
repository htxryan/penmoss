/**
 * Tags (T18, FR-ORG-2): from frontmatter `tags:` and from inline `#tags` in
 * the body, nested with `/` (`#area/cooking`). One set of rules for the
 * client (tag pane, filters, offline) and the indexer (D1 `note_tags`).
 *
 * Inline rules follow Obsidian: `#` at the start of the text or after
 * whitespace or an opening bracket, then letters, digits, `_`, `-` and `/`,
 * with at least one character that is not a digit (`#2026` and `issue #12`
 * are not tags, nor is the `#` in `C#`). Tags compare case-insensitively and
 * are kept lower-case.
 */

/** A tag body: letters, marks, digits, `_`, `-`, `/` (Unicode-aware). */
const TAG_BODY = /^[\p{L}\p{M}\p{N}_\-/]+$/u;
const INLINE_TAG = /(^|[\s([{"'“‘])#([\p{L}\p{M}\p{N}_\-/]+)/gu;

/** The canonical form of a tag, or null when it is not a valid tag. */
export function normaliseTag(raw: string): string | null {
  const name = raw
    .trim()
    .replace(/^#+/, '')
    .replace(/\/{2,}/g, '/')
    .replace(/^\/+|\/+$/g, '')
    .toLowerCase();
  if (!name || !TAG_BODY.test(name)) return null;
  // Every level needs a non-digit (`#2026` is a number, `#log/2026` is fine).
  if (!/[^\p{N}]/u.test(name.split('/')[0]!)) return null;
  return name;
}

/** The inline tags in a run of text, in order of first appearance, without duplicates. */
export function inlineTags(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(INLINE_TAG)) {
    const tag = normaliseTag(match[2]!);
    if (tag) found.add(tag);
  }
  return [...found];
}

/**
 * Where the inline tags are in a run of text: `index` is the `#`, `length`
 * covers `#` and the name, `tag` is the canonical name (for highlighting).
 */
export function inlineTagRanges(
  text: string,
): Array<{ readonly index: number; readonly length: number; readonly tag: string }> {
  const out: Array<{ index: number; length: number; tag: string }> = [];
  for (const match of text.matchAll(INLINE_TAG)) {
    const tag = normaliseTag(match[2]!);
    if (tag) out.push({ index: match.index + match[1]!.length, length: match[2]!.length + 1, tag });
  }
  return out;
}

/** Valid, de-duplicated, sorted tags from any list (frontmatter values, user input). */
export function cleanTags(tags: Iterable<string>): string[] {
  const out = new Set<string>();
  for (const raw of tags) {
    const tag = normaliseTag(raw);
    if (tag) out.add(tag);
  }
  return [...out].sort();
}

/** `a/b/c` → `['a', 'a/b', 'a/b/c']`: a note tagged `a/b` is also under `a`. */
export function tagAncestors(tag: string): string[] {
  const parts = tag.split('/');
  return parts.map((_, index) => parts.slice(0, index + 1).join('/'));
}

/** Whether `tag` is `filter` or nested under it. */
export function tagMatches(tag: string, filter: string): boolean {
  return tag === filter || tag.startsWith(`${filter}/`);
}

/**
 * The tag after renaming `from` to `to` (descendants move along:
 * `a/b` → `x/b` when renaming `a` to `x`, unless `nested` is false), or null
 * when `tag` is not affected.
 */
export function renamedTag(tag: string, from: string, to: string, nested = true): string | null {
  if (tag === from) return to;
  if (nested && tag.startsWith(`${from}/`)) return to + tag.slice(from.length);
  return null;
}

/**
 * Rewrites the inline tags in a run of text for a rename (`#from` and, unless
 * `nested` is false, `#from/…`), keeping everything else. Returns the edits as
 * `{ index, length, text }` (offsets into `text`, in order), so a caller can
 * apply them to a CRDT without replacing the whole run.
 */
export function inlineTagEdits(
  text: string,
  from: string,
  to: string,
  nested = true,
): Array<{ readonly index: number; readonly length: number; readonly text: string }> {
  const edits: Array<{ index: number; length: number; text: string }> = [];
  for (const match of text.matchAll(INLINE_TAG)) {
    const raw = match[2]!;
    const tag = normaliseTag(raw);
    if (!tag) continue;
    const renamed = renamedTag(tag, from, to, nested);
    if (renamed === null || renamed === tag) continue;
    // `#` sits after the lead character (if any).
    const index = match.index + match[1]!.length + 1;
    edits.push({ index, length: raw.length, text: renamed });
  }
  return edits;
}

export interface TagNode {
  /** The full tag (`area/cooking`). */
  readonly tag: string;
  /** The last level (`cooking`). */
  readonly name: string;
  /** Notes with this tag or one nested under it. */
  readonly count: number;
  readonly children: TagNode[];
}

/**
 * The tag tree for the tag pane: one node per tag and per level above it,
 * each counting the notes tagged with it or anything nested under it, sorted
 * by name.
 */
export function tagTree(notes: Iterable<readonly string[]>): TagNode[] {
  const counts = new Map<string, number>();
  for (const tags of notes) {
    const levels = new Set(tags.flatMap(tagAncestors));
    for (const level of levels) counts.set(level, (counts.get(level) ?? 0) + 1);
  }
  const build = (parent: string | null): TagNode[] =>
    [...counts.keys()]
      .filter((tag) => {
        const slash = tag.lastIndexOf('/');
        // A top-level tag has no slash; slicing it to -1 would cut its last letter instead.
        if (parent === null) return slash === -1;
        return slash !== -1 && tag.slice(0, slash) === parent;
      })
      .sort()
      .map((tag) => ({
        tag,
        name: tag.slice(tag.lastIndexOf('/') + 1),
        count: counts.get(tag) ?? 0,
        children: build(tag),
      }));
  return build(null);
}

/** The longest tag description kept (PEN-68): a paragraph or two of meaning, never a note. */
export const TAG_DESCRIPTION_MAX = 2000;

/** A description as it is kept: within the limit; null when it has no text (no entry). */
export function cleanTagDescription(text: string): string | null {
  const kept = text.slice(0, TAG_DESCRIPTION_MAX);
  return kept.trim() === '' ? null : kept;
}

/** One tag as `describe_tags` gives it (PEN-68). */
export interface DescribedTag {
  readonly name: string;
  /** What Ryan wrote it means; null when he wrote nothing. */
  readonly description: string | null;
  /** Notes with this tag or one nested under it. */
  readonly notes: number;
  /** Its parents' descriptions, outermost first: only the parents that have one. */
  readonly ancestors: ReadonlyArray<{ readonly name: string; readonly description: string }>;
}

/**
 * Tags with their descriptions (PEN-68): every tag and every level above one (as `tagTree`),
 * or only `wanted` and the tags nested under each. A wanted tag no note has is still given, with
 * no notes. Sorted by name.
 */
export function describeTags(
  notes: Iterable<readonly string[]>,
  descriptions: Readonly<Record<string, string>>,
  wanted?: readonly string[],
): DescribedTag[] {
  const counts = new Map<string, number>();
  const walk = (nodes: readonly TagNode[]) => {
    for (const node of nodes) {
      counts.set(node.tag, node.count);
      walk(node.children);
    }
  };
  walk(tagTree(notes));
  const described = (tag: string): string | null => {
    const text = Object.hasOwn(descriptions, tag) ? descriptions[tag]! : '';
    return text.trim() === '' ? null : text.trim();
  };
  const names = new Set<string>();
  if (wanted === undefined) for (const tag of counts.keys()) names.add(tag);
  else {
    for (const want of wanted) {
      names.add(want);
      for (const tag of counts.keys()) if (tagMatches(tag, want)) names.add(tag);
    }
  }
  return [...names].sort().map((name) => ({
    name,
    description: described(name),
    notes: counts.get(name) ?? 0,
    ancestors: tagAncestors(name)
      .slice(0, -1)
      .flatMap((parent) => {
        const text = described(parent);
        return text === null ? [] : [{ name: parent, description: text }];
      }),
  }));
}
