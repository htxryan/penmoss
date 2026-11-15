import type { EditorView } from '@tiptap/pm/view';
import { describe, expect, it } from 'vitest';
import { openEditor, paragraph, select, startOf } from './support/editor';

// PEN-144: a key that moves the caret to the note's start just after the note took focus keeps
// it there. ProseMirror reads a caret at the very start of the document, within 200 ms of a focus,
// as the browser's own reset on focus, and writes its last selection back over it; so ↓ from the
// title, ↓ and ↑ in quick succession (under load, the time a test takes) left the caret on the
// second line, and the next ↑ never reached the title.

/** ProseMirror's observer: what the page's `selectionchange` runs. */
const observer = (view: EditorView) =>
  (view as unknown as { domObserver: { flush(): void } }).domObserver;

/** The page's caret at a character of a block's text, as the browser puts it after a key. */
function domCaret(view: EditorView, block: number, offset: number): void {
  const text = view.dom.children[block]!.firstChild!;
  view.dom.ownerDocument.getSelection()!.collapse(text, offset);
}

function focused() {
  const collab = openEditor([paragraph('first line'), paragraph('second line')]);
  const { view } = collab.editor;
  view.focus();
  const second = startOf(view, 'paragraph', 1) + 3;
  select(view, second);
  return { view, second };
}

describe('the caret just after the note takes focus (PEN-144)', () => {
  it('stays at the note’s start when a key put it there', () => {
    const { view } = focused();
    view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    // The browser's ↑ moves the page's caret to the start, then reports it.
    domCaret(view, 0, 0);
    observer(view).flush();
    expect(view.state.selection.head).toBe(1);
  });

  it('is put back where the editor had it when no key moved it (the browser’s reset)', () => {
    const { view, second } = focused();
    domCaret(view, 0, 0);
    observer(view).flush();
    expect(view.state.selection.head).toBe(second);
  });

  it('is put back after a key that moves no caret, such as Shift', () => {
    const { view, second } = focused();
    view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', bubbles: true }));
    domCaret(view, 0, 0);
    observer(view).flush();
    expect(view.state.selection.head).toBe(second);
  });
});
