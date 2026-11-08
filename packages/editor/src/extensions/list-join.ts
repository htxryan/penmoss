/**
 * Lists of one kind that end up side by side become one list again (T64 item 7). Backspace at
 * the start of a numbered item takes its number away, leaving a line between two lists; a
 * second Backspace joins that line to the item above, and before this the items below stayed
 * a list of their own that nothing could join back (markdown cannot write two such lists side
 * by side either: it reads them as one). Only after an edit made here that took something out,
 * and only around it: a remote edit is the other device's to make, and an insertion (Duplicate)
 * keeps its lists apart.
 */
import { Extension } from '@tiptap/core';
import type { Node as ProseNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, type Transaction } from '@tiptap/pm/state';
import { canJoin } from '@tiptap/pm/transform';
import { isBindingTransaction } from '../collab/binding';

const LISTS = new Set(['orderedList', 'bulletList', 'taskList']);

export const listJoinKey = new PluginKey('penmossListJoin');

/** The positions between two lists of one kind next to each other, at or around `pos`. */
function joinsAround(doc: ProseNode, pos: number, found: Set<number>): void {
  const $pos = doc.resolve(Math.min(pos, doc.content.size));
  for (let depth = $pos.depth; depth >= 0; depth--) {
    const parent = $pos.node(depth);
    const index = $pos.index(depth);
    const start = $pos.start(depth);
    for (let i = Math.max(1, index - 1); i <= Math.min(parent.childCount - 1, index + 1); i++) {
      const before = parent.child(i - 1);
      const after = parent.child(i);
      if (before.type !== after.type || !LISTS.has(after.type.name)) continue;
      let at = start;
      for (let j = 0; j < i; j++) at += parent.child(j).nodeSize;
      found.add(at);
    }
  }
}

export function joinAdjacentLists(transactions: readonly Transaction[], doc: ProseNode) {
  const found = new Set<number>();
  for (const tr of transactions) {
    if (!tr.docChanged || isBindingTransaction(tr)) continue;
    tr.mapping.maps.forEach((map, index) => {
      map.forEach((oldStart, oldEnd, newStart, newEnd) => {
        // Only where something was taken out (Backspace, Delete, a cut): an insertion, such as
        // Duplicate putting a list's copy beside it, leaves lists as they are.
        if (oldEnd <= oldStart) return;
        // Where this step's change sits in the document as it is now.
        const rest = tr.mapping.slice(index + 1);
        for (const pos of [rest.map(newStart, -1), rest.map(newEnd, 1)]) {
          joinsAround(doc, pos, found);
        }
      });
    });
  }
  return [...found].sort((a, b) => b - a);
}

export const ListJoin = Extension.create({
  name: 'listJoin',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: listJoinKey,
        appendTransaction(transactions, _old, state) {
          const joins = joinAdjacentLists(transactions, state.doc);
          if (joins.length === 0) return null;
          const tr = state.tr;
          // Last first, so earlier positions still hold.
          for (const pos of joins) if (canJoin(tr.doc, pos)) tr.join(pos);
          return tr.docChanged ? tr : null;
        },
      }),
    ];
  },
});
