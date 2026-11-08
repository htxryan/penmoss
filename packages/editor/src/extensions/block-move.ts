/**
 * Moving top-level blocks (T14): by dragging a block's handle (drag-handle.ts)
 * or with Alt-Shift-ArrowUp/ArrowDown.
 *
 * Yjs has no move, so a move is one transaction that deletes the block and
 * inserts it at the target: one Yjs transaction, and one undo step (the undo
 * manager's capture window is closed on both sides of it). During a drag the
 * plugin state below holds the dragged block's position, mapped through every
 * transaction, local or remote. The drop moves whatever the block holds then,
 * so a peer's edit to it mid-drag moves with it; if a peer deleted the block,
 * the drag is cancelled and nothing is inserted. No move runs while a peer's
 * update is waiting for content it builds on (`hasPendingUpdates`).
 */
import type { Node as PMNode } from '@tiptap/pm/model';
import {
  NodeSelection,
  Plugin,
  PluginKey,
  TextSelection,
  type Command,
  type EditorState,
  type Transaction,
} from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import { ySyncPluginKey, yUndoPluginKey } from '@y/prosemirror';
import { BLOCK_MOVE_META, type BlockMoveMeta } from './comments';

export interface TopLevelBlock {
  readonly pos: number;
  readonly node: PMNode;
}

export function topLevelBlocks(doc: PMNode): TopLevelBlock[] {
  const blocks: TopLevelBlock[] = [];
  doc.forEach((node, pos) => blocks.push({ pos, node }));
  return blocks;
}

/** Whether `pos` is a boundary between top-level blocks (or the start or end of the note). */
function isTopLevelBoundary(doc: PMNode, pos: number): boolean {
  if (pos < 0 || pos > doc.content.size) return false;
  return doc.resolve(pos).depth === 0;
}

/** Start of the top-level block holding the selection (a selected top-level node counts). */
export function selectedTopLevelBlock(state: EditorState): number | null {
  const { selection } = state;
  if (selection instanceof NodeSelection && selection.$from.depth === 0) return selection.from;
  const { $from } = selection;
  return $from.depth === 0 ? null : $from.before(1);
}

/**
 * Moves the top-level block starting at `from` to the boundary `to` (both
 * positions in the current document): a delete and an insert in one
 * transaction. A selection inside the block moves with it. Null when either
 * position is not a top-level boundary or the block would not move.
 */
export function moveBlockTransaction(
  state: EditorState,
  from: number,
  to: number,
): Transaction | null {
  const { doc } = state;
  if (!isTopLevelBoundary(doc, from) || !isTopLevelBoundary(doc, to)) return null;
  const node = doc.nodeAt(from);
  if (!node) return null;
  const end = from + node.nodeSize;
  if (to === from || to === end) return null;

  const tr = state.tr.delete(from, end);
  const at = tr.mapping.map(to);
  tr.insert(at, node);
  // Comment threads in the block go with it (T48): Yjs sees a delete and a copy.
  tr.setMeta(BLOCK_MOVE_META, { from, end, at } satisfies BlockMoveMeta);

  const { selection } = state;
  const inside = (pos: number) => pos >= from && pos <= end;
  const shift = at - from;
  if (selection instanceof NodeSelection && selection.from >= from && selection.to <= end) {
    // The block itself, or a node in it (an image, a formula), stays selected.
    tr.setSelection(NodeSelection.create(tr.doc, selection.from + shift));
  } else if (inside(selection.anchor) && inside(selection.head)) {
    const moved = TextSelection.between(
      tr.doc.resolve(selection.anchor + shift),
      tr.doc.resolve(selection.head + shift),
    );
    tr.setSelection(moved);
  }
  return tr.scrollIntoView();
}

/**
 * Dispatches a move as its own undo step: the Yjs undo manager merges changes
 * made within its capture window (500 ms), so typing just before or after a
 * move would otherwise be undone together with it.
 */
export function dispatchMove(view: EditorView, tr: Transaction): void {
  const undo = yUndoPluginKey.getState(view.state)?.undoManager;
  undo?.stopCapturing();
  view.dispatch(tr);
  undo?.stopCapturing();
}

/**
 * This editor's newest undo step, or null: what a later Undo would undo. The
 * Android app's Undo after Delete block undoes the delete only while it is
 * still this step (T40 P8 re-review), never typing made since.
 */
export function latestUndoStep(state: EditorState): object | null {
  return yUndoPluginKey.getState(state)?.undoManager.undoStack.at(-1) ?? null;
}

/**
 * Whether the replica holds a peer's update it cannot integrate yet (its
 * structs or deletions build on content not received). A move deletes the
 * block and inserts a copy, so content that later integrates into the
 * original would land in the deleted block: moves wait until it is complete.
 */
export function hasPendingUpdates(state: EditorState): boolean {
  const sync = ySyncPluginKey.getState(state) as
    | { ytype?: { doc?: { store: { pendingStructs: unknown; pendingDs: unknown } } | null } | null }
    | undefined;
  const store = sync?.ytype?.doc?.store;
  return store != null && (store.pendingStructs != null || store.pendingDs != null);
}

/**
 * Moves the top-level block holding the selection up (-1) or down (1) past
 * its neighbour. False when nothing would move (first or last block, or a
 * peer update is pending), so the key keeps its usual meaning there
 * (Alt-Shift-ArrowUp extends the selection on macOS).
 */
export function moveSelectedBlock(dir: -1 | 1): Command {
  return (state, dispatch, view) => {
    const from = selectedTopLevelBlock(state);
    if (from === null || hasPendingUpdates(state)) return false;
    const $from = state.doc.resolve(from);
    const index = $from.index(0);
    const neighbour = state.doc.maybeChild(index + dir);
    if (!neighbour) return false;
    const node = state.doc.child(index);
    const to = dir < 0 ? from - neighbour.nodeSize : from + node.nodeSize + neighbour.nodeSize;
    const tr = moveBlockTransaction(state, from, to);
    if (!tr) return false;
    if (!dispatch) return true;
    if (view) dispatchMove(view, tr);
    else dispatch(tr);
    return true;
  };
}

/**
 * Duplicates the top-level block holding the selection (T40 P8, ED5): a copy
 * goes right after it, as its own undo step, and the caret moves into the copy
 * at the same place (a selected node stays selected). False when no block
 * holds the selection or a peer update is pending (as for a move).
 */
export function duplicateSelectedBlock(): Command {
  return (state, dispatch, view) => {
    const from = selectedTopLevelBlock(state);
    if (from === null || hasPendingUpdates(state)) return false;
    const node = state.doc.nodeAt(from);
    if (!node) return false;
    if (!dispatch) return true;
    const end = from + node.nodeSize;
    const tr = state.tr.insert(end, node.copy(node.content));
    const shift = end - from;
    const { selection } = state;
    if (selection instanceof NodeSelection) {
      tr.setSelection(NodeSelection.create(tr.doc, selection.from + shift));
    } else {
      tr.setSelection(
        TextSelection.between(
          tr.doc.resolve(selection.anchor + shift),
          tr.doc.resolve(selection.head + shift),
        ),
      );
    }
    tr.scrollIntoView();
    if (view) dispatchMove(view, tr);
    else dispatch(tr);
    return true;
  };
}

/**
 * Deletes the top-level block holding the selection (T40 P8, ED5), as its own
 * undo step; the caret goes to the start of the block that takes its place,
 * or to the end of the block before when it was the note's last. The last
 * block left is replaced by an empty
 * paragraph, so the note always has somewhere to type.
 */
export function deleteSelectedBlock(): Command {
  return (state, dispatch, view) => {
    const from = selectedTopLevelBlock(state);
    if (from === null || hasPendingUpdates(state)) return false;
    const node = state.doc.nodeAt(from);
    if (!node) return false;
    if (!dispatch) return true;
    const end = from + node.nodeSize;
    const tr = state.tr;
    if (state.doc.childCount === 1) {
      tr.replaceWith(from, end, state.schema.nodes['paragraph']!.create());
    } else {
      tr.delete(from, end);
    }
    const at = Math.min(from, tr.doc.content.size);
    tr.setSelection(TextSelection.near(tr.doc.resolve(at), at >= tr.doc.content.size ? -1 : 1));
    tr.scrollIntoView();
    if (view) dispatchMove(view, tr);
    else dispatch(tr);
    return true;
  };
}

/** The block being dragged: its start position, mapped through every transaction since. */
export type BlockDrag = { readonly from: number } | null;

export const blockDragKey = new PluginKey<BlockDrag>('penmossBlockDrag');

type DragMeta = { readonly start: number } | { readonly end: true };

/** Maps the drag through changes; a deleted (or merged-away) block ends it. */
function mapDrag(tr: Transaction, drag: BlockDrag): BlockDrag {
  const meta = tr.getMeta(blockDragKey) as DragMeta | undefined;
  if (meta) return 'start' in meta ? { from: meta.start } : null;
  if (!drag || !tr.docChanged) return drag;
  const mapped = tr.mapping.mapResult(drag.from, 1);
  if (mapped.deletedAfter) return null;
  const node = tr.doc.nodeAt(mapped.pos);
  return node && isTopLevelBoundary(tr.doc, mapped.pos) ? { from: mapped.pos } : null;
}

export function startBlockDrag(view: EditorView, from: number): boolean {
  if (!isTopLevelBoundary(view.state.doc, from) || !view.state.doc.nodeAt(from)) return false;
  view.dispatch(view.state.tr.setMeta(blockDragKey, { start: from } satisfies DragMeta));
  return true;
}

export function cancelBlockDrag(view: EditorView): void {
  if (blockDragKey.getState(view.state)) {
    view.dispatch(view.state.tr.setMeta(blockDragKey, { end: true } satisfies DragMeta));
  }
}

/**
 * Ends the drag by moving the dragged block to the boundary `to` of the
 * current document. False (and nothing changes) when the block is gone or
 * would not move.
 */
export function dropBlock(view: EditorView, to: number): boolean {
  const drag = blockDragKey.getState(view.state);
  if (!drag) return false;
  const tr = hasPendingUpdates(view.state) ? null : moveBlockTransaction(view.state, drag.from, to);
  if (!tr) {
    cancelBlockDrag(view);
    return false;
  }
  tr.setMeta(blockDragKey, { end: true } satisfies DragMeta);
  dispatchMove(view, tr);
  return true;
}

/** The plugin holding the drag, which also dims the dragged block. */
export const blockDragPlugin = new Plugin<BlockDrag>({
  key: blockDragKey,
  state: {
    init: () => null,
    apply: (tr, drag) => mapDrag(tr, drag),
  },
  props: {
    decorations(state) {
      const drag = blockDragKey.getState(state);
      const node = drag && state.doc.nodeAt(drag.from);
      if (!drag || !node) return DecorationSet.empty;
      return DecorationSet.create(state.doc, [
        Decoration.node(drag.from, drag.from + node.nodeSize, { class: 'pm-block-dragging' }),
      ]);
    },
  },
});
