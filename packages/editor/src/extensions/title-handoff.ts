/**
 * Backspace at the start of a note's first line (T64 item 6): the line joins the title, as the
 * line below a paragraph joins it, and the caret goes to the join in the title. The editor does
 * not hold the title, so it asks the view with a cancelable event on its element; a view that
 * takes the line cancels it, and only then does the line leave the note. A first line that is
 * not plain text (a heading, a list, a link to a note) keeps Backspace's usual meaning.
 */
import { Extension } from '@tiptap/core';
import { Selection, TextSelection } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

export const BACKSPACE_INTO_TITLE = 'penmoss:backspace-into-title';

/**
 * ↑ on the note's first line, as wrapped (PEN-135): the caret goes to the end of the title, as ↓
 * on the title's last line comes to the start of this line. Asked the same way as Backspace.
 */
export const ARROW_UP_INTO_TITLE = 'penmoss:arrow-up-into-title';

export interface BackspaceIntoTitleDetail {
  /** The line's text, to add at the title's end: empty for an empty line. */
  readonly text: string;
}

export const TitleHandoff = Extension.create({
  name: 'titleHandoff',
  // Ahead of the core keymap's Backspace, which does nothing at the very start.
  priority: 101,

  addKeyboardShortcuts() {
    return {
      Backspace: () => {
        const { state, view } = this.editor;
        const { selection, doc } = state;
        const { $from } = selection;
        if (!selection.empty || $from.depth !== 1 || $from.index(0) !== 0) return false;
        if ($from.parentOffset !== 0 || $from.parent.type.name !== 'paragraph') return false;
        const line = $from.parent;
        let plain = true;
        line.forEach((child) => {
          if (!child.isText) plain = false;
        });
        if (!plain) return false;
        const detail: BackspaceIntoTitleDetail = { text: line.textContent };
        const event = new CustomEvent(BACKSPACE_INTO_TITLE, {
          detail,
          bubbles: true,
          cancelable: true,
        });
        view.dom.dispatchEvent(event);
        if (!event.defaultPrevented) return false;
        const tr = state.tr;
        if (doc.childCount > 1) tr.delete(0, line.nodeSize);
        else tr.delete(1, 1 + line.content.size);
        view.dispatch(tr.scrollIntoView());
        return true;
      },
    };
  },
});

/**
 * Where the caret is, as the page has it: a key pressed straight after another (a held ↓, then ↑)
 * can arrive before the browser's `selectionchange` has told the editor where the last one put it.
 * Null when there is a selection, not a caret.
 */
function caretHead(view: EditorView): number | null {
  const dom = (view.root as Document).getSelection?.();
  if (dom?.focusNode && view.dom.contains(dom.focusNode)) {
    if (!dom.isCollapsed) return null;
    try {
      return view.posAtDOM(dom.focusNode, dom.focusOffset);
    } catch {
      // Not a position in the note: the editor's own state says.
    }
  }
  const { selection } = view.state;
  return selection.empty ? selection.head : null;
}

/**
 * ↑ from the note's first line into the title. Below the other extensions' ↑ (a table's rows, an
 * open menu's choices), so it only takes a key nothing in the note wanted.
 */
export const TitleArrowUp = Extension.create({
  name: 'titleArrowUp',
  priority: 50,

  addKeyboardShortcuts() {
    return {
      ArrowUp: () => {
        const { view, state } = this.editor;
        const first = Selection.atStart(state.doc);
        const head = caretHead(view);
        if (!(first instanceof TextSelection) || head === null) return false;
        if (!state.doc.resolve(head).sameParent(first.$from)) return false;
        // On the first line as wrapped: the caret's top is the line's, not a line further down.
        const line = view.coordsAtPos(first.from, 1);
        const caret = view.coordsAtPos(head, 1);
        if (caret.top - line.top > (line.bottom - line.top) / 2) return false;
        const event = new CustomEvent(ARROW_UP_INTO_TITLE, { bubbles: true, cancelable: true });
        view.dom.dispatchEvent(event);
        return event.defaultPrevented;
      },
    };
  },
});
