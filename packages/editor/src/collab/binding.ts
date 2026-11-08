import type { Transaction } from '@tiptap/pm/state';
import { ySyncPluginKey } from '@y/prosemirror';

/** Whether `tr` is the Yjs binding rendering the document (a remote change, or the initial load). */
export const isBindingTransaction = (tr: Transaction): boolean =>
  tr.getMeta('y-sync-transaction') != null ||
  tr.getMeta('y-sync-append') != null ||
  tr.getMeta(ySyncPluginKey) != null;
