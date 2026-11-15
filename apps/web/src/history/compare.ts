/**
 * What View This Version lays side by side (A1572): a version of the note on the left and the note
 * as it is now on the right, each cut into the blocks a note shows (its title, a paragraph, a
 * heading, one item of a list), paired into rows. A row holds a block on each side when they are
 * the same or one replaced the other, and one side only where a block was removed or added, so
 * the other side keeps the gap open and the two stay level as they scroll together.
 */
import type { BlockLines, LineSpan } from '@penmoss/core';
import { diffLines } from '@penmoss/core/diff';
import type { DocJson } from '@penmoss/core/links';

/**
 * One block of a side: the note's title, or one top-level block (a list's item on its own), with
 * where it is in the markdown (`lines`, the gutter's number), when that is known.
 */
export type CompareBlock =
  | {
      readonly kind: 'title';
      readonly key: string;
      readonly text: string;
      readonly lines?: LineSpan;
    }
  | {
      readonly kind: 'block';
      readonly key: string;
      readonly json: DocJson;
      readonly lines?: LineSpan;
    };

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

/**
 * A note as the markdown codec reads it: its title (from the frontmatter) and its body, and where
 * they are in the markdown: the title's line, and each of the body's top-level blocks'.
 */
export interface ReadNote {
  readonly title: string;
  readonly body: DocJson;
  readonly titleLine?: number | null;
  readonly lines?: ReadonlyArray<BlockLines | null>;
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
  const at = (span: LineSpan | null | undefined) => (span ? { lines: span } : {});
  if (note.title) {
    const line = note.titleLine;
    out.push({
      kind: 'title',
      key: `title:${note.title}`,
      text: note.title,
      ...at(line ? { start: line, end: line } : null),
    });
  }
  (note.body.content ?? []).forEach((block, index) => {
    const type = block.type;
    const lines = note.lines?.[index];
    if (type && LISTS.has(type)) {
      const start = typeof block.attrs?.['start'] === 'number' ? block.attrs['start'] : 1;
      (block.content ?? []).forEach((item, i) => {
        const attrs = type === 'orderedList' ? { ...block.attrs, start: start + i } : block.attrs;
        out.push({
          kind: 'block',
          key: JSON.stringify({ list: type, item }),
          json: { type, ...(attrs ? { attrs } : {}), content: [item] },
          ...at(lines?.items?.[i]),
        });
      });
      return;
    }
    out.push({ kind: 'block', key: JSON.stringify(block), json: block, ...at(lines) });
  });
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

/** How many rows of the same blocks Diff keeps around each change, as a code review does. */
export const DIFF_CONTEXT = 3;

/**
 * What Diff shows, in order: a row (by its index in the rows), or a fold of the unchanged rows
 * `from` to `to` (inclusive) between them, which says how many lines of the markdown it holds.
 */
export type DiffItem =
  | { readonly kind: 'row'; readonly index: number }
  | { readonly kind: 'fold'; readonly from: number; readonly to: number; readonly lines: number };

/**
 * How many lines of the markdown the same rows `from` to `to` hold: from the first's first line to
 * the last's last, the blank lines between them too, as the version has them. A block whose lines
 * are not known counts one.
 */
export function unchangedLines(rows: readonly CompareRow[], from: number, to: number): number {
  const first = rows[from]?.left?.lines;
  const last = rows[to]?.left?.lines;
  if (first && last && last.end >= first.start) return last.end - first.start + 1;
  return to - from + 1;
}

/**
 * Diff's view of the rows: each change with `context` rows of the same blocks before and after
 * it, the context of changes close together merged into one hunk, and a fold for each run of
 * rows left out (before the first hunk, between two, after the last). A fold whose first row is
 * in `open` is shown as its rows. With no change at all there is nothing to show: an empty list.
 */
export function diffItems(
  rows: readonly CompareRow[],
  open: ReadonlySet<number> = new Set(),
  context = DIFF_CONTEXT,
): DiffItem[] {
  const shown = rows.map(() => false);
  rows.forEach((row, index) => {
    if (row.change === 'same') return;
    const from = Math.max(0, index - context);
    const to = Math.min(rows.length - 1, index + context);
    for (let i = from; i <= to; i++) shown[i] = true;
  });
  if (!shown.some(Boolean)) return [];
  const items: DiffItem[] = [];
  let index = 0;
  while (index < rows.length) {
    if (shown[index]) {
      items.push({ kind: 'row', index });
      index++;
      continue;
    }
    const from = index;
    while (index < rows.length && !shown[index]) index++;
    const to = index - 1;
    if (open.has(from)) {
      for (let i = from; i <= to; i++) items.push({ kind: 'row', index: i });
    } else {
      items.push({ kind: 'fold', from, to, lines: unchangedLines(rows, from, to) });
    }
  }
  return items;
}

/** Full File's view: every row. */
export const fullItems = (rows: readonly CompareRow[]): DiffItem[] =>
  rows.map((_, index) => ({ kind: 'row', index }));

/**
 * A version's markdown (`versionMarkdown`: the title and tags as frontmatter, then the body) read
 * by the markdown codec, which loads on first use (`@penmoss/core`).
 */
export async function readMarkdown(markdown: string): Promise<ReadNote> {
  const { parseMarkdownWithLines, readNoteMeta } = await import('@penmoss/core');
  const parsed = parseMarkdownWithLines(markdown);
  return {
    title: (parsed.frontmatter ? readNoteMeta(parsed.frontmatter).title : undefined) ?? '',
    body: parsed.doc.toJSON() as DocJson,
    titleLine: parsed.titleLine,
    lines: parsed.lines,
  };
}
