import type { Replica } from '@penmoss/sync-client';
import { Plugin } from '@tiptap/pm/state';
import { afterEach, describe, expect, it } from 'vitest';
import { createCollabEditor, type CollabEditor } from '../src/collab';
import { spikeDocument, spikeExtensions } from '../src/spike/schema';

const editors: CollabEditor[] = [];
afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
});

function open(): CollabEditor {
  const editor = createCollabEditor({
    element: document.createElement('div'),
    extensions: spikeExtensions(),
  });
  editors.push(editor);
  return editor;
}

/** Sends each side what the other is missing, like a reconnect handshake. */
function exchange(a: Replica, b: Replica) {
  const toB = a.encodeStateAsUpdate(b.encodeStateVector());
  const toA = b.encodeStateAsUpdate(a.encodeStateVector());
  b.applyUpdate(toB, 'remote');
  a.applyUpdate(toA, 'remote');
}

/** Position just after the first occurrence of `text` in the document. */
function after(editor: CollabEditor, text: string): number {
  let found = -1;
  editor.editor.state.doc.descendants((node, pos) => {
    if (found !== -1) return false;
    const index = node.isText ? (node.text ?? '').indexOf(text) : -1;
    if (index !== -1) found = pos + index + text.length;
    return true;
  });
  if (found === -1) throw new Error(`"${text}" not found`);
  return found;
}

function type(editor: CollabEditor, anchorText: string, text: string) {
  editor.editor.chain().setTextSelection(after(editor, anchorText)).insertContent(text).run();
}

/** Cells per table row. */
function tableShape(editor: CollabEditor): number[] {
  const rows: number[] = [];
  editor.editor.state.doc.descendants((node) => {
    if (node.type.name === 'tableRow') rows.push(node.childCount);
    return true;
  });
  return rows;
}

/** Nth node of a type: its position and size. */
function nodeAt(editor: CollabEditor, name: string, nth = 0): { pos: number; size: number } {
  const found: Array<{ pos: number; size: number }> = [];
  editor.editor.state.doc.descendants((node, pos) => {
    if (node.type.name === name) found.push({ pos, size: node.nodeSize });
    return true;
  });
  const node = found[nth];
  if (!node) throw new Error(`No ${name} #${nth}`);
  return node;
}

/** Two editors that received the spike document from a third (so it is not in their undo history). */
function twoEditorsWithSpikeDocument() {
  const seed = open();
  seed.editor.commands.setContent(spikeDocument);
  const a = open();
  const b = open();
  exchange(seed.replica, a.replica);
  exchange(seed.replica, b.replica);
  expect(a.editor.getJSON()).toEqual(seed.editor.getJSON());
  expect(b.editor.getJSON()).toEqual(seed.editor.getJSON());
  return { a, b };
}

describe('TipTap on Yjs 14', () => {
  it('binds the editor to the replica both ways', () => {
    const { a, b } = twoEditorsWithSpikeDocument();
    expect(a.replica.plainText()).toContain('Cell A1');
    type(b, 'Intro', ' from B');
    exchange(a.replica, b.replica);
    expect(a.editor.getText()).toContain('Intro from B');
  });

  it('converges concurrent offline edits in a table and a nested callout without losing either', () => {
    const { a, b } = twoEditorsWithSpikeDocument();

    // Offline: both edit the same table cell and the same nested callout paragraph,
    // and B also changes structure (adds a row, adds a paragraph in the nested callout).
    type(a, 'Cell A1', ' +a');
    type(b, 'Cell A', '[b]');
    b.editor.chain().setTextSelection(after(b, 'Cell B2')).addRowAfter().run();
    type(a, 'Nested body', ' +a-nested');
    b.editor
      .chain()
      .setTextSelection(after(b, 'Nested body'))
      .splitBlock()
      .insertContent('B new paragraph')
      .run();
    type(b, 'Nested', '[b-nested]');

    exchange(a.replica, b.replica);

    expect(a.editor.getJSON()).toEqual(b.editor.getJSON());
    a.editor.state.doc.check();
    const text = a.editor.getText();
    for (const fragment of [' +a', '[b]', ' +a-nested', '[b-nested]', 'B new paragraph']) {
      expect(text).toContain(fragment);
    }
    expect(tableShape(a)).toEqual([2, 2, 2]);
    // Neither binding had to repair the schema: the merged Y state renders as-is.
    expect(a.replica.plainText()).toBe(b.replica.plainText());
  });

  it('undoes only local edits, after a remote merge', () => {
    const { a, b } = twoEditorsWithSpikeDocument();
    type(a, 'Intro', ' local-a');
    type(b, 'Cell B2', ' remote-b');
    exchange(a.replica, b.replica);
    expect(a.editor.getText()).toContain('remote-b');

    expect(a.undo()).toBe(true);
    expect(a.editor.getText()).not.toContain('local-a');
    expect(a.editor.getText()).toContain('remote-b');

    expect(a.redo()).toBe(true);
    expect(a.editor.getText()).toContain('local-a');
    exchange(a.replica, b.replica);
    expect(b.editor.getJSON()).toEqual(a.editor.getJSON());
  });

  it('keeps plugins registered after creation from repairing what the binding renders', () => {
    const { a, b } = twoEditorsWithSpikeDocument();
    // Stands in for a repair plugin (fixTables, TrailingNode) added late, e.g. by a menu.
    const repairs: string[] = [];
    a.editor.registerPlugin(
      new Plugin({
        appendTransaction(transactions, _oldState, newState) {
          if (!transactions.some((tr) => tr.docChanged)) return null;
          repairs.push(newState.doc.textContent);
          return null;
        },
      }),
    );

    type(b, 'Intro', ' remote');
    exchange(a.replica, b.replica);
    expect(a.editor.getText()).toContain('Intro remote');
    expect(repairs).toEqual([]);

    // Local edits are still repaired, once, by their author.
    type(a, 'Intro', ' local');
    expect(repairs).toHaveLength(1);
  });

  it('keeps a table stable when one peer adds a row and the other a column', () => {
    const { a, b } = twoEditorsWithSpikeDocument();
    a.editor.chain().setTextSelection(after(a, 'Cell B2')).addRowAfter().run();
    b.editor.chain().setTextSelection(after(b, 'Cell A1')).addColumnAfter().run();

    // Several sync rounds: repairs must not bounce between the peers.
    for (let round = 0; round < 4; round++) exchange(a.replica, b.replica);
    const settled = a.replica.encodeStateVector();
    exchange(a.replica, b.replica);

    expect(a.editor.getJSON()).toEqual(b.editor.getJSON());
    expect(a.replica.encodeStateVector()).toEqual(settled);
    // Three columns at most; the new row may stay one cell short until someone edits the table.
    expect(Math.max(...tableShape(a))).toBe(3);
    expect(tableShape(a)).toHaveLength(3);
  });

  // T4 finding: Yjs 13 (TipTap's y-prosemirror fork) left each view showing a paragraph
  // that no longer existed in Yjs. Yjs 14 drops the empty callout everywhere (ADR 0003).
  it('converges when concurrent deletes empty a callout (block+)', () => {
    const seed = open();
    seed.editor.commands.setContent({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'before' }] },
        {
          type: 'callout',
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: 'p1' }] },
            { type: 'paragraph', content: [{ type: 'text', text: 'p2' }] },
          ],
        },
        { type: 'paragraph', content: [{ type: 'text', text: 'after' }] },
      ],
    });
    const a = open();
    const b = open();
    exchange(seed.replica, a.replica);
    exchange(seed.replica, b.replica);

    const p1 = nodeAt(a, 'paragraph', 1);
    a.editor.commands.deleteRange({ from: p1.pos, to: p1.pos + p1.size });
    const p2 = nodeAt(b, 'paragraph', 2);
    b.editor.commands.deleteRange({ from: p2.pos, to: p2.pos + p2.size });
    exchange(a.replica, b.replica);

    expect(a.editor.getJSON()).toEqual(b.editor.getJSON());
    expect(a.editor.getText()).toBe(b.editor.getText());
    expect(a.replica.plainText()).toBe('before\nafter');
  });
});
