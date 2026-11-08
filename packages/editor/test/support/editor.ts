import { createYjs14Replica } from '@penmoss/sync-client/yjs14';
import type { JSONContent } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { afterEach } from 'vitest';
import { createCollabEditor, type CollabEditor } from '../../src/collab';
import { noteExtensions, type NoteExtensionsOptions } from '../../src/extensions';

const open: CollabEditor[] = [];
afterEach(() => {
  for (const collab of open.splice(0)) collab.destroy();
  document.body.replaceChildren();
});

/** A note editor bound to a fresh replica, attached to the document so focus and layout work. */
export function openEditor(content?: JSONContent[], options?: NoteExtensionsOptions): CollabEditor {
  const element = document.createElement('div');
  document.body.append(element);
  const collab = createCollabEditor({
    element,
    extensions: noteExtensions(options),
    replica: createYjs14Replica(),
  });
  open.push(collab);
  if (content) collab.editor.commands.setContent({ type: 'doc', content });
  return collab;
}

/** Types `text` one character at a time, through input rules, as a user would (`\n` is Enter, `\t` Tab). */
export function type(view: EditorView, text: string): void {
  for (const char of text) {
    if (char === '\n' || char === '\t') {
      press(view, char === '\n' ? 'Enter' : 'Tab');
      continue;
    }
    const { from, to } = view.state.selection;
    const handled = view.someProp('handleTextInput', (handle) =>
      handle(view, from, to, char, () => view.state.tr.insertText(char, from, to)),
    );
    if (!handled) view.dispatch(view.state.tr.insertText(char, from, to));
  }
}

/** Presses a key (with modifiers) on the editor, through its keymaps. */
export function press(
  view: EditorView,
  key: string,
  modifiers: {
    shiftKey?: boolean;
    ctrlKey?: boolean;
    metaKey?: boolean;
    altKey?: boolean;
    /** The legacy key code a browser also sends (keymaps fall back to it for shifted letters). */
    keyCode?: number;
  } = {},
): boolean {
  const event = new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
    ...modifiers,
  });
  return view.someProp('handleKeyDown', (handle) => handle(view, event)) ?? false;
}

/** Puts the caret (or a selection) at document positions. */
export function select(view: EditorView, from: number, to = from): void {
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)));
}

/** Position just inside the start of the first node of `type` (its first content position). */
export function startOf(view: EditorView, typeName: string, index = 0): number {
  let found = -1;
  let seen = 0;
  view.state.doc.descendants((node, pos) => {
    if (found !== -1) return false;
    if (node.type.name === typeName) {
      if (seen === index) found = pos + 1;
      seen += 1;
    }
    return true;
  });
  if (found === -1) throw new Error(`No ${typeName} #${index}`);
  return found;
}

export const paragraph = (text?: string): JSONContent =>
  text ? { type: 'paragraph', content: [{ type: 'text', text }] } : { type: 'paragraph' };
export const codeBlock = (text: string, language: string | null = null): JSONContent => ({
  type: 'codeBlock',
  attrs: { language },
  content: text ? [{ type: 'text', text }] : [],
});
