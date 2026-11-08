/**
 * Markdown on the clipboard (T15): telling markdown from prose, parsing it
 * with the core codec into editor content, and writing copied content as
 * markdown. The codec is about 70 kB gzipped, so it loads on first use
 * (the editor asks for it when it first gets focus) and these helpers take
 * it as an argument.
 */
import type { JSONContent } from '@tiptap/core';
import {
  Fragment,
  Slice,
  type Node as PMNode,
  type ResolvedPos,
  type Schema,
} from '@tiptap/pm/model';
import { safeHref } from './sanitize';

type Core = typeof import('@penmoss/core');
/** The parts of `@penmoss/core` the clipboard uses. */
export type Codec = Pick<
  Core,
  'parseMarkdown' | 'serializeMarkdown' | 'schema' | 'createFrontmatter'
>;
/** Fields for a whole note's frontmatter (Copy as Markdown with nothing selected). */
export type NoteFields = Parameters<Core['createFrontmatter']>[0];

let loaded: Codec | null = null;
let loading: Promise<Codec> | null = null;

/** Starts loading the codec (once) and resolves with it. */
export function loadCodec(): Promise<Codec> {
  loading ??= import('@penmoss/core').then(
    (core) => (loaded = core),
    (error: unknown) => {
      loading = null; // A failed chunk load (offline before it was cached) can be retried.
      throw error;
    },
  );
  return loading;
}

/** The codec if it has loaded, else null. */
export function readyCodec(): Codec | null {
  return loaded;
}

// ---------------------------------------------------------------------------
// Is this plain text markdown?

/**
 * Whether pasted plain text is markdown rather than prose. Block syntax counts
 * most: a fenced code block, a table, a checklist, a callout, frontmatter or a
 * `[link](url)` is enough on its own, and so is a heading followed by a blank
 * line or a list of at least two items. Inline markers (`**bold**`, `` `code` ``,
 * `~~strike~~`, `==highlight==`, a quote, a rule) count once each, and two are
 * needed. A single `*` or `_` never counts (`2*3*4`, `snake_case`), and neither
 * does a lone `# comment` line, which is more often code than a heading.
 */
export function looksLikeMarkdown(text: string): boolean {
  if (!text.trim()) return false;
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let score = 0;
  const strong = () => (score += 2);
  const weak = new Set<string>();

  if (/^---\n[\s\S]*?\n---(\n|$)/.test(text.replace(/\r\n?/g, '\n'))) strong();
  let fences = 0;
  let listRun = 0;
  let longestList = 0;
  lines.forEach((line, index) => {
    if (/^\s{0,3}(```|~~~)/.test(line)) fences += 1;
    if (/^#{1,6}\s+\S/.test(line)) {
      const next = lines[index + 1];
      if (next === undefined ? index > 0 : next.trim() === '') strong();
    }
    if (/^\s*[-*+]\s+\[[ xX]\]\s/.test(line)) strong();
    if (/^>\s*\[![\w-]+\]/.test(line)) strong();
    if (/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line)) strong();
    if (/^\s{0,3}\$\$\s*$/.test(line)) strong();
    if (/^\s*([-*+]|\d{1,3}[.)])\s+\S/.test(line)) {
      listRun += 1;
      longestList = Math.max(longestList, listRun);
    } else if (line.trim() !== '' && !/^\s{2,}\S/.test(line)) {
      listRun = 0;
    }
    if (/^>\s/.test(line)) weak.add('quote');
    if (/^\s{0,3}(-{3,}|\*{3,}|_{3,})\s*$/.test(line) && index > 0) weak.add('rule');
  });
  if (fences >= 2) strong();
  if (longestList >= 2) strong();
  if (/!?\[[^\]\n]+\]\((?:https?:\/\/|mailto:|attachments\/|\.\.?\/|#)[^)\s]*\)/.test(text))
    strong();
  if (/\*\*[^*\n]+\*\*|__[^_\n]+__/.test(text)) weak.add('bold');
  if (/`[^`\n]+`/.test(text)) weak.add('code');
  if (/~~[^~\n]+~~/.test(text)) weak.add('strike');
  if (/==[^=\n]+==/.test(text)) weak.add('highlight');
  if (/\[\[[^\]\n]+\]\]/.test(text)) weak.add('wikilink');
  return score + weak.size >= 2;
}

/**
 * Rewrites the prose lines of pasted markdown, leaving fenced and indented
 * code and frontmatter alone. `rewrite` gets each prose line and the one
 * before it (null after a blank line or code).
 */
function mapProse(
  markdown: string,
  rewrite: (line: string, previous: string | null) => string,
): string {
  const lines = markdown.split('\n');
  let fence = false;
  let frontmatter = lines[0] === '---';
  let inList = false;
  let code = false;
  let previous: string | null = null;
  return lines
    .map((line, index) => {
      if (frontmatter) {
        if (index > 0 && line === '---') frontmatter = false;
        return line;
      }
      if (/^\s{0,3}(```|~~~)/.test(line)) {
        fence = !fence;
        previous = null;
        return line;
      }
      if (fence) return line;
      if (line.trim() === '') {
        previous = null;
        return line; // A blank line keeps indented code going.
      }
      const indented = /^( {4}|\t)/.test(line);
      // Indented code starts after a blank line (or code), outside a list; in a list the
      // indentation is the item's own text.
      if (indented && !inList && (code || previous === null)) {
        code = true;
        return line;
      }
      code = false;
      if (/^\s{0,3}([-*+]|\d{1,9}[.)])(\s|$)/.test(line)) inList = true;
      else if (!/^\s/.test(line)) inList = false;
      const out = rewrite(line, previous);
      previous = line;
      return out;
    })
    .join('\n');
}

/** Splits a line into code spans (odd indexes) and the text around them (even indexes). */
const outsideCode = (line: string, rewrite: (text: string) => string) =>
  line
    .split(/(`+[^`]*`+)/)
    .map((part, i) => (i % 2 === 1 ? part : rewrite(part)))
    .join('');

/**
 * Escapes `$` before a number when it reads as money (`$5`, `($12.50)`),
 * outside code, so prose such as "between $5 and $10" does not become a
 * formula. Formulas starting with a digit (`$2^n$`) are rare in pasted text.
 */
export function escapeCurrency(markdown: string): string {
  return mapProse(markdown, (line) =>
    outsideCode(line, (text) => text.replace(/(^|[\s(])\$(?=\d)/g, '$1\\$')),
  );
}

/**
 * Markdown pasted as text, made to say what its writer meant (A53):
 *
 * - money is text (`escapeCurrency`);
 * - `*` between digits is multiplication (`2*3*4`), not emphasis;
 * - a line of one or two `-` or `=` under a line of text (an email
 *   signature's `--`) stays text, and `---` under text is a rule: only an
 *   `===` underline makes a (setext) heading. Penmoss itself writes `#`
 *   headings, and text with a dashed line under it is rarely a heading.
 */
export function prepareMarkdown(markdown: string): string {
  return mapProse(escapeCurrency(markdown), (line, previous) => {
    const underline = /^ {0,3}(-+|=+)[ \t]*$/.exec(line);
    if (underline && previous !== null && isParagraphLine(previous)) {
      const run = underline[1]!;
      if (run.length < 3) return `\\${line.trimStart()}`;
      if (run.startsWith('-')) return `\n${line}`;
      return line;
    }
    return outsideCode(line, (text) =>
      text
        .split(/((?<!\\)\$[^$\n]*(?<!\\)\$)/)
        .map((part, i) => (i % 2 === 1 ? part : part.replace(/(?<=\d)\*(?=\d)/g, '\\*')))
        .join(''),
    );
  });
}

/** Whether a line is paragraph text (what a setext underline would turn into a heading). */
function isParagraphLine(line: string): boolean {
  return !/^\s{0,3}([-*+]\s|\d{1,9}[.)]\s|#{1,6}(\s|$)|>|\||(-{3,}|\*{3,}|_{3,}|={3,})\s*$)/.test(
    line,
  );
}

// ---------------------------------------------------------------------------
// Markdown → editor content.

type Json = JSONContent & { text?: string; marks?: JSONContent['marks'] };

const textNode = (text: string, marks?: Json['marks']): Json[] =>
  text ? [{ type: 'text', text, ...(marks?.length ? { marks } : {}) }] : [];

/** Text with a hard break for each line break. */
function lines(text: string, marks?: Json['marks']): Json[] {
  return text
    .split('\n')
    .flatMap((line, i) => [...(i > 0 ? [{ type: 'hardBreak' }] : []), ...textNode(line, marks)]);
}

/** Kept as text even though the editor has them: a paste never makes raw markdown (A159). */
const AS_TEXT = new Set(['rawInline', 'rawMarkdown']);

/**
 * Core JSON for the editor's schema. The codec's verbatim raw markdown
 * becomes its text (pasted HTML stays inert, A159), and so do nodes an
 * editor schema lacks (wikilinks, embeds and attachments, for a schema
 * without them), so nothing is lost.
 */
function adapt(raw: Json, schema: Schema): Json[] {
  const node: Json = { ...raw, ...(raw.marks ? { marks: safeMarks(raw.marks) } : {}) };
  const type = node.type ?? '';
  const attrs = (node.attrs ?? {}) as Record<string, string | null>;
  if (type === 'image') return picture(node, attrs);
  if (schema.nodes[type] && !AS_TEXT.has(type)) {
    return [
      {
        ...node,
        ...(node.content ? { content: node.content.flatMap((child) => adapt(child, schema)) } : {}),
      },
    ];
  }
  const ref = () =>
    `${attrs['target'] ?? ''}${attrs['heading'] ? `#${attrs['heading']}` : ''}${attrs['alias'] ? `|${attrs['alias']}` : ''}`;
  switch (type) {
    case 'wikilink':
      return textNode(`[[${ref()}]]`, node.marks);
    case 'rawInline':
      return lines(attrs['markdown'] ?? '', node.marks);
    case 'attachment': {
      const href = safeHref(attrs['href'] ?? null);
      const name = attrs['name'] || (attrs['href'] ?? '');
      return href ? textNode(name, linked(node.marks, href)) : textNode(name, node.marks);
    }
    case 'embed':
      return [{ type: 'paragraph', content: textNode(`![[${ref()}]]`) }];
    case 'rawMarkdown': {
      const text = (node.content ?? []).map((child: Json) => child.text ?? '').join('');
      return [{ type: 'paragraph', content: lines(text) }];
    }
    default:
      return [];
  }
}

/** Link marks with checked addresses (A51's rules); an unsafe link becomes its text. */
function safeMarks(marks: NonNullable<Json['marks']>): NonNullable<Json['marks']> {
  return marks.flatMap((mark) => {
    if (mark.type !== 'link') return [mark];
    const href = safeHref((mark.attrs?.['href'] as string | undefined) ?? null);
    return href ? [{ ...mark, attrs: { ...mark.attrs, href } }] : [];
  });
}

/** `marks` plus a link to `href`, unless the text is already in a link. */
function linked(marks: Json['marks'], href: string): NonNullable<Json['marks']> {
  const list = marks ?? [];
  if (list.some((mark) => mark.type === 'link')) return list;
  return [...list, { type: 'link', attrs: { href, title: null } }];
}

/**
 * A picture in pasted markdown (A52): one stored in Penmoss stays a picture;
 * a web picture becomes a link to it (pasting must not make the browser fetch
 * from a third party: badges and tracking pixels); anything else is its alt text.
 */
function picture(node: Json, attrs: Record<string, string | null>): Json[] {
  const src = safeHref(attrs['src'] ?? null);
  const alt = attrs['alt'] ?? '';
  if (src && !/^[a-z][a-z0-9+.-]*:/i.test(src)) return [node]; // attachments/…
  if (src && /^https?:/i.test(src)) return textNode(alt || 'Image', linked(node.marks, src));
  return textNode(alt, node.marks);
}

/** Parses markdown into editor blocks (frontmatter is dropped). */
export function markdownToFragment(markdown: string, schema: Schema, codec: Codec): Fragment {
  const { doc } = codec.parseMarkdown(prepareMarkdown(markdown));
  const content = adapt(doc.toJSON() as Json, schema)[0]?.content ?? [];
  try {
    return schema.nodeFromJSON({ type: 'doc', content }).content;
  } catch {
    // Content the editor cannot hold where the codec put it: keep the text.
    const text = doc.textBetween(0, doc.content.size, '\n\n', '\n');
    return Fragment.from(
      text
        .split(/\n{2,}/)
        .map((block) => schema.nodes['paragraph']!.create(null, block ? schema.text(block) : null)),
    );
  }
}

/**
 * A slice of parsed markdown. A paragraph at either edge is open, so its text
 * joins the text it is pasted into; a list pasted into the same kind of list
 * adds its items to it; headings, code blocks, tables and other blocks stay
 * whole blocks, since markdown said so explicitly.
 */
export function markdownToSlice(
  markdown: string,
  schema: Schema,
  codec: Codec,
  $context?: ResolvedPos,
): Slice {
  const fragment = markdownToFragment(markdown, schema, codec);
  const around = new Set<string>();
  if ($context)
    for (let depth = $context.depth; depth > 0; depth--) around.add($context.node(depth).type.name);
  // A paragraph opens to its text; a list pasted into the same kind of list opens to its
  // items, which join the list as siblings; anything else is a closed block.
  const depth = (node: PMNode | null) => {
    if (node?.type.name === 'paragraph') return 1;
    if (node && /\blist\b/.test(node.type.spec.group ?? '') && around.has(node.type.name)) return 1;
    return 0;
  };
  return new Slice(fragment, depth(fragment.firstChild), depth(fragment.lastChild));
}

// ---------------------------------------------------------------------------
// Editor content → markdown.

const WRAPPERS: Record<string, string> = {
  listItem: 'bulletList',
  taskItem: 'taskList',
  tableRow: 'table',
};

/**
 * Wraps nodes that cannot stand at the top of a document (list items, rows,
 * inline content). List items go back into a copy of the list they came
 * from (`lists`, by item type), so an ordered list keeps its numbers.
 */
function topLevel(
  content: Fragment,
  schema: Schema,
  lists: ReadonlyMap<string, PMNode> = new Map(),
): PMNode[] {
  const out: PMNode[] = [];
  const run: { type: string | null; item: string | null; nodes: PMNode[] } = {
    type: null,
    item: null,
    nodes: [],
  };
  const flush = () => {
    if (run.type) {
      const from = run.item ? lists.get(run.item) : undefined;
      out.push(
        from
          ? schema.nodes[from.type.name]!.create(from.attrs, run.nodes)
          : schema.nodes[run.type]!.create(null, run.nodes),
      );
    }
    run.type = null;
    run.item = null;
    run.nodes = [];
  };
  content.forEach((node) => {
    const name = node.type.name;
    if (name === 'tableCell' || name === 'tableHeader') {
      flush();
      out.push(schema.nodes['paragraph']!.create(null, node.content));
      return;
    }
    const wrapper = node.isInline ? 'paragraph' : (WRAPPERS[name] ?? null);
    if (!wrapper) {
      flush();
      out.push(node);
      return;
    }
    if (run.type !== wrapper) flush();
    run.type = wrapper;
    run.item = node.isInline ? null : name;
    run.nodes.push(node);
  });
  flush();
  return out;
}

/** Leaf text for plain-text copies: alt text, a formula's LaTeX, a line break. */
export function leafText(node: PMNode): string {
  switch (node.type.name) {
    case 'image':
      return (node.attrs['alt'] as string) || '';
    case 'inlineMath':
      return `$${node.attrs['latex'] as string}$`;
    case 'blockMath':
      return `$$\n${node.attrs['latex'] as string}\n$$`;
    case 'hardBreak':
      return '\n';
    case 'rawInline':
      return (node.attrs['markdown'] as string) || '';
    default:
      return '';
  }
}

/**
 * What a copied slice says as markdown. A selection inside one text block is
 * its inline markdown (no `## ` for a few words of a heading); inside a code
 * block it is the code itself. Otherwise blocks are written whole, in the
 * codec's normal form. With `frontmatter`, the slice is a whole note.
 */
export function sliceToMarkdown(
  slice: Slice,
  codec: Codec,
  frontmatter: NoteFields | null = null,
): string {
  const schema = codec.schema as Schema;
  // A selection inside one text block: its inline markdown, or a code block's code.
  let inner = slice.content;
  for (let depth = 0; depth < Math.min(slice.openStart, slice.openEnd); depth++) {
    const only = inner.childCount === 1 ? inner.firstChild! : null;
    if (!only || only.isLeaf) break;
    if (only.isTextblock) {
      if (only.type.spec.code) return only.textContent;
      return write(
        schema,
        codec,
        [schema.nodes['paragraph']!.create(null, convert(only.content, schema))],
        null,
      );
    }
    inner = only.content;
  }
  // Otherwise whole blocks, without the containers the selection started and ended
  // inside (as copying text out of a quote gives the text), except tables and rows.
  // Items taken out of a list go back into a copy of it.
  let { content } = slice;
  let open = Math.min(slice.openStart, slice.openEnd);
  const lists = new Map<string, PMNode>();
  while (open > 0 && content.childCount === 1 && !content.firstChild!.isLeaf) {
    const node = content.firstChild!;
    if (node.type.spec['tableRole'] === 'table' || node.type.spec['tableRole'] === 'row') break;
    if (node.isTextblock) break;
    if (/\blist\b/.test(node.type.spec.group ?? '') && node.firstChild) {
      lists.set(node.firstChild.type.name, node);
    }
    content = node.content;
    open -= 1;
  }
  return write(schema, codec, topLevel(convert(content, schema), schema, lists), frontmatter);
}

function write(
  schema: Schema,
  codec: Codec,
  nodes: PMNode[],
  frontmatter: NoteFields | null,
): string {
  if (nodes.length === 0) return '';
  const doc = schema.nodes['doc']!.create(null, nodes);
  const markdown = codec.serializeMarkdown({
    frontmatter: frontmatter ? codec.createFrontmatter(frontmatter) : null,
    doc,
  });
  return frontmatter ? markdown : markdown.replace(/\n+$/, '');
}

/** Editor content in core's schema (the editor's is a subset, A9). */
function convert(content: Fragment, schema: Schema): Fragment {
  return Fragment.fromJSON(schema, content.toJSON());
}
