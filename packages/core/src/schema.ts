import { Schema, type AttributeSpec, type MarkSpec, type NodeSpec } from 'prosemirror-model';

/**
 * The single Penmoss document schema (A9). The markdown codec, the server-side
 * edit engine and the editor all use these specs; `packages/editor` builds its
 * TipTap extensions from them and compares `describeSchema()` output in CI.
 *
 * Node and mark names follow TipTap's conventions (`bulletList`, `bold`, …) so
 * the editor can reuse TipTap's commands and keyboard handling.
 *
 * The specs are model-only: no `toDOM`/`parseDOM`, because core must run in
 * workerd with no DOM. The editor adds rendering on top.
 */

function validateHeadingLevel(value: unknown): void {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 6) {
    throw new RangeError(`Heading level must be an integer 1–6, got ${String(value)}`);
  }
}

function validateAlign(value: unknown): void {
  if (value !== null && value !== 'left' && value !== 'center' && value !== 'right') {
    throw new RangeError(`Table cell align must be left, center, right or null`);
  }
}

const nullableString: AttributeSpec = { default: null, validate: 'string|null' };
const nullableNumber: AttributeSpec = { default: null, validate: 'number|null' };

/** Attributes prosemirror-tables expects on cells, plus GFM column alignment. */
const cellAttrs: Record<string, AttributeSpec> = {
  colspan: { default: 1, validate: 'number' },
  rowspan: { default: 1, validate: 'number' },
  colwidth: { default: null },
  align: { default: null, validate: validateAlign },
};

/** Note reference shared by wikilinks and embeds. `noteId` is null when unresolved. */
const noteRefAttrs: Record<string, AttributeSpec> = {
  noteId: nullableString,
  target: { validate: 'string' },
  heading: nullableString,
  alias: nullableString,
};

/** Lists are tight (no blank lines between items) unless markdown made them loose. */
const tight: AttributeSpec = { default: true, validate: 'boolean' };

// Insertion order matters: it is the schema's node order (the first block is the default).
export const nodeSpecs = {
  doc: { content: 'block+' },
  paragraph: { content: 'inline*', group: 'block' },
  heading: {
    content: 'inline*',
    group: 'block',
    defining: true,
    attrs: { level: { default: 1, validate: validateHeadingLevel } },
  },
  blockquote: { content: 'block+', group: 'block', defining: true },
  callout: {
    content: 'block+',
    group: 'block',
    defining: true,
    attrs: {
      /** Obsidian callout type as written (`note`, `warning`, …). */
      type: { default: 'note', validate: 'string' },
      /** Title line as raw markdown; empty when the callout has no title. */
      title: { default: '', validate: 'string' },
      /** `[!type]+` or `[!type]-`: the callout can fold (a toggle). */
      foldable: { default: false, validate: 'boolean' },
      /** `[!type]-`: folded by default. Open/closed state while editing is per-device UI state. */
      collapsed: { default: false, validate: 'boolean' },
    },
  },
  bulletList: { content: 'listItem+', group: 'block list', attrs: { tight } },
  orderedList: {
    content: 'listItem+',
    group: 'block list',
    attrs: { start: { default: 1, validate: 'number' }, tight },
  },
  listItem: { content: 'paragraph block*', defining: true },
  taskList: { content: 'taskItem+', group: 'block list', attrs: { tight } },
  taskItem: {
    content: 'paragraph block*',
    defining: true,
    attrs: { checked: { default: false, validate: 'boolean' } },
  },
  codeBlock: {
    content: 'text*',
    marks: '',
    group: 'block',
    code: true,
    defining: true,
    /** Mermaid diagrams are code blocks with `language: 'mermaid'` (ADR 0002). */
    attrs: { language: nullableString, meta: nullableString },
  },
  blockMath: { group: 'block', atom: true, attrs: { latex: { default: '', validate: 'string' } } },
  horizontalRule: { group: 'block' },
  table: { content: 'tableRow+', group: 'block', isolating: true, tableRole: 'table' },
  tableRow: { content: '(tableHeader | tableCell)+', tableRole: 'row' },
  tableHeader: { content: 'inline*', isolating: true, attrs: cellAttrs, tableRole: 'header_cell' },
  tableCell: { content: 'inline*', isolating: true, attrs: cellAttrs, tableRole: 'cell' },
  /** `![[Title#Heading]]` on its own line: a read-only, live embed of another note. */
  embed: { group: 'block', atom: true, attrs: noteRefAttrs },
  /** Markdown the codec does not model (HTML, footnotes, reference definitions, …), kept verbatim. */
  rawMarkdown: { content: 'text*', marks: '', group: 'block', code: true },
  text: { group: 'inline' },
  hardBreak: { inline: true, group: 'inline', selectable: false },
  image: {
    inline: true,
    group: 'inline',
    draggable: true,
    attrs: {
      src: { validate: 'string' },
      alt: { default: '', validate: 'string' },
      title: nullableString,
      /** Display width in pixels, written `![alt|300](src)`. */
      width: nullableNumber,
      /** Display height in pixels, written `![alt|300x200](src)`. */
      height: nullableNumber,
    },
  },
  inlineMath: {
    inline: true,
    group: 'inline',
    atom: true,
    attrs: { latex: { default: '', validate: 'string' } },
  },
  /** `[[Title]]`, `[[Title#Heading]]`, `[[Title|alias]]`, resolved to a note ID. */
  wikilink: { inline: true, group: 'inline', atom: true, attrs: noteRefAttrs },
  /** A link to a file under `attachments/` (PDFs and other non-image files). */
  attachment: {
    inline: true,
    group: 'inline',
    atom: true,
    attrs: { href: { validate: 'string' }, name: { default: '', validate: 'string' } },
  },
  /** Inline markdown the codec does not model (inline HTML, footnote references, …), kept verbatim. */
  rawInline: {
    inline: true,
    group: 'inline',
    atom: true,
    attrs: { markdown: { validate: 'string' } },
  },
} satisfies Record<string, NodeSpec>;

// Insertion order is the nesting order when serialising: link outermost, code innermost.
// Italic wraps bold so bold italic text is written `***x***` (CommonMark's em(strong)).
export const markSpecs = {
  link: {
    inclusive: false,
    attrs: { href: { validate: 'string' }, title: nullableString },
  },
  italic: {},
  bold: {},
  strike: {},
  highlight: {},
  code: {},
} satisfies Record<string, MarkSpec>;

export type NodeName = keyof typeof nodeSpecs;
export type MarkName = keyof typeof markSpecs;

export const schema: Schema<NodeName, MarkName> = new Schema({
  nodes: nodeSpecs,
  marks: markSpecs,
});

/** Spec fields that change what documents are valid or how they behave; DOM hooks are excluded. */
const NODE_FIELDS = [
  'content',
  'marks',
  'group',
  'inline',
  'atom',
  'code',
  'defining',
  'isolating',
  'selectable',
  'draggable',
  'whitespace',
  'tableRole',
] as const;
const MARK_FIELDS = ['inclusive', 'excludes', 'group', 'spanning'] as const;

function describeAttrs(attrs: Record<string, AttributeSpec> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(attrs ?? {})) {
    out[name] = {
      default: 'default' in spec ? (spec.default as unknown) : '(required)',
      validate: typeof spec.validate === 'function' ? 'function' : (spec.validate ?? null),
    };
  }
  return out;
}

/**
 * A plain-JSON description of a schema's model (node and mark order, content
 * expressions, groups, attributes). Two schemas with equal descriptions accept
 * the same documents; the editor's CI test compares its TipTap schema to core's.
 */
export function describeSchema(target: Schema): unknown {
  const nodes = Object.values(target.nodes).map((type) => {
    const spec = type.spec as Record<string, unknown>;
    const fields = Object.fromEntries(NODE_FIELDS.map((key) => [key, spec[key] ?? null]));
    return { name: type.name, ...fields, attrs: describeAttrs(type.spec.attrs) };
  });
  const marks = Object.values(target.marks).map((type) => {
    const spec = type.spec as Record<string, unknown>;
    const fields = Object.fromEntries(MARK_FIELDS.map((key) => [key, spec[key] ?? null]));
    return { name: type.name, ...fields, attrs: describeAttrs(type.spec.attrs) };
  });
  return { topNode: target.topNodeType.name, nodes, marks };
}
