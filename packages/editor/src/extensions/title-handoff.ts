/**
 * Backspace at the start of a note's first line (T64 item 6): the line joins the title, as the
 * line below a paragraph joins it, and the caret goes to the join in the title. The editor does
 * not hold the title, so it asks the view with a cancelable event on its element; a view that
 * takes the line cancels it, and only then does the line leave the note. A first line that is
 * not plain text (a heading, a list, a link to a note) keeps Backspace's usual meaning.
 */
import { Extension } from '@tiptap/core';

export const BACKSPACE_INTO_TITLE = 'penmoss:backspace-into-title';

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
