import { schema as coreSchema, serializeMarkdown } from '@penmoss/core';
import type { JSONContent } from '@tiptap/core';
import { describe, expect, it } from 'vitest';
import { openEditor, press, select, startOf } from './support/editor';

// T64 item 7: Backspace twice at the start of a numbered item put the items below it in a list
// of their own that nothing could join back.

const item = (text: string): JSONContent => ({
  type: 'listItem',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});
const ordered = (...texts: string[]): JSONContent => ({
  type: 'orderedList',
  content: texts.map(item),
});
const bullets = (...texts: string[]): JSONContent => ({
  type: 'bulletList',
  content: texts.map(item),
});

type Collab = ReturnType<typeof openEditor>;
const markdownOf = (collab: Collab) =>
  serializeMarkdown({ frontmatter: null, doc: coreSchema.nodeFromJSON(collab.editor.getJSON()) });
/** The note's blocks, without the empty line the editor always keeps last. */
const lists = (collab: Collab) => {
  const types = (collab.editor.getJSON().content ?? []).map((node) => node.type);
  return types.at(-1) === 'paragraph' ? types.slice(0, -1) : types;
};

describe('Backspace in a numbered list (T64 item 7)', () => {
  it('joins the line into the item above, and the list stays one list', () => {
    const collab = openEditor([ordered('one', 'two', 'three')]);
    const { view } = collab.editor;
    view.focus();
    const at = startOf(view, 'paragraph', 1);
    select(view, at);
    press(view, 'Backspace'); // The number goes: "two" is a line between two lists.
    expect(lists(collab)).toEqual(['orderedList', 'paragraph', 'orderedList']);
    press(view, 'Backspace'); // It joins "one", and the lists are one again.
    expect(lists(collab)).toEqual(['orderedList']);
    expect(markdownOf(collab)).toBe('1. onetwo\n2. three\n');
  });

  it('closes the gap an emptied line leaves', () => {
    // An empty item: no text node.
    const empty = { type: 'listItem', content: [{ type: 'paragraph' }] };
    const collab = openEditor([
      { type: 'orderedList', content: [item('one'), empty, item('three')] },
    ]);
    const { view } = collab.editor;
    view.focus();
    select(view, startOf(view, 'paragraph', 1));
    press(view, 'Backspace');
    press(view, 'Backspace');
    expect(lists(collab)).toEqual(['orderedList']);
    expect(markdownOf(collab)).toBe('1. one\n2. three\n');
  });

  it('joins bullet lists the same way, and never a numbered list to a bulleted one', () => {
    const collab = openEditor([bullets('a', 'b', 'c')]);
    const { view } = collab.editor;
    view.focus();
    select(view, startOf(view, 'paragraph', 1));
    press(view, 'Backspace');
    press(view, 'Backspace');
    expect(lists(collab)).toEqual(['bulletList']);

    const mixed = openEditor([ordered('one'), { type: 'paragraph' }, bullets('b')]);
    mixed.editor.view.focus();
    select(mixed.editor.view, startOf(mixed.editor.view, 'paragraph', 1));
    press(mixed.editor.view, 'Backspace');
    expect(lists(mixed)).toEqual(['orderedList', 'bulletList']);
  });

  it('leaves lists apart while a line stands between them', () => {
    const collab = openEditor([
      ordered('one'),
      { type: 'paragraph', content: [{ type: 'text', text: 'between' }] },
      ordered('two'),
    ]);
    const { view } = collab.editor;
    view.focus();
    select(view, startOf(view, 'paragraph', 1) + 3);
    press(view, 'Backspace');
    expect(lists(collab)).toEqual(['orderedList', 'paragraph', 'orderedList']);
  });
});
