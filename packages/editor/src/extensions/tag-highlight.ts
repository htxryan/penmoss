/**
 * Inline `#tags` in the text (T18), shown as tags: a decoration with the
 * canonical name in `data-tag`, so the app can style them and react to a
 * click. The rules are core's (`@penmoss/core/tags`), the same the indexer
 * and the tag pane use, so what looks like a tag is one. Never in code: code
 * blocks and runs with the code mark are skipped.
 *
 * Only the text blocks a transaction touches are scanned again; the rest keep
 * their decorations, mapped through the change. Decorations are view-only:
 * nothing here writes to the document (D31).
 */
import { inlineTagRanges } from '@penmoss/core/tags';
import { Extension } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { changedNodes } from './changes';

export const tagHighlightKey = new PluginKey<DecorationSet>('penmossTagHighlight');

const isProse = (node: PMNode) => node.isTextblock && node.type.name !== 'codeBlock';

/** The tag decorations of one text block at `pos`. */
function decorateBlock(block: PMNode, pos: number): Decoration[] {
  // The block's text with inline code and inline nodes blanked, so offsets match positions.
  let text = '';
  block.forEach((child) => {
    if (child.isText && !child.marks.some((mark) => mark.type.name === 'code')) text += child.text;
    else text += ' '.repeat(child.nodeSize);
  });
  const start = pos + 1;
  return inlineTagRanges(text).map(({ index, length, tag }) =>
    Decoration.inline(start + index, start + index + length, {
      class: 'pm-tag',
      'data-tag': tag,
    }),
  );
}

function decorateAll(doc: PMNode): DecorationSet {
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    if (isProse(node)) decorations.push(...decorateBlock(node, pos));
    return false;
  });
  return DecorationSet.create(doc, decorations);
}

export const TagHighlight = Extension.create({
  name: 'tagHighlight',

  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: tagHighlightKey,
        state: {
          init: (_config, state) => decorateAll(state.doc),
          apply: (tr, previous, _old, state) => {
            if (!tr.docChanged) return previous;
            let set = previous.map(tr.mapping, state.doc);
            for (const [pos, block] of changedNodes(state.doc, [tr], (node) => node.isTextblock)) {
              const end = pos + block.nodeSize;
              set = set.remove(set.find(pos, end));
              if (isProse(block)) set = set.add(state.doc, decorateBlock(block, pos));
            }
            return set;
          },
        },
        props: {
          decorations: (state) => tagHighlightKey.getState(state),
        },
      }),
    ];
  },
});
