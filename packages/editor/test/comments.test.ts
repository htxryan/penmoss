/**
 * Comment threads in the editor (T48, A771): anchors made from the selection, the passages and
 * points drawn from them through typing, remote edits and block moves, and the same text lit
 * up for a thread the server anchored from a quote.
 */
import { NOTE_ROOT } from '@penmoss/sync-client';
import {
  anchorForQuote,
  createThread,
  readThreads,
  resolveAnchor,
  anchoredText,
  type CommentAnchor,
} from '@penmoss/sync-client/comments';
import { createYjs14Replica } from '@penmoss/sync-client/yjs14';
import * as Y from '@y/y';
import { yUndoPluginKey } from '@y/prosemirror';
import { describe, expect, it } from 'vitest';
import {
  anchorRange,
  COMMENT_ADD_EVENT,
  COMMENT_OPEN_EVENT,
  selectionAnchor,
  showCommentThreads,
  showPendingComment,
} from '../src/extensions/comments';
import { dispatchMove, moveBlockTransaction, topLevelBlocks } from '../src/extensions/block-move';
import { openEditor, paragraph, select, type } from './support/editor';

type Collab = ReturnType<typeof openEditor>;

const ME = { id: 'device:test', kind: 'device', label: 'MacBook' } as const;

const highlighted = (collab: Collab) =>
  [...collab.editor.view.dom.querySelectorAll<HTMLElement>('.pm-comment')].map(
    (element) => element.textContent,
  );

/** The PM position of the first occurrence of `text`. */
function posOf(collab: Collab, text: string): number {
  let found = -1;
  collab.editor.state.doc.descendants((node, pos) => {
    if (found >= 0) return false;
    if (node.isText) {
      const at = node.text!.indexOf(text);
      if (at >= 0) found = pos + at;
    }
    return true;
  });
  if (found < 0) throw new Error(`no "${text}"`);
  return found;
}

/** Starts a thread in the note's document, as the app does. */
function start(collab: Collab, id: string, anchor: CommentAnchor, quote: string) {
  createThread(collab.replica.doc, {
    id,
    anchor,
    quote,
    author: ME,
    at: Date.now(),
    comment: { id: `${id}c`, body: 'make this tighter' },
  });
}

/** Shows every thread in the note (the app's job, on each change to the comments). */
function showAll(collab: Collab, active: string | null = null) {
  showCommentThreads(
    collab.editor,
    readThreads(collab.replica.doc).map((thread) => ({ id: thread.id, anchor: thread.anchor })),
    active,
  );
}

function commentOnText(collab: Collab, text: string, id = 't1') {
  const from = posOf(collab, text);
  select(collab.editor.view, from, from + text.length);
  const made = selectionAnchor(collab.editor.state)!;
  expect(made).toMatchObject({ kind: 'range', quote: text });
  start(collab, id, made.anchor, made.quote);
  showAll(collab);
  return made;
}

describe('comment anchors in the editor (A771)', () => {
  it('lights up the selected passage, and keeps it through typing around and inside it', async () => {
    const collab = openEditor([paragraph('The garden plan needs work.'), paragraph('Second.')], {
      comments: true,
    });
    commentOnText(collab, 'garden plan');
    expect(highlighted(collab)).toEqual(['garden plan']);
    const { view } = collab.editor;
    // Typed just before and just after: outside the passage.
    select(view, posOf(collab, 'garden plan'));
    type(view, 'big ');
    select(view, posOf(collab, ' needs'));
    type(view, '!');
    expect(highlighted(collab)).toEqual(['garden plan']);
    // Typed inside: part of it.
    select(view, posOf(collab, ' plan'));
    type(view, 'en');
    expect(highlighted(collab)).toEqual(['gardenen plan']);
    // In Yjs too, once the editor wrote back what the binding's text diff moved: typing `big `
    // before `garden` reuses garden's `g`, which the anchor was bound to.
    await Promise.resolve();
    const [thread] = readThreads(collab.replica.doc);
    expect(
      anchoredText(collab.replica.doc, resolveAnchor(collab.replica.doc, thread!.anchor)),
    ).toBe('gardenen plan');
  });

  it('follows a remote agent edit, and orphans the thread when its text is deleted', () => {
    const collab = openEditor([paragraph('The garden plan needs work.')], { comments: true });
    commentOnText(collab, 'needs work');
    const remote = createYjs14Replica();
    remote.applyUpdate(collab.replica.encodeStateAsUpdate());
    const before = remote.encodeStateVector();
    (remote.doc.get(NOTE_ROOT).get(0) as Y.Node).insert(0, 'Agent wrote this. ');
    collab.replica.applyUpdate(Y.encodeStateAsUpdate(remote.doc, before), 'server');
    expect(collab.editor.state.doc.textContent).toBe(
      'Agent wrote this. The garden plan needs work.',
    );
    expect(highlighted(collab)).toEqual(['needs work']);

    const from = posOf(collab, 'needs work');
    collab.editor.view.dispatch(collab.editor.state.tr.delete(from, from + 'needs work'.length));
    showAll(collab);
    expect(highlighted(collab)).toEqual([]);
    const [thread] = readThreads(collab.replica.doc);
    expect(resolveAnchor(collab.replica.doc, thread!.anchor).orphaned).toBe(true);
    // The quote stays with it.
    expect(thread!.quote).toBe('needs work');
  });

  it('lights up the text a thread made on the server from a quote is on', () => {
    const collab = openEditor(
      [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Plans' }] },
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [
                {
                  type: 'paragraph',
                  content: [
                    { type: 'text', text: 'Plant ' },
                    { type: 'text', marks: [{ type: 'bold' }], text: 'tomatoes' },
                    { type: 'text', text: ' in May' },
                  ],
                },
              ],
            },
            { type: 'listItem', content: [paragraph('Water the tomatoes daily')] },
          ],
        },
      ],
      { comments: true },
    );
    // The server's copy, as the NoteDoc anchors an agent's quote (A775).
    const server = createYjs14Replica();
    server.applyUpdate(collab.replica.encodeStateAsUpdate());
    const match = anchorForQuote(server.doc, 'tomatoes', 2);
    if ('error' in match) throw new Error(match.error);
    const before = server.encodeStateVector();
    createThread(server.doc, {
      id: 'agent1',
      anchor: match.anchor,
      quote: match.quote,
      author: { id: 'agent:x', kind: 'agent', label: 'Claude Code' },
      at: 1,
      comment: { id: 'agent1c', body: 'Daily is too often.' },
    });
    collab.replica.applyUpdate(Y.encodeStateAsUpdate(server.doc, before), 'server');
    showAll(collab, 'agent1');
    const shown = [...collab.editor.view.dom.querySelectorAll<HTMLElement>('.pm-comment')];
    expect(shown.map((element) => element.textContent)).toEqual(['tomatoes']);
    expect(shown[0]!.closest('li')!.textContent).toBe('Water the tomatoes daily');
    expect(shown[0]!.classList.contains('pm-comment-active')).toBe(true);

    // And the other way: an anchor made here reads the same on the server.
    const from = posOf(collab, 'in May');
    select(collab.editor.view, from, from + 'in May'.length);
    const made = selectionAnchor(collab.editor.state)!;
    expect(anchoredText(server.doc, resolveAnchor(server.doc, made.anchor))).toBe('in May');
  });

  it('quotes a line without its symbols (T44)', () => {
    const collab = openEditor([paragraph('★ Call the bank'), paragraph('? Ask about fees')], {
      comments: true,
    });
    const { view } = collab.editor;
    // The whole of both lines, symbols included.
    select(view, 1, view.state.doc.content.size - 1);
    const made = selectionAnchor(view.state)!;
    expect(made.quote).toBe('Call the bank\nAsk about fees');
    start(collab, 't1', made.anchor, made.quote);
    showAll(collab);
    // From the first line's text, not its symbol.
    expect(highlighted(collab)[0]).toBe('Call the bank');
  });

  it('makes a point at the caret, quoting its line, with a marker that opens the thread', () => {
    const collab = openEditor([paragraph('First line'), paragraph('Second line')], {
      comments: true,
    });
    const { view } = collab.editor;
    select(view, posOf(collab, 'line'));
    const made = selectionAnchor(view.state)!;
    expect(made).toMatchObject({ kind: 'point', quote: 'First line' });
    expect(made.anchor.to).toBeNull();
    start(collab, 'p1', made.anchor, made.quote);
    showAll(collab);
    const markers = [...view.dom.querySelectorAll<HTMLElement>('.pm-comment-marker')];
    expect(markers.map((marker) => marker.dataset['thread'])).toEqual(['p1']);
    const opened: unknown[] = [];
    view.dom.addEventListener(COMMENT_OPEN_EVENT, (event) =>
      opened.push((event as CustomEvent).detail),
    );
    markers[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(opened).toEqual([{ threadId: 'p1' }]);
    // A keyboard reaches it with Tab, and Enter or Space opens it.
    expect(markers[0]!.tabIndex).toBe(0);
    for (const key of ['Enter', ' ']) {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      markers[0]!.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    }
    expect(opened).toHaveLength(3);
    // Nothing was written to the body.
    expect(view.state.doc.textContent).toBe('First lineSecond line');
  });

  it('moves a thread with its block, instead of orphaning it', async () => {
    const collab = openEditor([paragraph('Alpha'), paragraph('Beta text'), paragraph('Gamma')], {
      comments: true,
    });
    commentOnText(collab, 'text');
    const { view } = collab.editor;
    const blocks = topLevelBlocks(view.state.doc);
    // Up: the binding writes this as a delete of the block and a copy before Alpha.
    const tr = moveBlockTransaction(view.state, blocks[1]!.pos, 0)!;
    dispatchMove(view, tr);
    expect(collab.editor.state.doc.textContent).toBe('Beta textAlphaGamma');
    expect(highlighted(collab)).toEqual(['text']);
    await Promise.resolve();
    // Re-anchored in Yjs: the copy's text, so every device shows it there.
    const [thread] = readThreads(collab.replica.doc);
    const resolved = resolveAnchor(collab.replica.doc, thread!.anchor);
    expect(resolved.orphaned).toBe(false);
    expect(anchoredText(collab.replica.doc, resolved)).toBe('text');
    showAll(collab);
    expect(highlighted(collab)).toEqual(['text']);
  });

  /** The thread's text in Yjs, or null when it is orphaned there. */
  /** A pause: the next change is an undo step of its own. */
  const pause = (collab: Collab) =>
    yUndoPluginKey.getState(collab.editor.state)?.undoManager.stopCapturing();

  const inYjs = (collab: Collab): string | null => {
    const [thread] = readThreads(collab.replica.doc);
    const resolved = resolveAnchor(collab.replica.doc, thread!.anchor);
    return resolved.orphaned ? null : anchoredText(collab.replica.doc, resolved);
  };

  it('brings a thread back when Undo brings back its deleted text', async () => {
    const collab = openEditor([paragraph('The garden plan needs work.'), paragraph('Second.')], {
      comments: true,
    });
    commentOnText(collab, 'garden plan');
    const { view } = collab.editor;
    const from = posOf(collab, 'garden plan');
    pause(collab);
    view.dispatch(view.state.tr.delete(from, from + 'garden plan'.length));
    expect(inYjs(collab)).toBeNull();
    expect(collab.undo()).toBe(true);
    expect(collab.editor.state.doc.textContent).toBe('The garden plan needs work.Second.');
    await Promise.resolve();
    // Re-anchored on the restored text, so every device shows it again.
    expect(inYjs(collab)).toBe('garden plan');
    showAll(collab);
    expect(highlighted(collab)).toEqual(['garden plan']);
    // And Redo deletes it again.
    expect(collab.redo()).toBe(true);
    await Promise.resolve();
    expect(inYjs(collab)).toBeNull();
  });

  it('brings a thread back when Undo brings back its deleted block', async () => {
    const collab = openEditor([paragraph('Alpha'), paragraph('Beta text'), paragraph('Gamma')], {
      comments: true,
    });
    commentOnText(collab, 'text');
    const { view } = collab.editor;
    const blocks = topLevelBlocks(view.state.doc);
    pause(collab);
    view.dispatch(view.state.tr.delete(blocks[1]!.pos, blocks[1]!.pos + blocks[1]!.node.nodeSize));
    expect(collab.editor.state.doc.textContent).toBe('AlphaGamma');
    expect(inYjs(collab)).toBeNull();
    expect(collab.undo()).toBe(true);
    expect(collab.editor.state.doc.textContent).toBe('AlphaBeta textGamma');
    await Promise.resolve();
    expect(inYjs(collab)).toBe('text');
    showAll(collab);
    expect(highlighted(collab)).toEqual(['text']);
  });

  it('keeps a thread through undoing and redoing a block move', async () => {
    const collab = openEditor([paragraph('Alpha'), paragraph('Beta text'), paragraph('Gamma')], {
      comments: true,
    });
    commentOnText(collab, 'text');
    const { view } = collab.editor;
    const blocks = topLevelBlocks(view.state.doc);
    dispatchMove(view, moveBlockTransaction(view.state, blocks[1]!.pos, 0)!);
    await Promise.resolve();
    expect(inYjs(collab)).toBe('text');
    expect(collab.undo()).toBe(true);
    expect(collab.editor.state.doc.textContent).toBe('AlphaBeta textGamma');
    await Promise.resolve();
    expect(inYjs(collab)).toBe('text');
    expect(collab.redo()).toBe(true);
    expect(collab.editor.state.doc.textContent).toBe('Beta textAlphaGamma');
    await Promise.resolve();
    expect(inYjs(collab)).toBe('text');
  });

  it('shows the toolbar’s Comment button only where the app handles comments', () => {
    const off = openEditor([paragraph('Some text')]);
    const on = openEditor([paragraph('Some text')], { comments: true });
    const asked: string[] = [];
    on.editor.view.dom.addEventListener(COMMENT_ADD_EVENT, () => asked.push('add'));
    for (const [collab, shown] of [
      [off, false],
      [on, true],
    ] as const) {
      const toolbar = (
        collab.editor.storage as unknown as {
          selectionToolbar: { toolbar: { refresh(): void; element: HTMLElement } };
        }
      ).selectionToolbar.toolbar;
      toolbar.refresh();
      const button = toolbar.element.querySelector<HTMLButtonElement>('.pm-toolbar-comment')!;
      expect(button.hidden).toBe(!shown);
      if (shown) button.click();
    }
    expect(asked).toEqual(['add']);
  });
});

describe('a new thread’s place, for the floating composer (T52 item 5)', () => {
  it('finds a selection’s anchor in the editor, through typing before it', () => {
    const collab = openEditor([paragraph('The garden plan needs work.')], { comments: true });
    const { view } = collab.editor;
    const from = posOf(collab, 'garden plan');
    select(view, from, from + 'garden plan'.length);
    const made = selectionAnchor(view.state)!;
    expect(anchorRange(view.state, made.anchor)).toEqual({ from, to: from + 'garden plan'.length });
    select(view, posOf(collab, 'The'));
    type(view, 'So ');
    expect(anchorRange(view.state, made.anchor)).toEqual({
      from: from + 3,
      to: from + 3 + 'garden plan'.length,
    });
    // A point: the same position at both ends.
    select(view, from);
    const point = selectionAnchor(view.state)!;
    const at = anchorRange(view.state, point.anchor)!;
    expect(at.to).toBe(at.from);
  });
});

describe('a new thread’s passage while its composer floats (T52 item 5)', () => {
  const pending = (collab: Collab) =>
    [...collab.editor.view.dom.querySelectorAll<HTMLElement>('.pm-comment-pending')].map(
      (element) => element.textContent,
    );

  it('marks the passage, lighter than a thread, through typing, until it is sent or not', () => {
    const collab = openEditor([paragraph('The garden plan needs work.')], { comments: true });
    const { view } = collab.editor;
    const from = posOf(collab, 'garden plan');
    select(view, from, from + 'garden plan'.length);
    const made = selectionAnchor(view.state)!;
    showPendingComment(collab.editor, made.anchor);
    expect(pending(collab)).toEqual(['garden plan']);
    // Not a thread's mark: nothing to click, nothing listed.
    expect(highlighted(collab)).toEqual([]);
    select(view, posOf(collab, 'The'));
    type(view, 'So ');
    expect(pending(collab)).toEqual(['garden plan']);
    showPendingComment(collab.editor, null);
    expect(pending(collab)).toEqual([]);
  });

  it('marks a point with a marker that is not a thread’s', () => {
    const collab = openEditor([paragraph('The garden plan needs work.')], { comments: true });
    const { view } = collab.editor;
    select(view, posOf(collab, 'needs'));
    showPendingComment(collab.editor, selectionAnchor(view.state)!.anchor);
    const marker = view.dom.querySelector<HTMLElement>('.pm-comment-marker.pm-comment-pending');
    expect(marker).not.toBeNull();
    expect(marker!.dataset['thread']).toBeUndefined();
    expect(marker!.getAttribute('aria-hidden')).toBe('true');
    showPendingComment(collab.editor, null);
    expect(view.dom.querySelector('.pm-comment-pending')).toBeNull();
  });
});
