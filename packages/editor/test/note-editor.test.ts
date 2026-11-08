import { parseMarkdown } from '@penmoss/core';
import { NOTE_ROOT } from '@penmoss/sync-client';
import { setBody } from '@penmoss/sync-client/history';
import { createYjs14Replica } from '@penmoss/sync-client/yjs14';
import { pmnodeToDelta, yUndoPluginKey } from '@y/prosemirror';
import { afterEach, describe, expect, it } from 'vitest';
import { createCollabEditor, type CollabEditor } from '../src/collab';
import { noteExtensions } from '../src/extensions';

const editors: CollabEditor[] = [];
afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
});

function open(replica = createYjs14Replica()): CollabEditor {
  const collab = createCollabEditor({
    element: document.createElement('div'),
    extensions: noteExtensions(),
    replica,
  });
  editors.push(collab);
  return collab;
}

describe('note editor (core schema)', () => {
  it('binds an empty note without writing to it', () => {
    const replica = createYjs14Replica();
    const updates: Uint8Array[] = [];
    replica.onUpdate((update) => updates.push(update));
    open(replica);
    expect(updates).toEqual([]);
    expect(replica.doc.get(NOTE_ROOT).length).toBe(0);
  });

  it('writes nothing to a note that ends in a non-paragraph when the reader only clicks or focuses it', () => {
    // Made elsewhere (an agent's create, another device): it ends with a quote, not a paragraph.
    const source = createYjs14Replica();
    setBody(source.doc, pmnodeToDelta(parseMarkdown('## Plans\n\n> A quote\n').doc));
    const replica = createYjs14Replica();
    replica.applyUpdate(source.encodeStateAsUpdate(), 'remote');
    const collab = open(replica);
    const written: Uint8Array[] = [];
    replica.onUpdate((update, origin) => {
      if (origin !== 'remote') written.push(update);
    });
    // Focusing, clicking (a selection), a decoration's meta transaction (the agent highlight).
    collab.editor.commands.focus('end');
    collab.editor.commands.setTextSelection(1);
    collab.editor.view.dispatch(collab.editor.state.tr.setMeta('highlight', true));
    expect(written).toEqual([]);

    // A remote change while it is open (an agent appends a list), then another click: still nothing.
    setBody(source.doc, pmnodeToDelta(parseMarkdown('## Plans\n\n> A quote\n\n- one\n').doc));
    replica.applyUpdate(source.encodeStateAsUpdate(replica.encodeStateVector()), 'remote');
    collab.editor.commands.setTextSelection(2);
    collab.editor.view.dispatch(collab.editor.state.tr.setMeta('highlight', false));
    expect(written).toEqual([]);
    expect(collab.editor.state.doc.lastChild?.type.name).toBe('bulletList');

    // Typing is a local edit: the editor still adds its trailing paragraph then, once.
    collab.editor.chain().setTextSelection(4).insertContent('!').run();
    expect(written.length).toBeGreaterThan(0);
    expect(collab.editor.state.doc.lastChild?.type.name).toBe('paragraph');
  });

  it('writes typed blocks to the replica and renders them in another editor', () => {
    const a = open();
    a.editor
      .chain()
      .focus()
      .insertContent([
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Plan' }] },
        {
          type: 'taskList',
          content: [
            {
              type: 'taskItem',
              attrs: { checked: true },
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Ship' }] }],
            },
          ],
        },
      ])
      .run();
    const b = open();
    b.replica.applyUpdate(a.replica.encodeStateAsUpdate(), 'remote');
    expect(b.editor.getJSON()).toEqual(a.editor.getJSON());
    expect(b.replica.plainText()).toContain('Ship');
  });

  it('undoes only through the Yjs undo manager', () => {
    const collab = open();
    collab.editor.chain().focus().insertContent('hello').run();
    expect(collab.editor.getText()).toContain('hello');
    expect(collab.undo()).toBe(true);
    expect(collab.editor.getText()).not.toContain('hello');
  });

  // T39 pass 2 (A520): undoing a new note's first words emptied it, and Redo then did nothing
  // the first time and left a stray empty paragraph.
  it('redoes in one step what an undo took out of a new note, with no stray paragraph', () => {
    const replica = createYjs14Replica();
    const collab = open(replica);
    const blocks = () => {
      const texts: string[] = [];
      collab.editor.state.doc.forEach((node) => texts.push(node.textContent));
      return texts;
    };
    const plugin = yUndoPluginKey.getState(collab.editor.state) as
      { readonly undoManager: { stopCapturing(): void } } | undefined;
    const undoManager = plugin!.undoManager;
    collab.editor.chain().focus().insertContent('First line').run();
    undoManager.stopCapturing(); // A pause in typing: the next words are a step of their own.
    collab.editor.chain().splitBlock().insertContent('Second').run();
    expect(blocks()).toEqual(['First line', 'Second']);

    expect(collab.undo()).toBe(true);
    expect(blocks()).toEqual(['First line']);
    expect(collab.undo()).toBe(true);
    expect(blocks()).toEqual(['']);
    expect(collab.undo()).toBe(false);

    expect(collab.redo()).toBe(true);
    expect(blocks()).toEqual(['First line']);
    expect(collab.redo()).toBe(true);
    expect(blocks()).toEqual(['First line', 'Second']);
    expect(collab.redo()).toBe(false);
    // The note's copy says the same: the editor wrote nothing of its own around the steps.
    expect(replica.doc.get(NOTE_ROOT).length).toBe(2);
  });

  it('redoes in one step when the first block is a heading, a list or code', () => {
    const firsts: ReadonlyArray<[string, (collab: CollabEditor) => void]> = [
      ['heading', (collab) => collab.editor.chain().focus().setHeading({ level: 2 }).run()],
      ['bulletList', (collab) => collab.editor.chain().focus().toggleBulletList().run()],
      ['codeBlock', (collab) => collab.editor.chain().focus().setCodeBlock().run()],
    ];
    for (const [kind, start] of firsts) {
      const replica = createYjs14Replica();
      const collab = open(replica);
      start(collab);
      collab.editor.chain().insertContent('Words').run();
      const typed = collab.editor.getJSON();
      expect(collab.editor.state.doc.firstChild?.type.name, kind).toBe(kind);
      const updates: Uint8Array[] = [];
      const off = replica.onUpdate((update) => updates.push(update));
      expect(collab.undo(), kind).toBe(true);
      expect(collab.undo(), kind).toBe(false);
      expect(collab.editor.state.doc.textContent, kind).toBe('');
      // Only the undo wrote to the note: the editor added nothing of its own after it.
      expect(updates.length, kind).toBe(1);
      off();
      expect(collab.redo(), kind).toBe(true);
      expect(collab.editor.getJSON(), kind).toEqual(typed);
      expect(collab.redo(), kind).toBe(false);
    }
  });

  it('still undoes a change to the only block’s attributes', () => {
    const collab = open();
    collab.editor.chain().focus().setHeading({ level: 1 }).insertContent('Title').run();
    const plugin = yUndoPluginKey.getState(collab.editor.state) as
      { readonly undoManager: { stopCapturing(): void } } | undefined;
    plugin!.undoManager.stopCapturing();
    collab.editor.chain().setHeading({ level: 3 }).run();
    expect(collab.editor.state.doc.firstChild?.attrs.level).toBe(3);
    expect(collab.undo()).toBe(true);
    expect(collab.editor.state.doc.firstChild?.attrs.level).toBe(1);
    expect(collab.editor.state.doc.firstChild?.textContent).toBe('Title');
  });

  it('keeps one Redo for words typed with no pause', () => {
    const collab = open();
    collab.editor.chain().focus().insertContent('All at once').splitBlock().run();
    collab.editor.chain().insertContent('and more').run();
    expect(collab.undo()).toBe(true);
    expect(collab.editor.getText()).toBe('');
    expect(collab.redo()).toBe(true);
    expect(collab.editor.getText()).toBe('All at once\n\nand more');
    expect(collab.editor.state.doc.childCount).toBe(2);
  });
});
