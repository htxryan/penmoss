/**
 * A tiny local schema for the T4 sync spike: StarterKit, tables and a nested
 * callout (Obsidian-style, optionally foldable like a toggle). It mirrors the
 * content expressions of T3's core schema (`callout: block+`) without
 * depending on it; T6 switches the editor to the core schema.
 */
import { mergeAttributes, Node, type AnyExtension, type JSONContent } from '@tiptap/core';
import { TableKit } from '@tiptap/extension-table';
import { StarterKit } from '@tiptap/starter-kit';

export const Callout = Node.create({
  name: 'callout',
  group: 'block',
  content: 'block+',
  defining: true,
  addAttributes() {
    return {
      type: {
        default: 'note',
        parseHTML: (element) => element.getAttribute('data-callout') ?? 'note',
        renderHTML: (attributes) => ({ 'data-callout': String(attributes.type) }),
      },
      foldable: {
        default: false,
        parseHTML: (element) => element.hasAttribute('data-foldable'),
        renderHTML: (attributes) => (attributes.foldable ? { 'data-foldable': '' } : {}),
      },
    };
  },
  parseHTML() {
    return [{ tag: 'div[data-callout]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { class: 'callout' }), 0];
  },
});

/** Editor extensions for the spike. Undo comes from the Yjs binding, so StarterKit's is off. */
export function spikeExtensions(): AnyExtension[] {
  return [
    StarterKit.configure({ undoRedo: false }),
    TableKit.configure({ table: { resizable: false } }),
    Callout,
  ];
}

const paragraph = (text: string): JSONContent => ({
  type: 'paragraph',
  content: [{ type: 'text', text }],
});
const cell = (text: string): JSONContent => ({ type: 'tableCell', content: [paragraph(text)] });

/** Starting content for the spike: a table and a callout nested in a foldable callout. */
export const spikeDocument: JSONContent = {
  type: 'doc',
  content: [
    paragraph('Intro'),
    {
      type: 'table',
      content: [
        { type: 'tableRow', content: [cell('Cell A1'), cell('Cell B1')] },
        { type: 'tableRow', content: [cell('Cell A2'), cell('Cell B2')] },
      ],
    },
    {
      type: 'callout',
      attrs: { type: 'note', foldable: true },
      content: [
        paragraph('Outer callout'),
        { type: 'callout', attrs: { type: 'tip' }, content: [paragraph('Nested body')] },
      ],
    },
    paragraph('Outro'),
  ],
};
