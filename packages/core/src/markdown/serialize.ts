import type {
  BlockContent,
  List,
  ListItem,
  Parent,
  PhrasingContent,
  Root,
  RootContent,
  TableCell,
  TableRow,
} from 'mdast';
import { toMarkdown } from 'mdast-util-to-markdown';
import type { Mark, Node as PMNode } from 'prosemirror-model';
import { serializeFrontmatter, type Frontmatter } from '../frontmatter';
import { interruptsParagraph } from './callout-syntax';
import { toTableCell } from './table-pipes';
import { toMarkdownOptions } from './config';
import { ESCAPE_OPEN_AUTOLINK } from './text-escaping';
import { unresolvedLinks, type CodecContext, type LinkResolver } from './context';
import type { Callout } from './mdast-types';

export interface NoteContent {
  frontmatter: Frontmatter | null;
  doc: PMNode;
}

type AlignType = 'left' | 'center' | 'right' | null;

/** Marks that markdown writes as delimiter runs; whitespace at their edges is moved outside. */
const ATTENTION_MARKS = new Set(['bold', 'italic', 'strike', 'highlight']);

/**
 * Serialises a note to normalised markdown (docs/markdown-normalisation.md).
 * The output ends with exactly one newline, or is empty for an empty note.
 */
export function serializeMarkdown(note: NoteContent, context: CodecContext = {}): string {
  const converter = new DocToMdast(context.links ?? unresolvedLinks, context.assetUrl ?? same);
  const root: Root = { type: 'root', children: converter.blocks(note.doc) };
  let body = root.children.length > 0 ? toMarkdown(root, toMarkdownOptions) : '';
  body = body.replace(/\n*$/, body ? '\n' : '');
  if (!note.frontmatter && body.startsWith('---')) {
    // Without frontmatter, a leading `---` rule would be read as a frontmatter fence.
    body = `***${body.slice(3)}`;
  }
  if (!note.frontmatter) return body;
  const yaml = `---\n${serializeFrontmatter(note.frontmatter)}---\n`;
  return body ? `${yaml}\n${body}` : yaml;
}

const same = (url: string) => url;

class DocToMdast {
  constructor(
    private readonly links: LinkResolver,
    private readonly url: (url: string) => string,
  ) {}

  blocks(parent: PMNode): BlockContent[] {
    const out: BlockContent[] = [];
    parent.forEach((child) => out.push(...this.block(child)));
    return out;
  }

  private block(node: PMNode): BlockContent[] {
    switch (node.type.name) {
      case 'paragraph': {
        // A paragraph of nothing but spaces is empty once trimmed: an empty mdast paragraph
        // would write a task item's `[ ]` on a line of its own (A157's property test).
        const children = node.childCount === 0 ? [] : guardDefinitionLabel(this.inlines(node));
        return children.length === 0 ? [] : [{ type: 'paragraph', children }];
      }
      case 'heading':
        return [
          {
            type: 'heading',
            depth: node.attrs['level'] as 1 | 2 | 3 | 4 | 5 | 6,
            children: this.inlines(node, 'heading'),
          },
        ];
      case 'blockquote':
        return [{ type: 'blockquote', children: this.blocks(node) }];
      case 'callout': {
        const callout: Callout = {
          type: 'callout',
          calloutType: node.attrs['type'] as string,
          title: node.attrs['title'] as string,
          foldable: node.attrs['foldable'] as boolean,
          collapsed: node.attrs['collapsed'] as boolean,
          children: this.blocks(node),
        };
        return [callout];
      }
      case 'bulletList':
      case 'taskList':
      case 'orderedList':
        return [this.list(node)];
      case 'codeBlock':
        return [
          {
            type: 'code',
            lang: (node.attrs['language'] as string | null) || null,
            meta: (node.attrs['meta'] as string | null) || null,
            value: node.textContent,
          },
        ];
      case 'blockMath':
        return [{ type: 'math', value: node.attrs['latex'] as string }];
      case 'horizontalRule':
        return [{ type: 'thematicBreak' }];
      case 'table':
        return [this.table(node)];
      case 'embed':
        return [
          { type: 'paragraph', children: [{ type: 'wikiEmbed', ...this.reference(node, true) }] },
        ];
      case 'rawMarkdown':
        return node.textContent ? [{ type: 'html', value: node.textContent }] : [];
      default:
        throw new Error(`No markdown form for block node ${node.type.name}`);
    }
  }

  private list(node: PMNode): List {
    const items: ListItem[] = [];
    node.forEach((item) => {
      items.push({
        type: 'listItem',
        spread: false,
        checked: item.type.name === 'taskItem' ? (item.attrs['checked'] as boolean) : null,
        children: this.blocks(item),
      });
    });
    // Tight output is only safe when no item needs a blank line to keep its blocks apart.
    const tight = (node.attrs['tight'] as boolean) && items.every(isTightSafe);
    for (const item of items) item.spread = !tight;
    const ordered = node.type.name === 'orderedList';
    return {
      type: 'list',
      ordered,
      start: ordered ? (node.attrs['start'] as number) : null,
      spread: !tight,
      children: items,
    };
  }

  private table(node: PMNode): RootContent & { type: 'table' } {
    const rows: TableRow[] = [];
    const align: AlignType[] = [];
    node.forEach((row, _offset, rowIndex) => {
      const cells: TableCell[] = [];
      row.forEach((cell) => {
        if (rowIndex === 0) align.push(cell.attrs['align'] as AlignType);
        cells.push({ type: 'tableCell', children: this.inlines(cell, 'cell') });
      });
      rows.push({ type: 'tableRow', children: cells });
    });
    return { type: 'table', align, children: rows };
  }

  private reference(
    node: PMNode,
    embed = false,
  ): {
    target: string;
    heading: string | null;
    alias: string | null;
  } {
    const noteId = node.attrs['noteId'] as string | null;
    const current = noteId ? this.links.linkText(noteId) : null;
    const alias = node.attrs['alias'] as string | null;
    // An ambiguous title is written as the note's path, with the title as the alias (A10).
    // Not on an embed, where the text after `|` is no label (T27).
    const title =
      noteId && current !== null && !embed ? (this.links.title?.(noteId) ?? null) : null;
    return {
      target: current ?? (node.attrs['target'] as string),
      heading: node.attrs['heading'] as string | null,
      alias: alias ?? (title && title !== current ? title : null),
    };
  }

  /**
   * Rebuilds nested mdast phrasing from ProseMirror's flat marks. Marks still
   * active are kept open across nodes, so `**a *b***` stays one strong span.
   */
  private inlines(parent: PMNode, where: 'heading' | 'cell' | null = null): PhrasingContent[] {
    const root: PhrasingContent[] = [];
    const stack: { mark: Mark; node: Parent & { children: PhrasingContent[] } }[] = [];
    const current = () => stack[stack.length - 1]?.node.children ?? root;

    for (const { node, marks } of splitEdgeWhitespace(parent)) {
      const wrapping = marks.filter((mark) => mark.type.name !== 'code');
      let keep = 0;
      while (keep < stack.length && wrapping.some((mark) => mark.eq(stack[keep]!.mark))) keep++;
      stack.length = keep;
      for (const mark of wrapping) {
        if (stack.some((open) => open.mark.eq(mark))) continue;
        const wrapper = markNode(mark, this.url);
        current().push(wrapper);
        stack.push({ mark, node: wrapper });
      }
      const siblings = current();
      for (const leaf of this.leaf(node, marks, where)) {
        const previous = siblings[siblings.length - 1];
        if (leaf.type === 'inlineMath' && previous?.type === 'inlineMath') {
          // `$a$$b$` would read as one span: adjacent formulas merge (spaces are insignificant in TeX).
          previous.value = `${previous.value} ${leaf.value}`;
        } else if (
          (leaf.type === 'text' && previous?.type === 'text') ||
          (leaf.type === 'inlineCode' && previous?.type === 'inlineCode')
        ) {
          // One node per run, so escaping sees the whole run (and `` `a``b` `` stays one span).
          previous.value += leaf.value;
        } else {
          siblings.push(leaf);
        }
      }
    }
    return flagOpenAutolinks(root);
  }

  private leaf(
    node: PMNode,
    marks: readonly Mark[],
    where: 'heading' | 'cell' | null,
  ): PhrasingContent[] {
    switch (node.type.name) {
      case 'text': {
        let value = node.text ?? '';
        // Headings and table cells are single lines: soft line breaks become spaces.
        if (where !== null) value = value.replace(/\n/g, ' ');
        // Inline code cannot span lines (markdown reads a line ending in it as a space).
        if (isCode(marks)) return [{ type: 'inlineCode', value: value.replace(/\n/g, ' ') }];
        return [{ type: 'text', value }];
      }
      case 'hardBreak':
        if (where === 'cell') return [{ type: 'html', value: '<br>' }];
        return [{ type: 'break' }];
      case 'image': {
        const width = node.attrs['width'] as number | null;
        const height = node.attrs['height'] as number | null;
        let alt = node.attrs['alt'] as string;
        if (width !== null) alt += `|${width}${height !== null ? `x${height}` : ''}`;
        return [
          {
            type: 'image',
            url: this.url(node.attrs['src'] as string),
            alt,
            title: node.attrs['title'] as string | null,
          },
        ];
      }
      case 'inlineMath': {
        const latex = node.attrs['latex'] as string;
        if (!latex) return [];
        return [{ type: 'inlineMath', value: where === 'cell' ? toTableCell(latex) : latex }];
      }
      case 'wikilink':
        return [{ type: 'wikiLink', ...this.reference(node) }];
      case 'attachment':
        return [
          {
            type: 'link',
            url: this.url(node.attrs['href'] as string),
            children: [{ type: 'text', value: node.attrs['name'] as string }],
          },
        ];
      case 'rawInline':
        return [{ type: 'html', value: node.attrs['markdown'] as string }];
      default:
        throw new Error(`No markdown form for inline node ${node.type.name}`);
    }
  }
}

function markNode(
  mark: Mark,
  url: (url: string) => string,
): Parent & { children: PhrasingContent[] } & PhrasingContent {
  switch (mark.type.name) {
    case 'link':
      return {
        type: 'link',
        url: url(mark.attrs['href'] as string),
        title: mark.attrs['title'] as string | null,
        children: [],
      };
    case 'bold':
      return { type: 'strong', children: [] };
    case 'italic':
      return { type: 'emphasis', children: [] };
    case 'strike':
      return { type: 'delete', children: [] };
    case 'highlight':
      return { type: 'highlight', children: [] };
    default:
      throw new Error(`No markdown form for mark ${mark.type.name}`);
  }
}

interface Piece {
  node: PMNode;
  marks: readonly Mark[];
}

const isCode = (marks: readonly Mark[]) => marks.some((mark) => mark.type.name === 'code');

/**
 * Inline children prepared for markdown: whitespace at the edge of a
 * bold/italic/strike/highlight span moves outside it (`** a**` cannot open),
 * and whitespace at the edges of the text block is trimmed.
 */
function splitEdgeWhitespace(parent: PMNode): Piece[] {
  const children: PMNode[] = [];
  parent.forEach((child) => children.push(child));
  // Markdown cannot start or end a paragraph, heading or cell with a hard break.
  while (children[0]?.type.name === 'hardBreak') children.shift();
  while (children[children.length - 1]?.type.name === 'hardBreak') children.pop();

  // Split text into leading whitespace, content and trailing whitespace.
  const pieces: (Piece & { space: boolean })[] = [];
  for (const node of children) {
    const text = node.text ?? '';
    if (!node.isText || isCode(node.marks) || !text) {
      pieces.push({ node, marks: node.marks, space: false });
      continue;
    }
    const [, lead = '', middle = '', trail = ''] = /^(\s*)([\s\S]*?)(\s*)$/.exec(text) ?? [];
    for (const [part, space] of [
      [lead, true],
      [middle, false],
      [trail, true],
    ] as const) {
      if (part)
        pieces.push({ node: node.type.schema.text(part, node.marks), marks: node.marks, space });
    }
  }

  // Each run of whitespace keeps only the spans that continue on both sides of it.
  for (let start = 0; start < pieces.length; start++) {
    if (!pieces[start]?.space) continue;
    let end = start;
    while (pieces[end + 1]?.space) end++;
    const before = pieces[start - 1]?.marks ?? [];
    const after = pieces[end + 1]?.marks ?? [];
    const run = pieces.slice(start, end + 1);
    const keep = (mark: Mark) =>
      !ATTENTION_MARKS.has(mark.type.name) ||
      (mark.isInSet(before) && mark.isInSet(after) && run.every((p) => mark.isInSet(p.marks)));
    for (let index = start; index <= end; index++) {
      const piece = pieces[index]!;
      const marks = piece.marks.filter(keep);
      pieces[index] = { node: piece.node.mark(marks), marks, space: true };
    }
    start = end;
  }
  return trimBlockEdges(pieces);
}

/**
 * Markdown drops spaces and tabs at the start and end of a paragraph, heading
 * or table cell, so they are trimmed here (inline code keeps its own padding).
 */
function trimBlockEdges(pieces: Piece[]): Piece[] {
  const trim = (index: number, pattern: RegExp): boolean => {
    const piece = pieces[index];
    if (!piece?.node.isText || isCode(piece.marks)) return false;
    const text = (piece.node.text ?? '').replace(pattern, '');
    if (text)
      pieces[index] = { node: piece.node.type.schema.text(text, piece.marks), marks: piece.marks };
    else pieces.splice(index, 1);
    return !text;
  };
  while (trim(0, /^[ \t]+/));
  while (trim(pieces.length - 1, /[ \t]+$/));
  return pieces;
}

const EMAIL_LOCAL_RUN = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]*$/;
const EMAIL_AUTOLINK =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*>/;
const MARKERS: Partial<Record<string, string>> = {
  emphasis: '*',
  strong: '**',
  delete: '~~',
  highlight: '==',
};

/**
 * A `<` at the end of a text run can open an email autolink that runs on
 * through the next spans: `<` + `` `@a>` `` or `<x` + `*y*@a.b>`, because
 * backticks, `*`, `=`, `~` and `$` are valid in its local part. The text
 * handler only sees one character ahead, so each inline container is
 * flattened to (roughly) its markdown here, and a text node whose trailing
 * `<` really would open `<local@domain>` is flagged for escaping. Ordinary
 * prose such as ``List<`T` `` or `a<b*x*` is left alone.
 */
function flagOpenAutolinks(children: PhrasingContent[]): PhrasingContent[] {
  const segments: { text?: PhrasingContent & { type: 'text' }; value: string }[] = [];
  const flatten = (nodes: PhrasingContent[]) => {
    for (const node of nodes) {
      const marker = MARKERS[node.type];
      if (node.type === 'text') segments.push({ text: node, value: node.value });
      else if (node.type === 'inlineCode') segments.push({ value: `\`${node.value}\`` });
      else if (node.type === 'inlineMath') segments.push({ value: `$${node.value}$` });
      else if (node.type === 'html') segments.push({ value: node.value });
      else if (marker && 'children' in node) {
        segments.push({ value: marker });
        flatten(node.children);
        segments.push({ value: marker });
      } else if (node.type === 'link') {
        // Link text is checked between its brackets, which no autolink can cross.
        segments.push({ value: '[' });
        flatten(node.children);
        segments.push({ value: ']' });
      } else {
        // Images, wikilinks and breaks start with `!` + `[`, `[` or a line ending.
        segments.push({ value: '\n' });
      }
    }
  };
  flatten(children);
  segments.forEach((segment, index) => {
    if (!segment.text) return;
    const open = segment.value.lastIndexOf('<');
    if (open === -1) return;
    let rest = segment.value.slice(open + 1);
    if (!EMAIL_LOCAL_RUN.test(rest)) return;
    for (let next = index + 1; next < segments.length && rest.length < 600; next++) {
      rest += segments[next]!.value;
    }
    if (EMAIL_AUTOLINK.test(rest)) {
      segment.text.data = { ...segment.text.data, [ESCAPE_OPEN_AUTOLINK]: true };
    }
  });
  return children;
}

/** Inline nodes whose value is written verbatim, so a `]` in them cannot be escaped. */
type VerbatimInline = PhrasingContent & { type: 'inlineCode' | 'inlineMath' | 'html' };
const VERBATIM = new Set(['inlineCode', 'inlineMath', 'html']);

/**
 * A paragraph that starts with `[label]:` is read as a link reference
 * definition (#44). Text escapes its brackets, but inline code, math and HTML
 * are written verbatim, so a leading link such as ``[`]:a`](url)`` would lose
 * its paragraph. Each `]` that would close such a label right before a `:` is
 * written as escaped text between the verbatim pieces instead (``[\]`:a`](url)``),
 * which keeps every character and parses back to the same text.
 */
function guardDefinitionLabel(children: PhrasingContent[]): PhrasingContent[] {
  const first = children[0];
  if (first?.type !== 'link') return children;
  // Walks the label in document order; returns true once the label is known to be safe.
  const walk = (nodes: PhrasingContent[]): boolean => {
    for (let index = 0; index < nodes.length; index++) {
      const node = nodes[index]!;
      if (VERBATIM.has(node.type)) {
        const verbatim = node as VerbatimInline;
        const close = verbatim.value.search(/[[\]]/);
        if (close === -1) continue;
        // `[` makes the label invalid; `]` not followed by `:` ends it harmlessly.
        if (verbatim.value[close] === '[' || verbatim.value[close + 1] !== ':') return true;
        const rest = verbatim.value.slice(close + 1);
        const parts: PhrasingContent[] = [];
        if (close > 0) parts.push({ ...verbatim, value: verbatim.value.slice(0, close) });
        parts.push({ type: 'text', value: ']' });
        parts.push({ ...verbatim, value: rest });
        nodes.splice(index, 1, ...parts);
        index += parts.length - 2; // continue with the verbatim remainder
      } else if (
        node.type === 'wikiLink' ||
        node.type === 'image' ||
        node.type === 'imageReference'
      ) {
        return true; // written with an unescaped `[`
      } else if ('children' in node && walk(node.children)) {
        return true;
      }
    }
    return false;
  };
  walk(first.children);
  return children;
}

const QUOTES = new Set(['blockquote', 'callout']);

/**
 * A list item can stay tight (no blank lines) when every block after the first
 * can interrupt a paragraph, no paragraph follows the first block, any nested
 * list comes last (later lines would join the nested list's paragraph), and no
 * two quotes touch (they would merge into one).
 */
function isTightSafe(item: ListItem): boolean {
  return item.children.every((child, index) => {
    if (index === 0) return true;
    const previous = item.children[index - 1];
    if (child.type === 'list')
      return index === item.children.length - 1 && interruptsParagraph(child);
    if (QUOTES.has(child.type) && previous && QUOTES.has(previous.type)) return false;
    return interruptsParagraph(child) && previous?.type !== 'list';
  });
}
