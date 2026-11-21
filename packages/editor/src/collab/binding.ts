import type { Transaction } from '@tiptap/pm/state';
import { ySyncPluginKey } from '@y/prosemirror';

/** Whether `tr` is the Yjs binding rendering the document (a remote change, or the initial load). */
export const isBindingTransaction = (tr: Transaction): boolean =>
  tr.getMeta('y-sync-transaction') != null ||
  tr.getMeta('y-sync-append') != null ||
  tr.getMeta(ySyncPluginKey) != null;

/** How deep this editor's own Undo or Redo is: the binding renders it, but it is the person's. */
let undoing = 0;

/** Runs this editor's Undo or Redo: what the binding renders meanwhile is this editor's own. */
export function asOwnChange<T>(run: () => T): T {
  undoing += 1;
  try {
    return run();
  } finally {
    undoing -= 1;
  }
}

/**
 * Whether `tr` came from elsewhere (sync, an agent, another window), for session detail
 * (PEN-177): the binding rendered it, and not as this editor's own Undo or Redo.
 */
export const isRemoteTransaction = (tr: Transaction): boolean =>
  undoing === 0 && isBindingTransaction(tr);
