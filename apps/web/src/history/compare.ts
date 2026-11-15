/**
 * What View This Version lays side by side (A1572): a version of the note on the left and the note
 * as it is now on the right, each cut into the blocks a note shows (its title, a paragraph, a
 * heading, one item of a list), paired into rows. A row holds a block on each side when they are
 * the same or one replaced the other, and one side only where a block was removed or added, so
 * the other side keeps the gap open and the two stay level as they scroll together.
 */
import { diffLines } from '@penmoss/core/diff';
import type { DocJson } from '@penmoss/core/links';

/** One block of a side: the note's title, or one top-level block (a list's item on its own). */
export type CompareBlock =
  | { readonly kind: 'title'; readonly key: string; readonly text: string }
  | { readonly kind: 'block'; readonly key: string; readonly json: DocJson };

/**
 * A row of the comparison. `same`: the block is in both. `changed`: the version's block was
 * replaced by now's. `removed`: the version's block is not in the note now. `added`: now's block
 * was not in the version.
 */
export type CompareRow =
  | { readonly change: 'same'; readonly left: CompareBlock; readonly right: CompareBlock }
  | { readonly change: 'changed'; readonly left: CompareBlock; readonly right: CompareBlock }
  | { readonly change: 'removed'; readonly left: CompareBlock; readonly right: null }
  | { readonly change: 'added'; readonly left: null; readonly right: CompareBlock };

/** A note as the markdown codec reads it: its title (from the frontmatter) and its body. */
export interface ReadNote {
  readonly title: string;
  readonly body: DocJson;
}

/** The lists whose items are rows of their own, so one checked item tints alone. */
const LISTS = new Set(['bulletList', 'orderedList', 'taskList']);

/**
 * The blocks of a note, in order: its title, then each top-level block, a list's items one by one
 * (each as a list of one, an ordered one starting at its own number). Their keys compare them: the
 * same block on both sides has the same key. An item's number is left out of its key, so an item
 * added above does not mark every item after it.
 */
export function blocksOf(note: ReadNote): CompareBlock[] {
  const out: CompareBlock[] = [];
  if (note.title) out.push({ kind: 'title', key: `title:${note.title}`, text: note.title });
  for (const block of note.body.content ?? []) {
    const type = block.type;
    if (type && LISTS.has(type)) {
      const start = typeof block.attrs?.['start'] === 'number' ? block.attrs['start'] : 1;
      (block.content ?? []).forEach((item, i) => {
        const attrs = type === 'orderedList' ? { ...block.attrs, start: start + i } : block.attrs;
        out.push({
          kind: 'block',
          key: JSON.stringify({ list: type, item }),
          json: { type, ...(attrs ? { attrs } : {}), content: [item] },
        });
      });
      continue;
    }
    out.push({ kind: 'block', key: JSON.stringify(block), json: block });
  }
  return out;
}

/**
 * The rows of `version` beside `now`: a line diff of the blocks' keys, then, in each run of
 * changes, the version's blocks paired with now's in order (`changed`), the rest of the longer
 * side on rows of their own (`removed` or `added`).
 */
export function compareRows(
  version: readonly CompareBlock[],
  now: readonly CompareBlock[],
): CompareRow[] {
  const ops = diffLines(
    version.map((block) => block.key),
    now.map((block) => block.key),
  );
  const rows: CompareRow[] = [];
  let left = 0;
  let right = 0;
  let removed: CompareBlock[] = [];
  let added: CompareBlock[] = [];
  const close = () => {
    const paired = Math.min(removed.length, added.length);
    for (let i = 0; i < paired; i++) {
      rows.push({ change: 'changed', left: removed[i]!, right: added[i]! });
    }
    for (const block of removed.slice(paired))
      rows.push({ change: 'removed', left: block, right: null });
    for (const block of added.slice(paired))
      rows.push({ change: 'added', left: null, right: block });
    removed = [];
    added = [];
  };
  for (const op of ops) {
    if (op.op === 'same') {
      close();
      rows.push({ change: 'same', left: version[left++]!, right: now[right++]! });
    } else if (op.op === 'del') {
      removed.push(version[left++]!);
    } else {
      added.push(now[right++]!);
    }
  }
  close();
  return rows;
}

/** Whether the version differs from the note now: a row that is not the same. */
export const differs = (rows: readonly CompareRow[]) => rows.some((row) => row.change !== 'same');

/**
 * A version's markdown (`versionMarkdown`: the title and tags as frontmatter, then the body) read
 * by the markdown codec, which loads on first use (`@penmoss/core`).
 */
export async function readMarkdown(markdown: string): Promise<ReadNote> {
  const { parseMarkdown, readNoteMeta } = await import('@penmoss/core');
  const parsed = parseMarkdown(markdown);
  return {
    title: (parsed.frontmatter ? readNoteMeta(parsed.frontmatter).title : undefined) ?? '',
    body: parsed.doc.toJSON() as DocJson,
  };
}
