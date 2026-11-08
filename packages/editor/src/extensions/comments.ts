/**
 * Comment threads in the editor (T48, A771): the passages and points threads are on, drawn as
 * decorations (nothing is written to the body, D31), the thread that is open in the Comments
 * panel picked out, and the anchor for a new thread made from the selection.
 *
 * The app hands in the threads to show (`showCommentThreads`, from the note's `comments` root)
 * and which is active. Each is placed from its anchor's Yjs relative positions, through the same
 * delta positions the server reads (`@penmoss/sync-client/comments`), so a quote an agent's
 * thread was made from lights up the same text here. Typing maps the decorations; a remote change
 * places them again from the anchors. Where the editor's mapping and the anchor in Yjs part
 * after typing next to a thread, the editor's wins and is written back: the binding diffs text,
 * so typing `big ` before `garden` can reuse garden's `g` for big's, and the anchor bound to it
 * would then start a word early on every other device. Moving a block (Yjs has no move: it is a
 * delete and a copy) re-anchors the threads in it the same way, so they move with their text
 * instead of being orphaned. After this editor's Undo or Redo, a thread whose text it brought
 * back is anchored on that text again (`reanchorAfterUndo`): only the undoing client can follow
 * the text Undo made again, so it writes the anchor every device then reads.
 *
 * Clicking a highlighted passage or a point's marker fires `COMMENT_OPEN_EVENT` on the editor's
 * element with the thread id; the selection toolbar's Comment button fires `COMMENT_ADD_EVENT`.
 * The app listens there (the element moves between note views, T31), and so does the phone's
 * editor page.
 *
 * Quotes skip line symbols (T44, A741): the symbols of a line are drawn in the margin, not read
 * as its text, so a thread on `★ Call the bank` quotes "Call the bank".
 */
import {
  anchorBetween,
  keptQuote,
  reanchorAfterUndo,
  resolveAnchor,
  setThreadAnchor,
  type CommentAnchor,
} from '@penmoss/sync-client/comments';
import { Extension, type Editor } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import type * as Y from '@y/y';
import {
  deltaPositionToResolvedPosition,
  resolvedPositionToDeltaPosition,
  ySyncPluginKey,
  yUndoPluginKey,
} from '@y/prosemirror';
import { isBindingTransaction } from '../collab/binding';
import { changedRanges } from './changes';
import { lineSymbolsOf, runAt } from './line-symbols';

/** Fired on the editor's element when a thread's passage or marker is clicked: `{ threadId }`. */
export const COMMENT_OPEN_EVENT = 'penmoss:comment-open';
/** Fired on the editor's element by the selection toolbar's Comment button. */
export const COMMENT_ADD_EVENT = 'penmoss:comment-add';
/** Set on a transaction that moves a block: `{ from, end, at }` (block-move.ts). */
export const BLOCK_MOVE_META = 'penmossBlockMove';

export interface BlockMoveMeta {
  /** The block's start and end before the move. */
  readonly from: number;
  readonly end: number;
  /** Its start after the move. */
  readonly at: number;
}

/** A thread as the editor shows it. */
export interface ShownThread {
  readonly id: string;
  readonly anchor: CommentAnchor | null;
}

interface Placed {
  readonly id: string;
  readonly from: number;
  /** Null for a point. */
  readonly to: number | null;
}

interface CommentsState {
  readonly threads: readonly ShownThread[];
  readonly active: string | null;
  readonly decorations: DecorationSet;
  /**
   * Threads a local change came next to (or a block move carried): once the change is in Yjs,
   * their anchors are checked against where the editor put them, and written where they part.
   */
  readonly check: readonly string[];
}

type Meta =
  | { readonly threads: readonly ShownThread[]; readonly active: string | null }
  | { readonly checked: true };

export const commentsKey = new PluginKey<CommentsState>('penmossComments');

/** The note's Yjs document the editor is bound to. */
export function boundDoc(state: EditorState): Y.Doc | null {
  const sync = ySyncPluginKey.getState(state) as
    { ytype?: { doc?: Y.Doc | null } | null } | undefined;
  return sync?.ytype?.doc ?? null;
}

/** Where each thread is in `doc` now (orphans are left out). */
function place(state: EditorState, doc: PMNode, threads: readonly ShownThread[]): Placed[] {
  const ydoc = boundDoc(state);
  if (!ydoc) return [];
  const placed: Placed[] = [];
  for (const thread of threads) {
    const resolved = resolveAnchor(ydoc, thread.anchor);
    if (resolved.orphaned) continue;
    const from = deltaPositionToResolvedPosition(doc, { path: [...resolved.from.path], assoc: 1 });
    if (!from) continue;
    if (!resolved.to) {
      placed.push({ id: thread.id, from: from.pos, to: null });
      continue;
    }
    const to = deltaPositionToResolvedPosition(doc, { path: [...resolved.to.path], assoc: -1 });
    if (to && to.pos > from.pos) placed.push({ id: thread.id, from: from.pos, to: to.pos });
  }
  return placed;
}

function marker(view: EditorView, id: string, active: boolean): HTMLElement {
  const element = view.dom.ownerDocument.createElement('span');
  element.className = active ? 'pm-comment-marker pm-comment-active' : 'pm-comment-marker';
  element.contentEditable = 'false';
  element.dataset['thread'] = id;
  element.setAttribute('role', 'button');
  // Reached with Tab and opened with Enter or Space, as a button is.
  element.tabIndex = 0;
  element.setAttribute('aria-label', 'Comment');
  element.title = 'Comment';
  return element;
}

function decorate(doc: PMNode, placed: readonly Placed[], active: string | null): DecorationSet {
  const decorations: Decoration[] = [];
  for (const thread of placed) {
    const isActive = thread.id === active;
    if (thread.to === null) {
      decorations.push(
        Decoration.widget(thread.from, (view) => marker(view, thread.id, isActive), {
          side: -1,
          ignoreSelection: true,
          key: `${thread.id}${isActive ? ':active' : ''}`,
          threadId: thread.id,
        }),
      );
    } else {
      decorations.push(
        Decoration.inline(
          thread.from,
          thread.to,
          {
            class: isActive ? 'pm-comment pm-comment-active' : 'pm-comment',
            'data-thread': thread.id,
          },
          { threadId: thread.id },
        ),
      );
    }
  }
  return DecorationSet.create(doc, decorations);
}

/** Where the decorations put each thread now. */
function placedOf(set: DecorationSet): Placed[] {
  const placed: Placed[] = [];
  for (const decoration of set.find()) {
    const spec = decoration.spec as { threadId?: string };
    if (!spec.threadId) continue;
    const point = decoration.from === decoration.to;
    placed.push({ id: spec.threadId, from: decoration.from, to: point ? null : decoration.to });
  }
  return placed;
}

function apply(tr: Transaction, previous: CommentsState, state: EditorState): CommentsState {
  const meta = tr.getMeta(commentsKey) as Meta | undefined;
  let { threads, active, decorations, check } = previous;
  if (meta && 'threads' in meta) {
    threads = meta.threads;
    active = meta.active;
    decorations = decorate(tr.doc, place(state, tr.doc, threads), active);
    return { threads, active, decorations, check };
  }
  if (meta && 'checked' in meta) check = [];
  if (!tr.docChanged) return { threads, active, decorations, check };
  if (isBindingTransaction(tr)) {
    // A remote change (or the note loading): placed again from the anchors, now in Yjs.
    decorations = decorate(tr.doc, place(state, tr.doc, threads), active);
    return { threads, active, decorations, check };
  }
  const move = tr.getMeta(BLOCK_MOVE_META) as BlockMoveMeta | undefined;
  if (move) {
    // The moved block's threads go where it went; the rest map as usual.
    const inside = (pos: number) => pos >= move.from && pos <= move.end;
    const shift = (pos: number) => pos - move.from + move.at;
    const carried = placedOf(decorations)
      .filter((each) => inside(each.from) && (each.to === null || inside(each.to)))
      .map((each) => ({
        id: each.id,
        from: shift(each.from),
        to: each.to === null ? null : shift(each.to),
      }));
    const ids = new Set(carried.map((each) => each.id));
    const rest = placedOf(decorations.map(tr.mapping, tr.doc)).filter((each) => !ids.has(each.id));
    decorations = decorate(tr.doc, [...rest, ...carried], active);
    return { threads, active, decorations, check: [...new Set([...check, ...ids])] };
  }
  decorations = decorations.map(tr.mapping, tr.doc);
  // Threads next to what changed: their anchors may have moved differently in Yjs.
  const near = new Set(check);
  for (const [from, to] of changedRanges([tr])) {
    for (const decoration of decorations.find(Math.max(0, from - 1), to + 1)) {
      const id = (decoration.spec as { threadId?: string }).threadId;
      if (id) near.add(id);
    }
  }
  return { threads, active, decorations, check: [...near] };
}

/**
 * Writes the anchor of each thread to check where Yjs has it somewhere other than the editor
 * shows it (after typing next to it, or a block move), once the change is in Yjs.
 */
function writeChecked(view: EditorView, earlier: Earlier): void {
  const state = commentsKey.getState(view.state);
  if (!state || state.check.length === 0) return;
  const ids = new Set(state.check);
  view.dispatch(
    view.state.tr
      .setMeta(commentsKey, { checked: true } satisfies Meta)
      .setMeta('addToHistory', false),
  );
  const ydoc = boundDoc(view.state);
  if (!ydoc) return;
  const { doc } = view.state;
  const shown = placedOf(state.decorations).filter((each) => ids.has(each.id));
  const inYjs = new Map(
    place(
      view.state,
      doc,
      state.threads.filter((thread) => ids.has(thread.id)),
    ).map((each) => [each.id, each]),
  );
  const wrong = shown.filter((each) => {
    const there = inYjs.get(each.id);
    return !there || there.from !== each.from || there.to !== each.to;
  });
  if (wrong.length === 0) return;
  const before = new Map(state.threads.map((thread) => [thread.id, thread.anchor]));
  ydoc.transact(() => {
    for (const each of wrong) {
      const anchor = anchorAt(ydoc, doc, each.from, each.to);
      if (!anchor) continue;
      remember(earlier, each.id, before.get(each.id) ?? null);
      setThreadAnchor(ydoc, each.id, anchor);
    }
  });
}

/** Anchors this editor replaced, per thread, newest last: what an Undo may bring back. */
type Earlier = Map<string, CommentAnchor[]>;

/** As many replaced anchors as a thread keeps: enough for a few moves to undo. */
const EARLIER_KEPT = 8;

function remember(earlier: Earlier, id: string, anchor: CommentAnchor | null): void {
  if (!anchor) return;
  const list = earlier.get(id) ?? [];
  list.push(anchor);
  earlier.set(id, list.slice(-EARLIER_KEPT));
}

/** The anchor for editor positions: a range, or a point when `to` is null. */
function anchorAt(ydoc: Y.Doc, doc: PMNode, from: number, to: number | null): CommentAnchor | null {
  const start = resolvedPositionToDeltaPosition(doc.resolve(from));
  const end = to === null ? null : resolvedPositionToDeltaPosition(doc.resolve(to));
  return anchorBetween(
    ydoc,
    { path: start.path as number[], assoc: 1 },
    end ? { path: end.path as number[], assoc: -1 } : null,
  );
}

/** Where a line's text starts, past its symbols (T44), when `pos` is in them or at its start. */
function pastSymbols(state: EditorState, pos: number): number {
  const $pos = state.doc.resolve(pos);
  if (!$pos.parent.isTextblock) return pos;
  const run = runAt($pos, lineSymbolsOf(state));
  if (!run) return pos;
  const textStart = $pos.start() + run.end;
  return pos < textStart ? textStart : pos;
}

/** The visible text between two positions: blocks on their own lines, each without its symbols. */
export function visibleText(state: EditorState, from: number, to: number): string {
  const lines: string[] = [];
  const symbols = lineSymbolsOf(state);
  state.doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isTextblock) return true;
    const start = pos + 1;
    const run = runAt(state.doc.resolve(start), symbols);
    const textFrom = Math.max(from, start + (run?.end ?? 0));
    const textTo = Math.min(to, pos + node.nodeSize - 1);
    lines.push(textTo > textFrom ? state.doc.textBetween(textFrom, textTo, '\n', ' ') : '');
    return false;
  });
  return lines.join('\n');
}

/** The longest line kept as a point's quote: enough for an agent to know where it is. */
const POINT_QUOTE_CHARS = 280;

/** A new thread's anchor and quote, from the selection (A771). */
export interface SelectionAnchor {
  readonly anchor: CommentAnchor;
  readonly quote: string;
  readonly kind: 'range' | 'point';
}

/**
 * The anchor for a thread on the selection: a range over the selected text, or a point at the
 * caret, which quotes the line it is in. Null when the editor is not bound to a note.
 */
export function selectionAnchor(state: EditorState): SelectionAnchor | null {
  const ydoc = boundDoc(state);
  if (!ydoc) return null;
  const { selection, doc } = state;
  const from = pastSymbols(state, selection.from);
  const to = Math.max(from, selection.to);
  const text = visibleText(state, from, to);
  if (!selection.empty && text.trim().length > 0) {
    const anchor = anchorAt(ydoc, doc, from, to);
    return anchor ? { anchor, quote: keptQuote(text), kind: 'range' } : null;
  }
  const at = pastSymbols(state, selection.head);
  const anchor = anchorAt(ydoc, doc, at, null);
  if (!anchor) return null;
  const $at = doc.resolve(at);
  const line = $at.parent.isTextblock ? visibleText(state, $at.start(), $at.end()) : '';
  const quote =
    line.length > POINT_QUOTE_CHARS ? `${line.slice(0, POINT_QUOTE_CHARS - 1).trimEnd()}…` : line;
  return { anchor, quote, kind: 'point' };
}

/** Shows `threads` (the open ones, or what the panel's filter shows) and picks out `active`. */
export function showCommentThreads(
  editor: Editor,
  threads: readonly ShownThread[],
  active: string | null,
): void {
  if (editor.isDestroyed) return;
  const { view } = editor;
  view.dispatch(
    view.state.tr
      .setMeta(commentsKey, { threads, active } satisfies Meta)
      .setMeta('addToHistory', false),
  );
}

/** Where a thread is shown now, in editor positions (null when it is not shown). */
export function threadRange(
  state: EditorState,
  id: string,
): { readonly from: number; readonly to: number } | null {
  const found = placedOf(commentsKey.getState(state)?.decorations ?? DecorationSet.empty).find(
    (each) => each.id === id,
  );
  return found ? { from: found.from, to: found.to ?? found.from } : null;
}

/**
 * Where an anchor is in the editor now, in editor positions (`to` equals `from` for a point):
 * a new thread's selection, which no decoration marks yet (T52 item 5). Null when it is not in
 * the note.
 */
export function anchorRange(
  state: EditorState,
  anchor: CommentAnchor,
): { readonly from: number; readonly to: number } | null {
  const [found] = place(state, state.doc, [{ id: '', anchor }]);
  return found ? { from: found.from, to: found.to ?? found.from } : null;
}

/**
 * A new thread's passage while its floating composer is open (T52): marked as a thread's is, but
 * lighter, since the selection itself is no longer drawn once the composer has focus. Placed from
 * its anchor after every change, as the composer is.
 */
interface PendingState {
  readonly anchor: CommentAnchor | null;
  readonly decorations: DecorationSet;
}

export const pendingCommentKey = new PluginKey<PendingState>('penmossPendingComment');

function pendingDecorations(state: EditorState, anchor: CommentAnchor | null): DecorationSet {
  if (!anchor) return DecorationSet.empty;
  const [found] = place(state, state.doc, [{ id: '', anchor }]);
  if (!found) return DecorationSet.empty;
  const decoration =
    found.to === null
      ? Decoration.widget(
          found.from,
          (view) => {
            const element = view.dom.ownerDocument.createElement('span');
            element.className = 'pm-comment-marker pm-comment-pending';
            element.contentEditable = 'false';
            element.setAttribute('aria-hidden', 'true');
            return element;
          },
          { side: -1, ignoreSelection: true, key: 'pending-comment' },
        )
      : Decoration.inline(found.from, found.to, { class: 'pm-comment-pending' });
  return DecorationSet.create(state.doc, [decoration]);
}

/** Marks `anchor` as the passage a new thread is being written on; null removes the mark. */
export function showPendingComment(editor: Editor, anchor: CommentAnchor | null): void {
  if (editor.isDestroyed) return;
  const { view } = editor;
  if ((pendingCommentKey.getState(view.state)?.anchor ?? null) === anchor) return;
  view.dispatch(
    view.state.tr.setMeta(pendingCommentKey, { anchor }).setMeta('addToHistory', false),
  );
}

/** A passage's box on screen, in viewport pixels: from its start's line to its end's. */
export interface RangeRect {
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
}

/**
 * The box of the text between two editor positions (a point's caret box when they are equal),
 * where the floating comment goes (T52 item 5). Null when the view cannot measure (not laid out).
 */
export function rangeRect(view: EditorView, from: number, to: number): RangeRect | null {
  try {
    const start = view.coordsAtPos(from, 1);
    const end = to > from ? view.coordsAtPos(to, -1) : start;
    // On one line: from its start to its end; over several, the first line's start.
    const oneLine = end.top < start.bottom;
    return {
      top: Math.min(start.top, end.top),
      bottom: Math.max(start.bottom, end.bottom),
      left: start.left,
      right: oneLine ? Math.max(end.right, start.left) : start.left,
    };
  } catch {
    return null;
  }
}

/** Scrolls a thread's passage into view (the panel's "show in note"). */
export function revealThread(editor: Editor, id: string): boolean {
  const range = threadRange(editor.state, id);
  if (!range || editor.isDestroyed) return false;
  const dom = editor.view.domAtPos(range.from);
  const node = dom.node instanceof Element ? dom.node : dom.node.parentElement;
  node?.scrollIntoView?.({ block: 'center' });
  return true;
}

export interface CommentsStorage {
  /** Whether the app handles comments (the toolbar's Comment button shows then). */
  enabled: boolean;
}

export interface CommentsOptions {
  readonly enabled: boolean;
}

/** Whether comments are on in this editor (the toolbar asks). */
export const commentsEnabled = (editor: Editor): boolean =>
  (editor.storage as unknown as { comments?: CommentsStorage }).comments?.enabled === true;

export const Comments = Extension.create<CommentsOptions, CommentsStorage>({
  name: 'comments',

  addOptions() {
    return { enabled: false };
  },

  addStorage() {
    return { enabled: this.options.enabled };
  },

  addProseMirrorPlugins() {
    return [
      new Plugin<CommentsState>({
        key: commentsKey,
        state: {
          init: () => ({ threads: [], active: null, decorations: DecorationSet.empty, check: [] }),
          apply: (tr, previous, _old, state) => apply(tr, previous, state),
        },
        props: {
          decorations: (state) => commentsKey.getState(state)?.decorations,
          handleDOMEvents: {
            click: (view, event) => {
              const hit = threadAt(view, event.target);
              if (hit) openThread(view, hit);
              return false;
            },
            keydown: (view, event) => {
              // A point's marker has focus: Enter or Space opens its thread.
              if (event.key !== 'Enter' && event.key !== ' ') return false;
              const target = event.target instanceof HTMLElement ? event.target : null;
              if (!target?.classList.contains('pm-comment-marker')) return false;
              const hit = threadAt(view, target);
              if (!hit) return false;
              event.preventDefault();
              openThread(view, hit);
              return true;
            },
          },
        },
        view: (initial) => {
          let scheduled = false;
          const earlier: Earlier = new Map();
          type Undo = NonNullable<ReturnType<typeof yUndoPluginKey.getState>>['undoManager'];
          let undo: Undo | null = null;
          const onPopped = () => {
            const ydoc = boundDoc(initial.state);
            if (initial.isDestroyed || !ydoc) return;
            for (const each of reanchorAfterUndo(ydoc, earlier)) {
              remember(earlier, each.id, each.previous);
            }
          };
          const watch = (view: EditorView) => {
            const current = yUndoPluginKey.getState(view.state)?.undoManager ?? null;
            if (current === undo) return;
            undo?.off('stack-item-popped', onPopped);
            undo = current;
            undo?.on('stack-item-popped', onPopped);
          };
          watch(initial);
          return {
            update: (view) => {
              watch(view);
              if ((commentsKey.getState(view.state)?.check.length ?? 0) > 0 && !scheduled) {
                // After this dispatch's Yjs write (the binding's view update ran first).
                scheduled = true;
                queueMicrotask(() => {
                  scheduled = false;
                  if (!view.isDestroyed) writeChecked(view, earlier);
                });
              }
            },
            destroy: () => {
              undo?.off('stack-item-popped', onPopped);
              undo = null;
            },
          };
        },
      }),
      new Plugin<PendingState>({
        key: pendingCommentKey,
        state: {
          init: () => ({ anchor: null, decorations: DecorationSet.empty }),
          apply: (tr, previous, _old, state) => {
            const meta = tr.getMeta(pendingCommentKey) as
              { readonly anchor: CommentAnchor | null } | undefined;
            if (meta)
              return { anchor: meta.anchor, decorations: pendingDecorations(state, meta.anchor) };
            if (!tr.docChanged || !previous.anchor) return previous;
            // As the threads' marks: a remote change is placed again from the anchor, now in
            // Yjs; a local one maps, since Yjs has not taken it yet.
            return {
              anchor: previous.anchor,
              decorations: isBindingTransaction(tr)
                ? pendingDecorations(state, previous.anchor)
                : previous.decorations.map(tr.mapping, tr.doc),
            };
          },
        },
        props: {
          decorations: (state) => pendingCommentKey.getState(state)?.decorations,
        },
      }),
    ];
  },
});

function threadAt(view: EditorView, target: EventTarget | null): HTMLElement | null {
  const element = target instanceof Element ? target : null;
  const hit = element?.closest<HTMLElement>('[data-thread]');
  return hit && view.dom.contains(hit) ? hit : null;
}

function openThread(view: EditorView, hit: HTMLElement): void {
  view.dom.dispatchEvent(
    new CustomEvent(COMMENT_OPEN_EVENT, {
      bubbles: true,
      detail: { threadId: hit.dataset['thread'] },
    }),
  );
}

/** Asks the app to start a thread on the selection (the toolbar's Comment button). */
export function requestComment(editor: Editor): void {
  editor.view.dom.dispatchEvent(new CustomEvent(COMMENT_ADD_EVENT, { bubbles: true }));
}
