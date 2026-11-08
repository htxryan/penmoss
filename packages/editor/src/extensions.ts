/**
 * The note editor's TipTap extensions, aligned with the core schema (A9).
 *
 * TipTap's extensions supply rendering, input rules, commands and keyboard
 * handling; the model (content expressions, groups, flags and attributes)
 * comes from `@penmoss/core/schema`, so a document the markdown codec or the
 * server builds always fits the editor and the other way round. Attributes
 * TipTap adds that core does not model (an ordered list's `type`, a link's
 * `target`/`rel`/`class`) are dropped; attributes core adds (`tight`, a code
 * block's `meta`) are kept on the node but not rendered.
 *
 * The editor grew task by task (T6 text and lists; T9 code; T10 images; T11
 * tables and callouts; T12 math; T14 highlight; T16 wikilinks; T13 embeds and
 * attachments) and now has every core node (A157: raw markdown too).
 * `schema.test.ts` checks every node and mark against core.
 */
import { markSpecs, nodeSpecs, type MarkName, type NodeName } from '@penmoss/core/schema';
import type { AnyExtension, Attributes, Mark, Node } from '@tiptap/core';
import { Bold } from '@tiptap/extension-bold';
import { Code } from '@tiptap/extension-code';
import { Heading, type HeadingOptions, type Level } from '@tiptap/extension-heading';
import { Paragraph } from '@tiptap/extension-paragraph';
import { Highlight } from '@tiptap/extension-highlight';
import { Italic } from '@tiptap/extension-italic';
import { Link } from '@tiptap/extension-link';
import {
  BulletList,
  ListItem,
  ListKeymap,
  OrderedList,
  TaskItem,
  TaskList,
} from '@tiptap/extension-list';
import { Strike } from '@tiptap/extension-strike';
import { TableCell, TableHeader } from '@tiptap/extension-table';
import { StarterKit } from '@tiptap/starter-kit';
import type { AttributeSpec, MarkSpec, NodeSpec } from '@tiptap/pm/model';
import { BlockMove } from './extensions/drag-handle';
import { Callout, memoryFoldState, type FoldState } from './extensions/callout';
import { ChecklistShortcut } from './extensions/checklist';
import { ListJoin } from './extensions/list-join';
import { TitleHandoff } from './extensions/title-handoff';
import { blockTypeKey } from './block-keys';
import { CodeHighlight, PenmossCodeBlock } from './extensions/code-block';
import { HiddenContent } from './extensions/hidden-content';
import { BlockMath, InlineMath } from './extensions/math';
import { PenmossTable, PenmossTableRow, TableShortcuts } from './extensions/table';
import { imageExtension, type ImageServices } from './extensions/image';
import { LinkShortcut } from './extensions/link-shortcut';
import { SlashMenuExtension } from './extensions/slash-menu';
import { SelectionToolbarExtension } from './extensions/bubble-toolbar';
import { Clipboard, type ClipboardOptions } from './clipboard';
import { wikilinkExtension, type LinkServices } from './extensions/wikilink';
import { attachmentExtension, type FileServices } from './extensions/attachment';
import { embedExtension } from './extensions/embed';
import { TagHighlight } from './extensions/tag-highlight';
import { AgentHighlight } from './extensions/agent-highlight';
import { Comments } from './extensions/comments';
import { RawInline, RawMarkdown } from './extensions/raw-markdown';
import { FocusSelection } from './extensions/focus-selection';
import { fixedSymbols, LineSymbols, type SymbolSource } from './extensions/line-symbols';
import type { LineSymbol } from '@penmoss/core/line-symbols';

/**
 * Node and mark names the editor supports: every node core has (A157), so
 * any document the codec or the server builds opens here.
 */
export const NOTE_NODES = [
  'doc',
  'paragraph',
  'heading',
  'blockquote',
  'bulletList',
  'orderedList',
  'listItem',
  'taskList',
  'taskItem',
  'codeBlock',
  'blockMath',
  'callout',
  'table',
  'tableRow',
  'tableHeader',
  'tableCell',
  'horizontalRule',
  'hardBreak',
  'inlineMath',
  'text',
  'image',
  'wikilink',
  'embed',
  'attachment',
  'rawMarkdown',
  'rawInline',
] as const satisfies readonly NodeName[];

export const NOTE_MARKS = [
  'bold',
  'italic',
  'strike',
  'highlight',
  'code',
  'link',
] as const satisfies readonly MarkName[];

const NODE_MODEL_FIELDS = [
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

/**
 * TipTap attributes for a core attribute set: keeps the parent extension's
 * HTML parsing and rendering for attributes core shares, takes defaults and
 * validation from core, and drops attributes core does not model.
 */
export function alignAttributes(
  parent: Attributes,
  core: Record<string, AttributeSpec> | undefined,
): Attributes {
  const out: Attributes = {};
  for (const [name, spec] of Object.entries(core ?? {})) {
    const inherited = parent[name];
    const required = !('default' in spec);
    out[name] = {
      ...(inherited ?? { rendered: false }),
      ...(required ? { isRequired: true } : { default: spec.default as unknown }),
      ...(spec.validate === undefined ? {} : { validate: spec.validate }),
    };
  }
  return out;
}

function coreNodeConfig(name: NodeName) {
  const spec: NodeSpec = nodeSpecs[name];
  const config: Record<string, unknown> = {};
  for (const field of NODE_MODEL_FIELDS) {
    if (spec[field] !== undefined) config[field] = spec[field];
  }
  return { config, attrs: spec.attrs };
}

/** `extension` with its model (content, group, flags, attributes) taken from core. */
export function alignNode<O, S>(extension: Node<O, S>, name: NodeName): Node<O, S> {
  const { config, attrs } = coreNodeConfig(name);
  return extension.extend({
    ...config,
    addAttributes() {
      return alignAttributes(this.parent?.() ?? {}, attrs);
    },
  });
}

/** `extension` with its model (inclusive, excludes, attributes) taken from core. */
export function alignMark<O, S>(extension: Mark<O, S>, name: MarkName): Mark<O, S> {
  const spec: MarkSpec = markSpecs[name];
  return extension.extend({
    // Functions, so an unset core field clears TipTap's value instead of inheriting it.
    inclusive: () => spec.inclusive,
    excludes: () => spec.excludes,
    addAttributes() {
      return alignAttributes(this.parent?.() ?? {}, spec.attrs);
    },
  });
}

export interface NoteExtensionsOptions {
  /** Storage and display for pasted and dropped images (T10). */
  readonly images?: ImageServices;
  /** Where toggles remember being open or closed on this device (T11); in memory by default. */
  readonly foldState?: FoldState;
  /** The note's frontmatter for whole-note copies, and a hook for "Copied" notices (T15). */
  readonly clipboard?: Pick<ClipboardOptions, 'note' | 'onCopy'>;
  /** The note registry for wikilinks (T16): titles, completion, creating and opening notes. */
  readonly links?: LinkServices;
  /** Storage for attached files (T13): PDFs and other files, their sizes and downloads. */
  readonly files?: FileServices;
  /** The person's line symbols (T44, A743): the synced list, live; the defaults without. */
  readonly symbols?: SymbolSource | readonly LineSymbol[];
  /** Opens Settings → Symbols, for the picker's "Edit symbols…" (T44). */
  readonly onEditSymbols?: () => void;
  /** A symbol slot's shortcut as shown on keycaps, for the picker (T44). */
  readonly symbolShortcut?: (index: number) => string | null;
  /** Comment threads (T48): highlights, and the toolbar's Comment button. Off by default. */
  readonly comments?: boolean;
}

/**
 * Attributes that markdown keeps but TipTap does not render, written to HTML
 * so a copy pasted into another note keeps them (T15): a loose list's
 * tightness, a cell's alignment (shown in the editor too) and a code fence's meta.
 */
const tightAttribute = {
  tight: {
    default: true,
    parseHTML: (element: HTMLElement) => element.getAttribute('data-tight') !== 'false',
    renderHTML: (attrs: Record<string, unknown>) =>
      attrs['tight'] === false ? { 'data-tight': 'false' } : {},
  },
};

function cellAlign(element: HTMLElement): string | null {
  const value = (element.getAttribute('align') ?? element.style.textAlign ?? '').toLowerCase();
  return value === 'left' || value === 'center' || value === 'right' ? value : null;
}

const alignAttribute = {
  align: {
    default: null,
    parseHTML: cellAlign,
    renderHTML: (attrs: Record<string, unknown>) =>
      typeof attrs['align'] === 'string' ? { style: `text-align: ${attrs['align']}` } : {},
  },
};

function withAttributes<O, S>(extension: Node<O, S>, attributes: Attributes): Node<O, S> {
  return extension.extend({
    addAttributes() {
      return { ...this.parent?.(), ...attributes };
    },
  });
}

const codeMetaAttribute = {
  meta: {
    default: null,
    parseHTML: (element: HTMLElement) => element.getAttribute('data-meta'),
    renderHTML: (attrs: Record<string, unknown>) =>
      typeof attrs['meta'] === 'string' && attrs['meta'] ? { 'data-meta': attrs['meta'] } : {},
  },
};

/**
 * Extensions for real notes. Undo comes from the Yjs binding (createCollabEditor),
 * so StarterKit's history is off.
 *
 * Marks come first, in core's order: a schema ranks marks by definition order,
 * and the rank decides how marks nest (link outermost, code innermost).
 * Paragraph stays the first block (TipTap gives it a high priority).
 */
export function noteExtensions(options: NoteExtensionsOptions = {}): AnyExtension[] {
  return [
    alignMark(Link.configure({ openOnClick: true, autolink: true }), 'link'),
    alignMark(Italic, 'italic'),
    alignMark(Bold, 'bold'),
    alignMark(Strike, 'strike'),
    alignMark(Highlight, 'highlight'),
    alignMark(
      // Mod-Shift-E rather than TipTap's Mod-E, which T20 gives to the recent-notes switcher.
      Code.extend({
        addKeyboardShortcuts() {
          return { 'Mod-Shift-e': () => this.editor.commands.toggleCode() };
        },
      }),
      'code',
    ),
    // Turn into text and headings with the platform's keys (block-keys.ts, A90).
    Paragraph.extend({
      addKeyboardShortcuts() {
        return { [blockTypeKey(0)]: () => this.editor.commands.setParagraph() };
      },
    }),
    StarterKit.configure({
      paragraph: false,
      undoRedo: false,
      underline: false,
      bold: false,
      italic: false,
      strike: false,
      code: false,
      link: false,
      heading: false,
      codeBlock: false,
      bulletList: false,
      orderedList: false,
      listItem: false,
      listKeymap: false,
    }),
    alignNode(
      Heading.extend({
        addKeyboardShortcuts() {
          return Object.fromEntries(
            (this.options as HeadingOptions).levels.map((level: Level) => [
              blockTypeKey(level),
              () => this.editor.commands.toggleHeading({ level }),
            ]),
          );
        },
      }),
      'heading',
    ),
    alignNode(withAttributes(BulletList, tightAttribute), 'bulletList'),
    alignNode(withAttributes(OrderedList, tightAttribute), 'orderedList'),
    alignNode(ListItem, 'listItem'),
    alignNode(withAttributes(TaskList, tightAttribute), 'taskList'),
    alignNode(TaskItem.configure({ nested: true }), 'taskItem'),
    alignNode(withAttributes(PenmossCodeBlock, codeMetaAttribute), 'codeBlock'),
    CodeHighlight,
    // Ahead of images: a paste or drop with any non-image file is handled here, all of it.
    alignNode(attachmentExtension(options.files), 'attachment'),
    imageExtension(options.images),
    alignNode(Callout.configure({ foldState: options.foldState ?? memoryFoldState() }), 'callout'),
    alignNode(PenmossTable, 'table'),
    alignNode(PenmossTableRow, 'tableRow'),
    alignNode(withAttributes(TableHeader, alignAttribute), 'tableHeader'),
    alignNode(withAttributes(TableCell, alignAttribute), 'tableCell'),
    TableShortcuts,
    ChecklistShortcut,
    ListJoin,
    TitleHandoff,
    alignNode(InlineMath, 'inlineMath'),
    alignNode(BlockMath, 'blockMath'),
    alignNode(wikilinkExtension(options.links), 'wikilink'),
    alignNode(
      embedExtension(options.links, options.images ?? options.files, options.files),
      'embed',
    ),
    // Markdown kept as written (A157): agents, imports and old versions can hold it.
    alignNode(RawMarkdown, 'rawMarkdown'),
    alignNode(RawInline, 'rawInline'),
    LinkShortcut,
    BlockMove,
    SlashMenuExtension.configure({
      images: options.images,
      links: options.links,
      files: options.files,
    }),
    SelectionToolbarExtension,
    // A key pressed as the note takes focus keeps its selection (#224, A1141).
    FocusSelection,
    ListKeymap,
    HiddenContent,
    Clipboard.configure({ images: options.images, ...options.clipboard }),
    TagHighlight,
    AgentHighlight,
    Comments.configure({ enabled: options.comments === true }),
    LineSymbols.configure({
      symbols: Array.isArray(options.symbols)
        ? fixedSymbols(options.symbols)
        : (options.symbols as SymbolSource | undefined),
      onEditSymbols: options.onEditSymbols,
      shortcutOf: options.symbolShortcut,
    }),
  ];
}
