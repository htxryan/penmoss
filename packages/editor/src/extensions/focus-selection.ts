/**
 * Keys pressed just after the note takes focus keep their selection (issue #224, A1141).
 *
 * When the note gains focus, ProseMirror waits 20 ms and then, if the page's selection differs
 * from the last one its observer read, writes the editor's own selection back over it. That
 * puts the caret back where it was when focus arrived through code. But a key that moves the
 * selection inside those 20 ms (more under load, when the timer runs late) has changed the
 * page's selection before the browser reports it in `selectionchange`, so the write undoes it:
 * a quick Shift+→ after a click selected one character fewer.
 *
 * This plugin's focus handler runs just before ProseMirror's and does its work: it marks the
 * view focused (so ProseMirror's handler only notes the time and sets no timer of its own) and
 * sets the same 20 ms timer. When it fires, a selection the person has moved with a key since
 * the focus is read into the editor, as ProseMirror's observer would a moment later; with no
 * key, the editor's selection is restored to the page as before.
 */
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { readDOMSelection } from './line-symbols';

export const focusSelectionKey = new PluginKey('penmossFocusSelection');

/** ProseMirror's delay before it restores the selection on focus (prosemirror-view `focus`). */
export const FOCUS_RESTORE_DELAY_MS = 20;

interface Range {
  readonly anchorNode: Node | null;
  readonly anchorOffset: number;
  readonly focusNode: Node | null;
  readonly focusOffset: number;
}

/** The page's selection as ProseMirror reads it (its internal `domSelectionRange`). */
function rangeOf(view: EditorView): Range {
  const internals = view as unknown as { domSelectionRange?: () => Range };
  const range = internals.domSelectionRange?.() ?? view.dom.ownerDocument.getSelection();
  return {
    anchorNode: range?.anchorNode ?? null,
    anchorOffset: range?.anchorOffset ?? 0,
    focusNode: range?.focusNode ?? null,
    focusOffset: range?.focusOffset ?? 0,
  };
}

/** The parts of ProseMirror's view its own focus handler uses (prosemirror-view `focus`). */
interface ViewInternals {
  focused?: boolean;
  domObserver?: {
    stop(): void;
    start(): void;
    currentSelection: { eq(range: Range): boolean };
  };
}

export function focusSelectionPlugin(): Plugin {
  /** Set from the focus until the timer runs: whether a key came meanwhile. */
  let pending: { keyed: boolean } | null = null;
  return new Plugin({
    key: focusSelectionKey,
    props: {
      handleDOMEvents: {
        focus: (view) => {
          const internals = view as unknown as ViewInternals;
          const observer = internals.domObserver;
          // Only when ProseMirror would set its timer, and only while its shape is the known one.
          if (internals.focused || !observer || typeof internals.focused !== 'boolean') {
            return false;
          }
          observer.stop();
          view.dom.classList.add('ProseMirror-focused');
          observer.start();
          internals.focused = true;
          const watch = { keyed: false };
          pending = watch;
          setTimeout(() => {
            if (pending === watch) pending = null;
            if (view.isDestroyed || !view.hasFocus()) return;
            if (observer.currentSelection.eq(rangeOf(view))) return;
            if (watch.keyed) readDOMSelection(view);
            // The editor's selection back on the page; view.focus() writes it, focus is kept.
            else view.focus();
          }, FOCUS_RESTORE_DELAY_MS);
          // ProseMirror's handler still runs: it notes the time, and sees the view focused.
          return false;
        },
        keydown: () => {
          if (pending) pending.keyed = true;
          return false;
        },
      },
    },
  });
}

export const FocusSelection = Extension.create({
  name: 'focusSelection',
  addProseMirrorPlugins() {
    return [focusSelectionPlugin()];
  },
});
