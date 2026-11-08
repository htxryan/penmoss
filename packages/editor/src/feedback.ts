/**
 * The Send feedback form's description editor (T49, A790): the Penmoss editor with a reduced
 * schema, written out by the notes' own markdown serialiser, so the issue gets the same GitHub
 * markdown a note would. It has bold, italic, bulleted and numbered lists (nested), links,
 * inline code, code blocks and quotes; no headings, tables, images, wikilinks or underline
 * (markdown has none). Every node and mark is core's (A9), so a description is a core document
 * and `feedbackMarkdown` serialises it with `serializeMarkdown`.
 *
 * Undo is TipTap's own history: the description is not a synced note.
 */
import { schema as coreSchema, type MarkName, type NodeName } from '@penmoss/core/schema';
import { Editor, Extension, type AnyExtension, type JSONContent } from '@tiptap/core';
import { Bold } from '@tiptap/extension-bold';
import { Code } from '@tiptap/extension-code';
import { CodeBlock } from '@tiptap/extension-code-block';
import { Italic } from '@tiptap/extension-italic';
import { Link } from '@tiptap/extension-link';
import { BulletList, ListItem, ListKeymap, OrderedList } from '@tiptap/extension-list';
import { StarterKit } from '@tiptap/starter-kit';
import { alignMark, alignNode } from './extensions';

export type { Editor as FeedbackEditor, JSONContent } from '@tiptap/core';

/** The nodes and marks a description can hold (A790). */
export const FEEDBACK_NODES = [
  'doc',
  'paragraph',
  'text',
  'hardBreak',
  'blockquote',
  'bulletList',
  'orderedList',
  'listItem',
  'codeBlock',
] as const satisfies readonly NodeName[];

export const FEEDBACK_MARKS = [
  'link',
  'italic',
  'bold',
  'code',
] as const satisfies readonly MarkName[];

/** Keys that would do something markdown cannot keep: swallowed (Mod-U, underline). */
const NoUnderline = Extension.create({
  name: 'feedbackNoUnderline',
  addKeyboardShortcuts() {
    return { 'Mod-u': () => true };
  },
});

/** The reduced editor's extensions: marks first, in core's order (link outermost). */
export function feedbackExtensions(): AnyExtension[] {
  return [
    alignMark(Link.configure({ openOnClick: false, autolink: true, linkOnPaste: true }), 'link'),
    alignMark(Italic, 'italic'),
    alignMark(Bold, 'bold'),
    alignMark(
      // The note editor's key (Mod-E is the recent-notes switcher, T20).
      Code.extend({
        addKeyboardShortcuts() {
          return { 'Mod-Shift-e': () => this.editor.commands.toggleCode() };
        },
      }),
      'code',
    ),
    StarterKit.configure({
      bold: false,
      italic: false,
      code: false,
      link: false,
      strike: false,
      underline: false,
      heading: false,
      horizontalRule: false,
      codeBlock: false,
      bulletList: false,
      orderedList: false,
      listItem: false,
      listKeymap: false,
      trailingNode: false,
    }),
    alignNode(BulletList, 'bulletList'),
    alignNode(OrderedList, 'orderedList'),
    alignNode(ListItem, 'listItem'),
    ListKeymap,
    alignNode(CodeBlock, 'codeBlock'),
    NoUnderline,
  ];
}

export interface FeedbackEditorOptions {
  readonly element: HTMLElement;
  /** A draft's description (`editor.getJSON()` as it was saved). */
  readonly content?: JSONContent | null;
  /** The field's accessible name, and the element that describes it. */
  readonly label: string;
  readonly describedBy?: string;
  readonly onUpdate?: (editor: Editor) => void;
}

/** The description editor in `element`. A draft that no longer fits starts empty. */
export function createFeedbackEditor(options: FeedbackEditorOptions): Editor {
  const attributes: Record<string, string> = {
    role: 'textbox',
    'aria-multiline': 'true',
    'aria-label': options.label,
    class: 'feedback-description-editor',
    'data-testid': 'feedback-description',
  };
  if (options.describedBy) attributes['aria-describedby'] = options.describedBy;
  return new Editor({
    element: options.element,
    extensions: feedbackExtensions(),
    content: fits(options.content) ? options.content : null,
    editorProps: { attributes },
    onUpdate: ({ editor }) => options.onUpdate?.(editor),
  });
}

/** Whether `content` is a description this schema can open. */
function fits(content: JSONContent | null | undefined): content is JSONContent {
  if (!content) return false;
  try {
    feedbackDoc(content);
    return true;
  } catch {
    return false;
  }
}

const NODES: ReadonlySet<string> = new Set(FEEDBACK_NODES);
const MARKS: ReadonlySet<string> = new Set(FEEDBACK_MARKS);

/** The description as a core document; throws for anything outside the reduced schema. */
export function feedbackDoc(content: JSONContent) {
  const check = (node: JSONContent) => {
    if (!node.type || !NODES.has(node.type)) {
      throw new RangeError(`Not in a description: ${node.type ?? '?'}`);
    }
    for (const mark of node.marks ?? []) {
      if (!MARKS.has(mark.type)) throw new RangeError(`Not in a description: ${mark.type}`);
    }
    node.content?.forEach(check);
  };
  check(content);
  const doc = coreSchema.nodeFromJSON(content);
  doc.check();
  return doc;
}

/** Whether the description has any text in it. */
export function isEmptyDescription(content: JSONContent | null | undefined): boolean {
  if (!content) return true;
  let text = false;
  const walk = (node: JSONContent) => {
    if (node.type === 'text' && node.text?.trim()) text = true;
    node.content?.forEach(walk);
  };
  walk(content);
  return !text;
}

let codec: Promise<typeof import('@penmoss/core')> | null = null;

/**
 * Loads the markdown codec (lazily, as the app does) once. The form calls it as it opens, so a
 * submission made after the connection drops still serialises (A796).
 */
export function loadFeedbackMarkdown(): Promise<typeof import('@penmoss/core')> {
  codec ??= import('@penmoss/core').catch((error: unknown) => {
    codec = null;
    throw error;
  });
  return codec;
}

/** The description as GitHub markdown: the notes' serialiser over the core document (A790). */
export async function feedbackMarkdown(content: JSONContent | null | undefined): Promise<string> {
  if (!content || isEmptyDescription(content)) return '';
  const { serializeMarkdown } = await loadFeedbackMarkdown();
  return serializeMarkdown({ frontmatter: null, doc: feedbackDoc(content) }).trim();
}

/** One button of the form's formatting bar. */
export interface FeedbackFormat {
  readonly id: string;
  readonly label: string;
  /** TipTap's keys for it (`Mod-b`), shown in the button's tooltip. */
  readonly keys: string;
  readonly run: (editor: Editor) => boolean;
  readonly active: (editor: Editor) => boolean;
}

export const FEEDBACK_FORMATS: readonly FeedbackFormat[] = [
  {
    id: 'bold',
    label: 'Bold',
    keys: 'Mod-b',
    run: (e) => e.chain().focus().toggleBold().run(),
    active: (e) => e.isActive('bold'),
  },
  {
    id: 'italic',
    label: 'Italic',
    keys: 'Mod-i',
    run: (e) => e.chain().focus().toggleItalic().run(),
    active: (e) => e.isActive('italic'),
  },
  {
    id: 'code',
    label: 'Inline Code',
    keys: 'Mod-Shift-e',
    run: (e) => e.chain().focus().toggleCode().run(),
    active: (e) => e.isActive('code'),
  },
  {
    id: 'bulletList',
    label: 'Bulleted List',
    keys: 'Mod-Shift-8',
    run: (e) => e.chain().focus().toggleBulletList().run(),
    active: (e) => e.isActive('bulletList'),
  },
  {
    id: 'orderedList',
    label: 'Numbered List',
    keys: 'Mod-Shift-7',
    run: (e) => e.chain().focus().toggleOrderedList().run(),
    active: (e) => e.isActive('orderedList'),
  },
  {
    id: 'indent',
    label: 'Nest the List Item',
    keys: 'Tab',
    run: (e) => e.chain().focus().sinkListItem('listItem').run(),
    active: () => false,
  },
  {
    id: 'outdent',
    label: 'Unnest the List Item',
    keys: 'Shift-Tab',
    run: (e) => e.chain().focus().liftListItem('listItem').run(),
    active: () => false,
  },
  {
    id: 'blockquote',
    label: 'Quote',
    keys: 'Mod-Shift-b',
    run: (e) => e.chain().focus().toggleBlockquote().run(),
    active: (e) => e.isActive('blockquote'),
  },
  {
    id: 'codeBlock',
    label: 'Code Block',
    keys: 'Mod-Alt-c',
    run: (e) => e.chain().focus().toggleCodeBlock().run(),
    active: (e) => e.isActive('codeBlock'),
  },
];

/**
 * Links the selection to `href`, or inserts `href` as a link at the caret when nothing is
 * selected; an empty `href` removes the link there. Only http, https and mailto addresses.
 */
export function setFeedbackLink(editor: Editor, href: string): boolean {
  const address = href.trim();
  if (!address) return editor.chain().focus().extendMarkRange('link').unsetLink().run();
  if (!/^(https?:\/\/|mailto:)\S+$/i.test(address)) return false;
  const { empty } = editor.state.selection;
  if (empty && !editor.isActive('link')) {
    return editor
      .chain()
      .focus()
      .insertContent({
        type: 'text',
        text: address,
        marks: [{ type: 'link', attrs: { href: address } }],
      })
      .run();
  }
  return editor.chain().focus().extendMarkRange('link').setLink({ href: address }).run();
}
