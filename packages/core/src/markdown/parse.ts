import type {
  Blockquote,
  List,
  ListItem,
  Nodes,
  Paragraph,
  PhrasingContent,
  RootContent,
  Table,
} from 'mdast';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { toMarkdown } from 'mdast-util-to-markdown';
import type { Mark, Node as PMNode } from 'prosemirror-model';
import { parseFrontmatter, type Frontmatter } from '../frontmatter';
import { schema } from '../schema';
import { CALLOUT_HEADER } from './callout-syntax';
import { fromTableCell } from './table-pipes';
import { fromMarkdownExtensions, micromarkExtensions, toMarkdownOptions } from './config';
import { unresolvedLinks, type CodecContext, type LinkResolver } from './context';
import type { WikiReference } from './mdast-types';
import { isSafeHref } from './safe-href';

export interface ParsedNote {
  /** Null when the file has no frontmatter block. */
  frontmatter: Frontmatter | null;
  doc: PMNode;
}

/** Paths under an `attachments/` folder are file attachments, not ordinary links. */

const ATTACHMENT_PATH = /(?:^|\/)attachments\/[^/]+$/;
/** `alt|300` or `alt|300x200`: Obsidian's image size suffix. */
const IMAGE_SIZE = /^([\s\S]*)\|(\d+)(?:x(\d+))?$/;
const HTML_LINE_BREAK = /^<br\s*\/?>$/i;

/**
 * Parses a markdown note into frontmatter and a ProseMirror document. Every
 * input parses: syntax the schema does not model becomes `rawMarkdown` or
 * `rawInline` and is written back verbatim.
 */
export function parseMarkdown(markdown: string, context: CodecContext = {}): ParsedNote {
  const source = markdown.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const tree = fromMarkdown(source, {
    extensions: micromarkExtensions,
    mdastExtensions: fromMarkdownExtensions,
  });
  let children = tree.children;
  let frontmatter: Frontmatter | null = null;
  const head = children[0];
  if (head?.type === 'yaml') {
    frontmatter = parseFrontmatter(head.value);
    children = children.slice(1);
  }
  const converter = new MdastToDoc(source, context.links ?? unresolvedLinks);
  const blocks = converter.blocks(children, true);
  const doc = schema.node('doc', null, blocks.length > 0 ? blocks : [paragraph([])]);
  return { frontmatter, doc };
}

function paragraph(content: PMNode[]): PMNode {
  return schema.node('paragraph', null, content);
}

/** Where inline content sits: running text, a heading (one line) or a table cell. */
type InlineContext = 'text' | 'heading' | 'cell';

class MdastToDoc {
  /** Hard breaks read from `<br>` in running text, with the tag as written. */
  private readonly htmlBreaks = new Map<PMNode, string>();

  constructor(
    private readonly source: string,
    private readonly links: LinkResolver,
  ) {}

  blocks(nodes: RootContent[], topLevel = false): PMNode[] {
    return nodes.flatMap((node) => this.block(node, topLevel));
  }

  /** Blocks for a container that must not be empty. */
  private filled(nodes: RootContent[]): PMNode[] {
    const blocks = this.blocks(nodes);
    return blocks.length > 0 ? blocks : [paragraph([])];
  }

  private block(node: RootContent, topLevel: boolean): PMNode[] {
    switch (node.type) {
      case 'paragraph': {
        const only = node.children.length === 1 ? node.children[0] : undefined;
        if (only?.type === 'wikiEmbed') {
          return [schema.node('embed', this.reference(only))];
        }
        return [paragraph(this.settleBreaks(this.inlines(node.children, [], 'text'), 'text'))];
      }
      case 'heading':
        return [
          schema.node('heading', { level: node.depth }, this.inlines(node.children, [], 'heading')),
        ];
      case 'thematicBreak':
        return [schema.node('horizontalRule')];
      case 'blockquote':
        return [this.blockquote(node)];
      case 'list':
        return this.list(node, topLevel);
      case 'code':
        return [
          schema.node(
            'codeBlock',
            { language: node.lang ?? null, meta: node.meta ?? null },
            node.value ? [schema.text(node.value)] : [],
          ),
        ];
      case 'math':
        if (node.meta) return [this.rawBlock(node, topLevel)];
        return [schema.node('blockMath', { latex: node.value })];
      case 'table':
        return [this.table(node)];
      case 'html':
        return [rawMarkdown(node.value)];
      default:
        return [this.rawBlock(node, topLevel)];
    }
  }

  private blockquote(node: Blockquote): PMNode {
    const first = node.children[0];
    if (first?.type === 'paragraph' && first.position) {
      const start = first.position.start.offset ?? 0;
      const paragraphEnd = first.position.end.offset ?? start;
      const newline = this.source.indexOf('\n', start);
      const lineEnd = newline === -1 ? paragraphEnd : Math.min(newline, paragraphEnd);
      const header = CALLOUT_HEADER.exec(this.source.slice(start, lineEnd));
      const bodyStart = header ? splitAfterFirstLine(first, lineEnd) : null;
      if (header && bodyStart) {
        const body: RootContent[] = bodyStart.length
          ? [{ type: 'paragraph', children: bodyStart }, ...node.children.slice(1)]
          : node.children.slice(1);
        return schema.node(
          'callout',
          {
            type: header[1],
            title: header[3] ?? '',
            foldable: header[2] !== '',
            collapsed: header[2] === '-',
          },
          this.filled(body),
        );
      }
    }
    return schema.node('blockquote', null, this.filled(node.children));
  }

  private list(node: List, topLevel: boolean): PMNode[] {
    if (node.ordered) {
      // There is no ordered task list: one with task items is kept verbatim.
      if (node.children.some((item) => typeof item.checked === 'boolean'))
        return [this.rawBlock(node, topLevel)];
      return [
        schema.node(
          'orderedList',
          { start: node.start ?? 1, tight: this.isTight(node.children) },
          node.children.map((item) => this.listItem(item, 'listItem')),
        ),
      ];
    }
    // A list mixing task items and plain items has no single node type: each run of
    // task items becomes a task list and each run of plain items a bullet list, side
    // by side, as the editor holds them (A157). Written back, the lists alternate
    // bullets (`-`, `*`) so they stay apart.
    const isTask = (item: ListItem) => typeof item.checked === 'boolean';
    const runs: ListItem[][] = [];
    for (const item of node.children) {
      const run = runs[runs.length - 1];
      if (run && isTask(run[0]!) === isTask(item)) run.push(item);
      else runs.push([item]);
    }
    return runs.map((items) => {
      const task = isTask(items[0]!);
      return schema.node(
        task ? 'taskList' : 'bulletList',
        { tight: this.isTight(items) },
        items.map((item) => this.listItem(item, task ? 'taskItem' : 'listItem')),
      );
    });
  }

  /**
   * Tightness comes from the source, not mdast's `spread` flags: those report a
   * list inside a blockquote as loose when a blank line merely follows it.
   */
  private isTight(items: readonly ListItem[]): boolean {
    return (
      !this.blankLineBetween(items) && items.every((item) => !this.blankLineBetween(item.children))
    );
  }

  private blankLineBetween(nodes: readonly Nodes[]): boolean {
    for (let index = 1; index < nodes.length; index++) {
      const end = nodes[index - 1]?.position?.end.offset;
      const start = nodes[index]?.position?.start.offset;
      if (end === undefined || start === undefined) return true;
      if ((this.source.slice(end, start).match(/\n/g)?.length ?? 0) >= 2) return true;
    }
    return false;
  }

  private listItem(item: ListItem, type: 'listItem' | 'taskItem'): PMNode {
    const blocks = this.blocks(item.children);
    if (blocks[0]?.type.name !== 'paragraph') blocks.unshift(paragraph([]));
    const attrs = type === 'taskItem' ? { checked: item.checked === true } : null;
    return schema.node(type, attrs, blocks);
  }

  private table(node: Table): PMNode {
    const width = node.children[0]?.children.length ?? 0;
    const rows = node.children.map((row, rowIndex) => {
      const cellType = rowIndex === 0 ? 'tableHeader' : 'tableCell';
      const cells = Array.from({ length: width }, (_, column) =>
        schema.node(
          cellType,
          { align: node.align?.[column] ?? null },
          this.settleBreaks(this.inlines(row.children[column]?.children ?? [], [], 'cell'), 'cell'),
        ),
      );
      return schema.node('tableRow', null, cells);
    });
    return schema.node('table', null, rows);
  }

  private inlines(
    nodes: PhrasingContent[],
    marks: readonly Mark[],
    where: InlineContext,
  ): PMNode[] {
    return nodes.flatMap((node) => this.inline(node, marks, where));
  }

  private inline(node: PhrasingContent, marks: readonly Mark[], where: InlineContext): PMNode[] {
    const inCell = where === 'cell';
    const withMark = (name: 'bold' | 'italic' | 'strike' | 'highlight') =>
      schema.marks[name].create().addToSet(marks);
    switch (node.type) {
      case 'text':
        return node.value ? [schema.text(node.value, marks)] : [];
      case 'strong':
        return this.inlines(node.children, withMark('bold'), where);
      case 'emphasis':
        return this.inlines(node.children, withMark('italic'), where);
      case 'delete':
        return this.inlines(node.children, withMark('strike'), where);
      case 'highlight':
        return this.inlines(node.children, withMark('highlight'), where);
      case 'inlineCode':
        return node.value
          ? [schema.text(node.value, schema.marks.code.create().addToSet(marks))]
          : [this.rawInline(node)];
      case 'link': {
        const only = node.children.length === 1 ? node.children[0] : undefined;
        if (only?.type === 'text' && !node.title && ATTACHMENT_PATH.test(node.url)) {
          return [
            schema.node('attachment', { href: node.url, name: only.value }, undefined, marks),
          ];
        }
        if (node.children.length === 0) return [this.rawInline(node)];
        // A link to a `javascript:`-like address is its text (A51, A139).
        if (!isSafeHref(node.url)) return this.inlines(node.children, marks, where);
        const link = schema.marks.link.create({ href: node.url, title: node.title ?? null });
        return this.inlines(node.children, link.addToSet(marks), where);
      }
      case 'image': {
        const size = IMAGE_SIZE.exec(node.alt ?? '');
        // A picture at a `javascript:`-like address is its alt text (A52, A139).
        if (!isSafeHref(node.url)) {
          const alt = size ? (size[1] ?? '') : (node.alt ?? '');
          return alt ? [schema.text(alt, marks)] : [];
        }
        const attrs = {
          src: node.url,
          alt: size ? (size[1] ?? '') : (node.alt ?? ''),
          title: node.title ?? null,
          width: size?.[2] ? Number(size[2]) : null,
          height: size?.[3] ? Number(size[3]) : null,
        };
        return [schema.node('image', attrs, undefined, marks)];
      }
      case 'break':
        return [schema.node('hardBreak', null, undefined, marks)];
      case 'inlineMath': {
        const latex = inCell ? fromTableCell(node.value) : node.value;
        return [schema.node('inlineMath', { latex }, undefined, marks)];
      }
      case 'wikiLink':
        return [schema.node('wikilink', this.reference(node), undefined, marks)];
      case 'html':
        if (where !== 'heading' && HTML_LINE_BREAK.test(node.value)) {
          // A line break as the editor makes one (in running text since A157);
          // `settleBreaks` tidies around it.
          const hardBreak = schema.node('hardBreak', null, undefined, marks);
          this.htmlBreaks.set(hardBreak, node.value);
          return [hardBreak];
        }
        return [schema.node('rawInline', { markdown: node.value }, undefined, marks)];
      default:
        // Inline embeds, footnote and reference links: kept verbatim.
        return [this.rawInline(node)];
    }
  }

  /**
   * A paragraph's or cell's content once `<br>` tags are hard breaks.
   * Markdown has no hard break at either end of a paragraph or cell (the
   * serialiser drops one there), so a `<br>` there stays raw inline markdown.
   * In running text (A157), raw HTML right after a break could start an HTML
   * block on the new line, so a `<br>` before it stays raw too, and spaces and
   * tabs beside a break are dropped (HTML shows none at a line break, and
   * markdown would have to escape them). Cells keep their text as it was.
   */
  private settleBreaks(content: PMNode[], where: 'text' | 'cell'): PMNode[] {
    if (this.htmlBreaks.size === 0) return content;
    const blank = (node: PMNode | undefined) =>
      where === 'text' && node?.isText === true && !/\S/.test(node.text!);
    const kept = new Set<PMNode>();
    content.forEach((node, index) => {
      if (!this.htmlBreaks.has(node)) return;
      let before = index - 1;
      while (blank(content[before])) before--;
      let after = index + 1;
      while (blank(content[after])) after++;
      const next = content[after];
      if (before < 0 || !next) return;
      if (where === 'text' && next.type.name === 'rawInline') return;
      kept.add(node);
    });
    const out: PMNode[] = [];
    content.forEach((node, index) => {
      const tag = this.htmlBreaks.get(node);
      if (tag !== undefined && !kept.has(node)) {
        out.push(schema.node('rawInline', { markdown: tag }, undefined, node.marks));
        return;
      }
      if (!node.isText || where === 'cell') {
        out.push(node);
        return;
      }
      let text = node.text!;
      if (kept.has(content[index + 1]!)) text = text.replace(/[ \t]+$/, '');
      if (kept.has(content[index - 1]!)) text = text.replace(/^[ \t]+/, '');
      if (text) out.push(text === node.text ? node : schema.text(text, node.marks));
    });
    return out;
  }

  private reference(node: WikiReference): Record<string, string | null> {
    const target = node.target.trim();
    return {
      noteId: target ? this.links.resolve(target) : null,
      target: node.target,
      heading: node.heading,
      alias: node.alias,
    };
  }

  private rawInline(node: PhrasingContent): PMNode {
    return schema.node('rawInline', { markdown: this.raw(node, false) });
  }

  private rawBlock(node: RootContent, topLevel: boolean): PMNode {
    return rawMarkdown(this.raw(node, topLevel));
  }

  /**
   * The markdown for a node the schema does not model. Top-level and
   * single-line nodes are sliced from the source verbatim; nested multi-line
   * nodes would carry their containers' prefixes, so they are re-serialised.
   */
  private raw(node: Nodes, topLevel: boolean): string {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start !== undefined && end !== undefined) {
      const slice = this.source.slice(start, end);
      if (topLevel || !slice.includes('\n')) return slice;
    }
    const root = { type: 'root' as const, children: [node as RootContent] };
    return toMarkdown(root, toMarkdownOptions).replace(/\n+$/, '');
  }
}

function rawMarkdown(markdown: string): PMNode {
  return schema.node('rawMarkdown', null, markdown ? [schema.text(markdown)] : []);
}

/**
 * The phrasing content of `paragraph` after its first line (which ends at
 * source offset `lineEnd`), used to split a callout header from its body.
 * Null when a span (such as emphasis) crosses the line end, so there is no
 * clean split.
 */
function splitAfterFirstLine(paragraph: Paragraph, lineEnd: number): PhrasingContent[] | null {
  const rest: PhrasingContent[] = [];
  let found = false;
  for (const child of paragraph.children) {
    const childStart = child.position?.start.offset ?? 0;
    const childEnd = child.position?.end.offset ?? 0;
    if (found || childStart >= lineEnd) {
      found = true;
      rest.push(child);
    } else if (childEnd > lineEnd) {
      found = true;
      if (child.type === 'text') {
        const tail = child.value.slice(child.value.indexOf('\n') + 1);
        if (tail) rest.push({ type: 'text', value: tail });
      } else if (child.type !== 'break') {
        return null;
      }
    }
  }
  return rest;
}
