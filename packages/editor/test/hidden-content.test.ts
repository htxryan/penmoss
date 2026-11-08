import { parseMarkdown } from '@penmoss/core';
import type { JSONContent } from '@tiptap/core';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import { describe, expect, it } from 'vitest';
import { codeBlock, openEditor, paragraph, press, select } from './support/editor';

type Collab = ReturnType<typeof openEditor>;

const blocksOf = (markdown: string) =>
  (parseMarkdown(markdown).doc.toJSON() as JSONContent).content ?? [];

/** The position of the first node named `name`. */
function posOf(collab: Collab, name: string): number {
  let found = -1;
  collab.editor.state.doc.descendants((node, pos) => {
    if (found === -1 && node.type.name === name) found = pos;
    return found === -1;
  });
  if (found === -1) throw new Error(`No ${name}`);
  return found;
}

/** Puts the caret at the start (or end) of the last (or first) top-level paragraph. */
function caretIn(collab: Collab, which: 'first' | 'last', at: 'start' | 'end') {
  const { doc } = collab.editor.state;
  const index = which === 'first' ? 0 : doc.childCount - 1;
  let pos = 0;
  for (let i = 0; i < index; i += 1) pos += doc.child(i).nodeSize;
  const node = doc.child(index);
  select(collab.editor.view, at === 'start' ? pos + 1 : pos + node.nodeSize - 1);
}

function selectedNode(collab: Collab): string | null {
  const { selection } = collab.editor.state;
  return selection instanceof NodeSelection ? selection.node.type.name : null;
}

const diagram = () => [
  paragraph('before'),
  codeBlock('graph TD\n  A --> B', 'mermaid'),
  paragraph('after'),
];
const toggle = () => blocksOf('Before\n\n> [!faq]- Folded\n> Hidden answer.\n\nAfter\n');

describe('a diagram in preview hides its source from edits', () => {
  it('selects the diagram on Backspace at the start of the next paragraph', () => {
    const collab = openEditor(diagram());
    const before = collab.editor.state.doc;
    caretIn(collab, 'last', 'start');
    expect(press(collab.editor.view, 'Backspace')).toBe(true);
    expect(collab.editor.state.doc.eq(before)).toBe(true);
    expect(selectedNode(collab)).toBe('codeBlock');
  });

  it('selects the diagram on Delete at the end of the paragraph before', () => {
    const collab = openEditor(diagram());
    const before = collab.editor.state.doc;
    caretIn(collab, 'first', 'end');
    expect(press(collab.editor.view, 'Delete')).toBe(true);
    expect(collab.editor.state.doc.eq(before)).toBe(true);
    expect(selectedNode(collab)).toBe('codeBlock');
  });

  it('selects the diagram instead of moving the caret into its source with the arrows', () => {
    for (const [which, at, key] of [
      ['last', 'start', 'ArrowUp'],
      ['last', 'start', 'ArrowLeft'],
      ['first', 'end', 'ArrowDown'],
      ['first', 'end', 'ArrowRight'],
    ] as const) {
      const collab = openEditor(diagram());
      caretIn(collab, which, at);
      expect(press(collab.editor.view, key), key).toBe(true);
      expect(selectedNode(collab), key).toBe('codeBlock');
      collab.destroy();
    }
  });

  it('switches to the source when the caret lands in it anyway, and on Enter', () => {
    const collab = openEditor(diagram());
    const { view } = collab.editor;
    const block = view.dom.querySelector<HTMLElement>('.pm-code-block')!;
    expect(block.dataset['mode']).toBe('preview');
    select(view, posOf(collab, 'codeBlock') + 2);
    expect(block.dataset['mode']).toBe('edit');

    const again = openEditor(diagram());
    const other = again.editor.view.dom.querySelector<HTMLElement>('.pm-code-block')!;
    again.editor.view.dispatch(
      again.editor.state.tr.setSelection(
        NodeSelection.create(again.editor.state.doc, posOf(again, 'codeBlock')),
      ),
    );
    expect(press(again.editor.view, 'Enter')).toBe(true);
    expect(other.dataset['mode']).toBe('edit');
    expect(again.editor.state.selection).toBeInstanceOf(TextSelection);
    expect(again.editor.state.selection.$from.parent.type.name).toBe('codeBlock');
  });

  it('leaves the source alone in edit mode', () => {
    const collab = openEditor(diagram());
    const { view } = collab.editor;
    view.dom.querySelector<HTMLButtonElement>('button.pm-diagram-toggle')!.click();
    caretIn(collab, 'last', 'start');
    press(view, 'ArrowLeft');
    expect(selectedNode(collab)).toBeNull();
  });
});

describe('a folded toggle hides its body from edits', () => {
  it('selects the toggle on Backspace at the start of the next paragraph', () => {
    const collab = openEditor(toggle());
    const before = collab.editor.state.doc;
    caretIn(collab, 'last', 'start');
    expect(press(collab.editor.view, 'Backspace')).toBe(true);
    expect(collab.editor.state.doc.eq(before)).toBe(true);
    expect(selectedNode(collab)).toBe('callout');
  });

  it('selects the toggle on Delete before it and with the arrows', () => {
    for (const [which, at, key] of [
      ['first', 'end', 'Delete'],
      ['last', 'start', 'ArrowUp'],
      ['first', 'end', 'ArrowDown'],
    ] as const) {
      const collab = openEditor(toggle());
      const before = collab.editor.state.doc;
      caretIn(collab, which, at);
      expect(press(collab.editor.view, key), key).toBe(true);
      expect(collab.editor.state.doc.eq(before), key).toBe(true);
      expect(selectedNode(collab), key).toBe('callout');
      collab.destroy();
    }
  });

  it('opens when the caret lands in its body anyway, and on Enter', () => {
    const collab = openEditor(toggle());
    const { view } = collab.editor;
    const callout = view.dom.querySelector<HTMLElement>('.pm-callout')!;
    expect(callout.dataset['open']).toBe('false');
    select(view, posOf(collab, 'callout') + 2);
    expect(callout.dataset['open']).toBe('true');

    const again = openEditor(toggle());
    const other = again.editor.view.dom.querySelector<HTMLElement>('.pm-callout')!;
    again.editor.view.dispatch(
      again.editor.state.tr.setSelection(
        NodeSelection.create(again.editor.state.doc, posOf(again, 'callout')),
      ),
    );
    expect(press(again.editor.view, 'Enter')).toBe(true);
    expect(other.dataset['open']).toBe('true');
    expect(again.editor.state.selection.$from.parent.textContent).toBe('Hidden answer.');
  });

  it('leaves an open toggle alone', () => {
    const collab = openEditor(blocksOf('> [!faq]+ Open\n> Shown.\n\nAfter\n'));
    caretIn(collab, 'last', 'start');
    press(collab.editor.view, 'ArrowLeft');
    expect(selectedNode(collab)).toBeNull();
  });
});
