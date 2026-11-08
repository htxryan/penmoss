/**
 * Block-level editing of a note body for the agent edit engine (T24, A3):
 * find a section by its heading, splice top-level blocks, and keep every
 * block the edit did not change exactly as it was.
 *
 * Markdown does not carry everything a block holds (a wikilink's note id, a
 * table's column widths), so a block parsed from an agent's markdown is
 * swapped for an existing block whose markdown is the same (`reuseBlocks`,
 * generalised from T21's revert, A81). The caller turns the resulting
 * document into a Yjs delta and diffs it against the live body, so unchanged
 * blocks keep their Yjs items and a concurrent edit to them survives.
 *
 * Pure ProseMirror and markdown: no Yjs here, so it runs in workerd, Node
 * and the browser alike (A9).
 */
import type { Nodes } from 'mdast';
import { fromMarkdown } from 'mdast-util-from-markdown';
import type { Node as PMNode } from 'prosemirror-model';
import { headingsOf, type DocJson } from '../links';
import { exactHeadingKey, headingKey } from '../line-symbols';
import { schema } from '../schema';
import { fromMarkdownExtensions, micromarkExtensions } from './config';
import type { LinkResolver } from './context';
import { serializeMarkdown } from './serialize';

/** A heading and the top-level blocks under it, as indices into the body. */
export interface SectionRange {
  /** Index of the heading block. */
  readonly heading: number;
  readonly level: number;
  /** The heading's text, as `headingsOf` reads it (a wikilink shows its label). */
  readonly text: string;
  /** First block after the heading. */
  readonly start: number;
  /** One past the last block of the section (the next heading of its level or higher, or the end). */
  readonly end: number;
}

export type SectionLookup =
  | { readonly ok: true; readonly section: SectionRange }
  | {
      readonly ok: false;
      readonly reason: 'not-found' | 'ambiguous';
      /** The headings that matched (ambiguous), or every heading (not found), to help the caller pick. */
      readonly matches: readonly SectionRange[];
    };

/** `## Plans` → level 2 and `Plans`; a bare `Plans` matches any level. */
export function parseHeadingRef(ref: string): { level: number | null; text: string } {
  const match = /^(#{1,6})\s+(.*)$/.exec(ref.trim());
  if (match) return { level: match[1]!.length, text: match[2]!.trim() };
  return { level: null, text: ref.trim() };
}

/** Every heading of the body with the range of its section. */
export function sectionsOf(doc: PMNode): SectionRange[] {
  const blocks: PMNode[] = [];
  doc.forEach((block) => blocks.push(block));
  const out: SectionRange[] = [];
  blocks.forEach((block, index) => {
    if (block.type.name !== 'heading') return;
    const level = Number(block.attrs['level'] ?? 1);
    const text = headingsOf({ type: 'doc', content: [block.toJSON() as DocJson] })[0]?.text ?? '';
    let end = index + 1;
    while (end < blocks.length) {
      const next = blocks[end]!;
      if (next.type.name === 'heading' && Number(next.attrs['level'] ?? 1) <= level) break;
      end++;
    }
    out.push({ heading: index, level, text, start: index + 1, end });
  });
  return out;
}

/**
 * The section `ref` names (`Plans` or `## Plans`, case-insensitive, with or without the
 * heading's leading symbols: `## ★ Plans` is `Plans`). Two
 * headings with that text are ambiguous unless a level tells them apart.
 */
export function findSection(doc: PMNode, ref: string): SectionLookup {
  const { level, text } = parseHeadingRef(ref);
  const all = sectionsOf(doc);
  const atLevel = all.filter((section) => level === null || section.level === level);
  // The same text first, symbols and all; else the same without leading symbols (T44, A748),
  // so `## ? Open questions` is found as "Open questions".
  const exact = atLevel.filter(
    (section) => exactHeadingKey(section.text) === exactHeadingKey(text),
  );
  const matches = exact.length
    ? exact
    : atLevel.filter((section) => headingKey(section.text) === headingKey(text));
  if (matches.length === 1) return { ok: true, section: matches[0]! };
  return matches.length === 0
    ? { ok: false, reason: 'not-found', matches: all }
    : { ok: false, reason: 'ambiguous', matches };
}

/** One top-level block as markdown, on its own (links as `links` writes them; as written by default). */
export function blockMarkdown(block: PMNode, links?: LinkResolver): string {
  return serializeMarkdown(
    { frontmatter: null, doc: schema.node('doc', null, [block]) },
    links ? { links } : {},
  );
}

/** A section's markdown (its heading and blocks), for comparing two versions of it. */
export function sectionMarkdown(doc: PMNode, section: SectionRange): string {
  const parts: string[] = [];
  for (let i = section.heading; i < section.end; i++) parts.push(blockMarkdown(doc.child(i)));
  return parts.join('\n');
}

/**
 * `target` with each block whose markdown equals a block of `sources` replaced
 * by that block, so wikilink note ids, table column widths and anything else
 * markdown cannot say survive a round trip. Identical blocks map by position
 * (the second copy in `target` takes the second in `sources`); a copy beyond
 * the sources' takes the last of them. With `links`, both sides are written
 * with current link titles, so a block an agent read (and sent back) after a
 * linked note was renamed still matches.
 */
export function reuseBlocks(
  target: readonly PMNode[],
  sources: readonly PMNode[],
  links?: LinkResolver,
): PMNode[] {
  const byMarkdown = new Map<string, PMNode[]>();
  for (const block of sources) {
    const key = blockMarkdown(block, links);
    const same = byMarkdown.get(key);
    if (same) same.push(block);
    else byMarkdown.set(key, [block]);
  }
  const used = new Map<string, number>();
  return target.map((block) => {
    const key = blockMarkdown(block, links);
    const same = byMarkdown.get(key);
    if (!same) return block;
    const index = used.get(key) ?? 0;
    used.set(key, index + 1);
    return same[Math.min(index, same.length - 1)]!;
  });
}

/**
 * The body with top-level blocks `from`..`to` (exclusive) replaced by
 * `blocks`. A body left with no blocks gets one empty paragraph, as the
 * editor does.
 */
export function replaceBlocks(
  doc: PMNode,
  from: number,
  to: number,
  blocks: readonly PMNode[],
): PMNode {
  const children: PMNode[] = [];
  doc.forEach((block, _offset, index) => {
    if (index === from) children.push(...blocks);
    if (index < from || index >= to) children.push(block);
  });
  if (from >= doc.childCount) children.push(...blocks);
  return schema.node('doc', null, children.length > 0 ? children : [schema.node('paragraph')]);
}

/** Whether a body is nothing but one empty paragraph (a new note). */
export function isEmptyBody(doc: PMNode): boolean {
  return doc.childCount === 0 || (doc.childCount === 1 && doc.child(0).content.size === 0);
}

/** The top-level blocks of a document, in order. */
export function blocksOf(doc: PMNode): PMNode[] {
  const out: PMNode[] = [];
  doc.forEach((block) => out.push(block));
  return out;
}

export interface Occurrence {
  /** Offset in the text. */
  readonly index: number;
  /** The whole lines the occurrence spans, for telling whether its surroundings changed. */
  readonly lines: string;
}

/**
 * Every non-overlapping occurrence of `find` in `text`, left to right. With
 * `textOnly`, occurrences touching a link's address or title, a wikilink or
 * embed, an image, an autolink or a link definition are left out: what a
 * reader sees as prose is matched, never where a link points.
 */
export function markdownOccurrences(
  text: string,
  find: string,
  options: { readonly textOnly?: boolean } = {},
): Occurrence[] {
  if (!find) return [];
  const skip = options.textOnly ? linkRanges(text) : [];
  const out: Occurrence[] = [];
  let at = text.indexOf(find);
  while (at >= 0) {
    const end = at + find.length;
    if (!skip.some(([from, to]) => at < to && end > from)) {
      const start = text.lastIndexOf('\n', at - 1) + 1;
      const newline = text.indexOf('\n', end);
      out.push({ index: at, lines: text.slice(start, newline === -1 ? text.length : newline) });
    }
    at = text.indexOf(find, end);
  }
  return out;
}

/**
 * Where `markdown` says where links point (offsets, end exclusive): a link's
 * `](address "title")` or reference label, and the whole of a wikilink,
 * embed, image, autolink or link definition.
 */
export function linkRanges(markdown: string): Array<readonly [number, number]> {
  const tree = fromMarkdown(markdown, {
    extensions: micromarkExtensions,
    mdastExtensions: fromMarkdownExtensions,
  });
  const out: Array<readonly [number, number]> = [];
  const visit = (node: Nodes) => {
    const from = node.position?.start.offset;
    const to = node.position?.end.offset;
    if (from === undefined || to === undefined) return;
    switch (node.type) {
      case 'link':
      case 'linkReference': {
        const text = node.children.at(-1)?.position?.end.offset;
        // An autolink (`<https://…>`) is all address; otherwise the label is prose.
        const autolink = node.type === 'link' && markdown[from] === '<';
        out.push([autolink || text === undefined ? from : text, to]);
        break;
      }
      case 'image':
      case 'imageReference':
      case 'definition':
      case 'wikiLink':
      case 'wikiEmbed':
        out.push([from, to]);
        return;
    }
    if ('children' in node) for (const child of node.children) visit(child);
  };
  visit(tree);
  return out;
}
