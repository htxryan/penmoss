/**
 * Markdown the codec keeps as written (A157): `rawMarkdown` blocks (HTML
 * blocks and comments, footnotes, reference definitions, ordered lists with
 * task items, …) and `rawInline` spans (inline HTML, footnote references,
 * embeds inside running text, …). An agent's markdown, an import or a
 * restored version can hold them, so the editor must be able to open them.
 *
 * Both show their markdown as text, never as HTML, visibly marked as
 * markdown kept as written. A raw block edits like a code block (its text is
 * the markdown, written back byte for byte); a raw span is one atom, deleted
 * or kept whole. The model comes from core (`noteExtensions` aligns it, A9).
 *
 * Pastes never make them: pasted markdown's raw parts become text (A159),
 * and pasted HTML is rebuilt by the sanitiser, which knows neither.
 */
import { mergeAttributes, Node } from '@tiptap/core';

/** Shown before a raw block and as its tooltip. */
export const RAW_LABEL = 'Markdown kept as written';

const markdownOf = (attrs: Record<string, unknown>): string =>
  typeof attrs['markdown'] === 'string' ? attrs['markdown'] : '';

export const RawMarkdown = Node.create({
  name: 'rawMarkdown',

  parseHTML() {
    // Ahead of code blocks' `pre` rule.
    return [{ tag: 'pre[data-raw-markdown]', preserveWhitespace: 'full', priority: 60 }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'pre',
      mergeAttributes(HTMLAttributes, {
        'data-raw-markdown': '',
        class: 'pm-raw-markdown',
        title: RAW_LABEL,
        spellcheck: 'false',
      }),
      ['code', 0],
    ];
  },
});

export const RawInline = Node.create({
  name: 'rawInline',

  addAttributes() {
    return {
      markdown: {
        default: '',
        parseHTML: (element: HTMLElement) =>
          element.getAttribute('data-markdown') ?? element.textContent ?? '',
        renderHTML: (attrs: Record<string, unknown>) => ({ 'data-markdown': markdownOf(attrs) }),
      },
    };
  },

  parseHTML() {
    // Ahead of the inline code mark's `code` rule.
    return [{ tag: 'code[data-raw-inline]', priority: 60 }];
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      'code',
      mergeAttributes(HTMLAttributes, {
        'data-raw-inline': '',
        class: 'pm-raw-inline',
        title: RAW_LABEL,
      }),
      markdownOf(node.attrs),
    ];
  },

  renderText({ node }) {
    return markdownOf(node.attrs);
  },
});
