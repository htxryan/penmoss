import type { Replica } from '@penmoss/sync-client';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import { describe, expect, it } from 'vitest';
import {
  blockDragKey,
  deleteSelectedBlock,
  dropBlock,
  duplicateSelectedBlock,
  hasPendingUpdates,
  moveBlockTransaction,
  moveSelectedBlock,
  startBlockDrag,
  topLevelBlocks,
} from '../src/extensions/block-move';
import { EDITOR_COMMANDS } from '../src/commands';
import { openEditor, paragraph, press, select, startOf, type } from './support/editor';

type Collab = ReturnType<typeof openEditor>;

const texts = (collab: Collab) => {
  const out: string[] = [];
  collab.editor.state.doc.forEach((node) => out.push(node.textContent || node.type.name));
  return out;
};

/** Start position of the top-level block whose text is `text`. */
function blockPos(collab: Collab, text: string): number {
  const found = topLevelBlocks(collab.editor.state.doc).find(
    (block) => (block.node.textContent || block.node.type.name) === text,
  );
  if (!found) throw new Error(`no block "${text}"`);
  return found.pos;
}

/** The boundary just before the top-level block `text` (or the end of the note). */
function before(collab: Collab, text: string | null): number {
  return text === null ? collab.editor.state.doc.content.size : blockPos(collab, text);
}

function exchange(a: Replica, b: Replica) {
  const toB = a.encodeStateAsUpdate(b.encodeStateVector());
  const toA = b.encodeStateAsUpdate(a.encodeStateVector());
  b.applyUpdate(toB, 'remote');
  a.applyUpdate(toA, 'remote');
}

/** Two peers holding the same note, which neither has in its undo history. */
function twoPeers(content = ['A', 'B', 'C', 'D'].map((text) => paragraph(text))) {
  const seed = openEditor(content);
  const a = openEditor();
  const b = openEditor();
  exchange(seed.replica, a.replica);
  exchange(seed.replica, b.replica);
  return { a, b };
}

describe('moveBlockTransaction', () => {
  it('moves a top-level block down and up as one delete plus one insert', () => {
    const { a } = twoPeers();
    const view = a.editor.view;
    const down = moveBlockTransaction(view.state, blockPos(a, 'A'), before(a, 'D'))!;
    expect(down.steps).toHaveLength(2);
    view.dispatch(down);
    expect(texts(a)).toEqual(['B', 'C', 'A', 'D']);

    view.dispatch(moveBlockTransaction(view.state, blockPos(a, 'D'), before(a, 'B'))!);
    expect(texts(a)).toEqual(['D', 'B', 'C', 'A']);
    view.dispatch(moveBlockTransaction(view.state, blockPos(a, 'D'), before(a, null))!);
    expect(texts(a)).toEqual(['B', 'C', 'A', 'D']);
  });

  it('does nothing when the block would land where it is', () => {
    const { a } = twoPeers();
    const { state } = a.editor.view;
    expect(moveBlockTransaction(state, blockPos(a, 'B'), before(a, 'B'))).toBeNull();
    expect(moveBlockTransaction(state, blockPos(a, 'B'), before(a, 'C'))).toBeNull();
  });

  it('refuses positions that are not top-level block boundaries', () => {
    const { a } = twoPeers();
    const { state } = a.editor.view;
    expect(moveBlockTransaction(state, blockPos(a, 'B') + 1, before(a, 'D'))).toBeNull();
    expect(moveBlockTransaction(state, blockPos(a, 'B'), before(a, 'D') + 1)).toBeNull();
  });

  it('keeps the caret at the same place inside the moved block', () => {
    const { a } = twoPeers([paragraph('first'), paragraph('second')]);
    const view = a.editor.view;
    select(view, blockPos(a, 'second') + 3);
    view.dispatch(moveBlockTransaction(view.state, blockPos(a, 'second'), 0)!);
    expect(texts(a)).toEqual(['second', 'first']);
    expect(view.state.selection.from).toBe(3);
  });

  it('moves a whole table, callout or list with everything inside it', () => {
    const { a } = twoPeers([
      paragraph('top'),
      {
        type: 'callout',
        attrs: { type: 'tip', title: 'T', foldable: false, collapsed: false },
        content: [
          paragraph('inside'),
          {
            type: 'bulletList',
            content: [{ type: 'listItem', content: [paragraph('item')] }],
          },
        ],
      },
    ]);
    const callout = a.editor.getJSON().content?.[1];
    const view = a.editor.view;
    view.dispatch(moveBlockTransaction(view.state, blockPos(a, 'insideitem'), 0)!);
    expect(a.editor.getJSON().content?.[0]).toEqual(callout);
  });
});

describe('moving blocks and undo', () => {
  it('undoes a move in one step, without undoing the edit before it', () => {
    const { a } = twoPeers();
    const view = a.editor.view;
    a.editor
      .chain()
      .setTextSelection(blockPos(a, 'A') + 2)
      .insertContent('!')
      .run();
    expect(texts(a)).toEqual(['A!', 'B', 'C', 'D']);
    startBlockDrag(view, blockPos(a, 'A!'));
    expect(dropBlock(view, before(a, null))).toBe(true);
    expect(texts(a)).toEqual(['B', 'C', 'D', 'A!']);

    expect(a.undo()).toBe(true);
    expect(texts(a)).toEqual(['A!', 'B', 'C', 'D']);
    expect(a.undo()).toBe(true);
    expect(texts(a)).toEqual(['A', 'B', 'C', 'D']);
    expect(a.redo()).toBe(true);
    expect(a.redo()).toBe(true);
    expect(texts(a)).toEqual(['B', 'C', 'D', 'A!']);
  });

  it('moves the block holding the caret with Alt-Shift-ArrowUp and Alt-Shift-ArrowDown', () => {
    const { a } = twoPeers();
    const view = a.editor.view;
    select(view, blockPos(a, 'C') + 1);
    expect(press(view, 'ArrowUp', { altKey: true, shiftKey: true })).toBe(true);
    expect(texts(a)).toEqual(['A', 'C', 'B', 'D']);
    press(view, 'ArrowUp', { altKey: true, shiftKey: true });
    expect(texts(a)).toEqual(['C', 'A', 'B', 'D']);
    // At the top already: the key is left to the browser (selection extend on macOS).
    expect(press(view, 'ArrowUp', { altKey: true, shiftKey: true })).toBe(false);
    expect(texts(a)).toEqual(['C', 'A', 'B', 'D']);
    press(view, 'ArrowDown', { altKey: true, shiftKey: true });
    press(view, 'ArrowDown', { altKey: true, shiftKey: true });
    press(view, 'ArrowDown', { altKey: true, shiftKey: true });
    expect(texts(a)).toEqual(['A', 'B', 'D', 'C']);
    expect(view.state.selection.$from.parent.textContent).toBe('C');
    // Each keyboard move is its own undo step.
    a.undo();
    expect(texts(a)).toEqual(['A', 'B', 'C', 'D']);
  });

  it('moves the top-level block around a nested caret, and a selected formula', () => {
    const { a } = twoPeers([
      paragraph('top'),
      { type: 'bulletList', content: [{ type: 'listItem', content: [paragraph('item')] }] },
      { type: 'blockMath', attrs: { latex: 'x' } },
    ]);
    const view = a.editor.view;
    select(view, startOf(view, 'paragraph', 1) + 1);
    press(view, 'ArrowUp', { altKey: true, shiftKey: true });
    // TipTap keeps an empty paragraph after a closing atom (TrailingNode).
    expect(texts(a)).toEqual(['item', 'top', 'blockMath', 'paragraph']);
    view.dispatch(
      view.state.tr.setSelection(NodeSelection.create(view.state.doc, before(a, 'blockMath'))),
    );
    press(view, 'ArrowUp', { altKey: true, shiftKey: true });
    expect(texts(a)).toEqual(['item', 'blockMath', 'top', 'paragraph']);
    expect(view.state.selection).toBeInstanceOf(NodeSelection);
  });
});

describe('dragging while a peer edits', () => {
  it('moves the current content of the block when a peer edits it mid-drag', () => {
    const { a, b } = twoPeers();
    startBlockDrag(a.editor.view, blockPos(a, 'B'));
    // B's peer types into the dragged block and adds a block above it.
    b.editor
      .chain()
      .setTextSelection(blockPos(b, 'B') + 2)
      .insertContent(' edited')
      .run();
    b.editor.chain().setTextSelection(1).insertContent({ type: 'paragraph' }).run();
    exchange(a.replica, b.replica);
    expect(blockDragKey.getState(a.editor.state)).not.toBeNull();

    expect(dropBlock(a.editor.view, before(a, null))).toBe(true);
    exchange(a.replica, b.replica);
    expect(texts(a).filter((text) => text !== 'paragraph')).toEqual(['A', 'C', 'D', 'B edited']);
    expect(b.editor.getJSON()).toEqual(a.editor.getJSON());
  });

  it('cancels the drag, inserting nothing, when a peer deletes the block mid-drag', () => {
    const { a, b } = twoPeers();
    startBlockDrag(a.editor.view, blockPos(a, 'C'));
    const pos = blockPos(b, 'C');
    b.editor.view.dispatch(
      b.editor.state.tr.delete(pos, pos + b.editor.state.doc.nodeAt(pos)!.nodeSize),
    );
    exchange(a.replica, b.replica);
    expect(blockDragKey.getState(a.editor.state)).toBeNull();
    expect(dropBlock(a.editor.view, 0)).toBe(false);
    exchange(a.replica, b.replica);
    expect(texts(a)).toEqual(['A', 'B', 'D']);
    expect(texts(b)).toEqual(['A', 'B', 'D']);
  });

  it('keeps both copies when two offline peers move the same block to different places', () => {
    // Yjs has no move operation: each peer deletes the block and inserts a copy, so
    // concurrent moves that sync later keep both copies. Nothing is lost.
    const { a, b } = twoPeers(['A', 'B', 'C', 'D', 'E'].map((text) => paragraph(text)));
    startBlockDrag(a.editor.view, blockPos(a, 'A'));
    dropBlock(a.editor.view, before(a, null));
    startBlockDrag(b.editor.view, blockPos(b, 'A'));
    dropBlock(b.editor.view, before(b, 'D'));
    exchange(a.replica, b.replica);
    expect(a.editor.getJSON()).toEqual(b.editor.getJSON());
    expect(texts(a)).toEqual(['B', 'C', 'A', 'D', 'E', 'A']);
  });
});

describe('block moves: review follow-ups', () => {
  it('only reports a dry run (no view or dispatch changes the note)', () => {
    const { a } = twoPeers();
    const view = a.editor.view;
    select(view, blockPos(a, 'C') + 1);
    const before = a.editor.getJSON();
    expect(moveSelectedBlock(-1)(view.state, undefined, view)).toBe(true);
    expect(a.editor.getJSON()).toEqual(before);
    expect(
      a.editor.can().command(({ state, view: v }) => moveSelectedBlock(-1)(state, undefined, v)),
    ).toBe(true);
    expect(a.editor.getJSON()).toEqual(before);
  });

  it('leaves Alt-Shift-ArrowDown to the browser at the bottom of the note', () => {
    const { a } = twoPeers();
    const view = a.editor.view;
    select(view, blockPos(a, 'D') + 1);
    expect(press(view, 'ArrowDown', { altKey: true, shiftKey: true })).toBe(false);
  });

  it('undo restores the exact document and selection from before the move', () => {
    const { a } = twoPeers();
    const view = a.editor.view;
    const caret = blockPos(a, 'B') + 2;
    view.dispatch(
      view.state.tr.setSelection(TextSelection.create(view.state.doc, caret - 1, caret)),
    );
    const json = a.editor.getJSON();
    const selection: unknown = view.state.selection.toJSON();
    press(view, 'ArrowDown', { altKey: true, shiftKey: true });
    expect(texts(a)).toEqual(['A', 'C', 'B', 'D']);
    expect(a.undo()).toBe(true);
    expect(a.editor.getJSON()).toEqual(json);
    expect(view.state.selection.toJSON()).toEqual(selection);
  });

  it('makes typing straight after a move its own undo step', () => {
    const { a } = twoPeers();
    const view = a.editor.view;
    select(view, blockPos(a, 'B') + 2);
    press(view, 'ArrowUp', { altKey: true, shiftKey: true });
    // Well inside the undo manager's 500 ms capture window.
    type(view, 'x');
    expect(texts(a)).toEqual(['Bx', 'A', 'C', 'D']);
    a.undo();
    expect(texts(a)).toEqual(['B', 'A', 'C', 'D']);
    a.undo();
    expect(texts(a)).toEqual(['A', 'B', 'C', 'D']);
  });

  it('keeps a selected image selected when its block moves', () => {
    const image = {
      type: 'image',
      attrs: { src: 'attachments/a.png', alt: 'a', title: null, width: null, height: null },
    };
    const { a } = twoPeers([
      paragraph('top'),
      { type: 'paragraph', content: [{ type: 'text', text: 'pic ' }, image] },
    ]);
    const view = a.editor.view;
    const imagePos = blockPos(a, 'pic ') + 1 + 'pic '.length;
    view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, imagePos)));
    press(view, 'ArrowUp', { altKey: true, shiftKey: true });
    expect(texts(a)[0]).toBe('pic ');
    expect(view.state.selection).toBeInstanceOf(NodeSelection);
    expect((view.state.selection as NodeSelection).node.type.name).toBe('image');
  });

  it('refuses to move while a peer update waits for content it builds on', () => {
    const { a, b } = twoPeers();
    // B makes two edits; A receives only the second, which depends on the first.
    const vector = b.replica.encodeStateVector();
    b.editor
      .chain()
      .setTextSelection(blockPos(b, 'B') + 2)
      .insertContent('1')
      .run();
    const first = b.replica.encodeStateAsUpdate(vector);
    const middle = b.replica.encodeStateVector();
    b.editor
      .chain()
      .setTextSelection(blockPos(b, 'B1') + 3)
      .insertContent('2')
      .run();
    const second = b.replica.encodeStateAsUpdate(middle);
    a.replica.applyUpdate(second, 'remote');
    expect(texts(a)).toEqual(['A', 'B', 'C', 'D']);
    expect(hasPendingUpdates(a.editor.state)).toBe(true);

    const view = a.editor.view;
    select(view, blockPos(a, 'B') + 1);
    expect(press(view, 'ArrowDown', { altKey: true, shiftKey: true })).toBe(false);
    expect(startBlockDrag(view, blockPos(a, 'B'))).toBe(true);
    expect(dropBlock(view, before(a, null))).toBe(false);
    expect(texts(a)).toEqual(['A', 'B', 'C', 'D']);

    // Once the missing update arrives, B's edits integrate into the block, and it moves.
    a.replica.applyUpdate(first, 'remote');
    expect(hasPendingUpdates(a.editor.state)).toBe(false);
    expect(texts(a)).toEqual(['A', 'B12', 'C', 'D']);
    select(view, blockPos(a, 'B12') + 1);
    expect(press(view, 'ArrowDown', { altKey: true, shiftKey: true })).toBe(true);
    expect(texts(a)).toEqual(['A', 'C', 'B12', 'D']);
    exchange(a.replica, b.replica);
    expect(b.editor.getJSON()).toEqual(a.editor.getJSON());
  });
});

describe('duplicate and delete a block (T40 P8, ED5)', () => {
  const run = (collab: Collab, id: string) =>
    EDITOR_COMMANDS.find((command) => command.id === id)!.run({ editor: collab.editor });

  it('duplicates the block holding the caret after it, the caret in the copy', () => {
    const { a } = twoPeers();
    // After the B: its block's start, then the text.
    select(a.editor.view, blockPos(a, 'B') + 2);
    expect(run(a, 'editor.duplicateBlock')).toBe(true);
    expect(texts(a)).toEqual(['A', 'B', 'B', 'C', 'D']);
    const { $from } = a.editor.state.selection;
    expect($from.index(0)).toBe(2);
    expect($from.parentOffset).toBe(1);
  });

  it('duplicates a whole list from a caret inside it, as one undo step', () => {
    const list = {
      type: 'bulletList',
      content: [{ type: 'listItem', content: [paragraph('one')] }],
    };
    const { a } = twoPeers([paragraph('A'), list]);
    select(a.editor.view, startOf(a.editor.view, 'listItem') + 2);
    expect(run(a, 'editor.duplicateBlock')).toBe(true);
    // The editor keeps a paragraph after a list at the note's end, as always.
    expect(
      a.editor
        .getJSON()
        .content?.map((node) => node.type)
        .slice(0, 3),
    ).toEqual(['paragraph', 'bulletList', 'bulletList']);
    expect(texts(a).slice(0, 3)).toEqual(['A', 'one', 'one']);
    expect(a.undo()).toBe(true);
    expect(texts(a).filter((text) => text === 'one')).toHaveLength(1);
  });

  it('deletes the block holding the caret, the caret in the block after it', () => {
    const { a } = twoPeers();
    select(a.editor.view, blockPos(a, 'B') + 1);
    expect(run(a, 'editor.deleteBlock')).toBe(true);
    expect(texts(a)).toEqual(['A', 'C', 'D']);
    expect(a.editor.state.selection.$from.parent.textContent).toBe('C');
    expect(a.undo()).toBe(true);
    expect(texts(a)).toEqual(['A', 'B', 'C', 'D']);
  });

  it('deletes the last block into the one before, and the only block into an empty line', () => {
    const { a } = twoPeers([paragraph('A'), paragraph('B')]);
    select(a.editor.view, blockPos(a, 'B') + 1);
    expect(run(a, 'editor.deleteBlock')).toBe(true);
    expect(texts(a)).toEqual(['A']);
    expect(a.editor.state.selection.$from.parent.textContent).toBe('A');
    expect(run(a, 'editor.deleteBlock')).toBe(true);
    expect(a.editor.getJSON().content).toEqual([{ type: 'paragraph' }]);
  });

  it('only reports a dry run, and refuses while a peer update is pending', () => {
    const { a, b } = twoPeers();
    select(a.editor.view, blockPos(a, 'B') + 1);
    const { state } = a.editor.view;
    expect(duplicateSelectedBlock()(state)).toBe(true);
    expect(deleteSelectedBlock()(state)).toBe(true);
    expect(texts(a)).toEqual(['A', 'B', 'C', 'D']);

    // B makes two edits; A receives only the second, which depends on the first.
    const vector = b.replica.encodeStateVector();
    b.editor
      .chain()
      .setTextSelection(blockPos(b, 'B') + 2)
      .insertContent('1')
      .run();
    const first = b.replica.encodeStateAsUpdate(vector);
    const middle = b.replica.encodeStateVector();
    b.editor
      .chain()
      .setTextSelection(blockPos(b, 'B1') + 3)
      .insertContent('2')
      .run();
    a.replica.applyUpdate(b.replica.encodeStateAsUpdate(middle), 'remote');
    expect(hasPendingUpdates(a.editor.state)).toBe(true);
    select(a.editor.view, blockPos(a, 'B') + 1);
    expect(run(a, 'editor.duplicateBlock')).toBe(false);
    expect(run(a, 'editor.deleteBlock')).toBe(false);
    expect(texts(a)).toEqual(['A', 'B', 'C', 'D']);
    a.replica.applyUpdate(first, 'remote');
    expect(run(a, 'editor.deleteBlock')).toBe(true);
    expect(texts(a)).toEqual(['A', 'C', 'D']);
  });
});
