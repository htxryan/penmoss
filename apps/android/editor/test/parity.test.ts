/**
 * The editor page's T40 P8 side: the editor's parity with the web. Copy as
 * Markdown and rich text through the app's clipboard (ED9), paste and match
 * style (ED11), the Markdown source (ED17), the + sheet and the Block menu
 * (ED4, ED5), the table and code buttons (ED6, ED7), toggles remembered per
 * note (ED8) and the counts (NT24).
 */
import { NOTE_ROOT } from '@penmoss/sync-client';
import { initNote, setTitle } from '@penmoss/sync-client/note';
import { createYjs14Replica, type Yjs14Replica } from '@penmoss/sync-client/yjs14';
import type { JSONContent } from '@tiptap/core';
import * as Y from '@y/y';
import { toBase64 } from 'lib0/buffer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { select } from '../../../../packages/editor/test/support/editor';
import {
  COUNT_DELAY_MS,
  EDITED_SINCE,
  EditorHost,
  NOTHING_SELECTED,
  SELECTION_COUNT_MS,
  SOURCE_DELAY_MS,
  SOURCE_PASTE,
  WAIT_FOR_SYNC,
} from '../src/host';
import type { FormatCommand, FromEditor, ToEditor } from '../src/protocol';

const NOTE = '01JD2Z7Q8R4T6Y8W0E2R4T6YB1';

const hosts: EditorHost[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const host of hosts.splice(0)) host.close();
  document.body.replaceChildren();
});

function page() {
  const root = document.createElement('main');
  root.hidden = true;
  const title = document.createElement('textarea');
  const body = document.createElement('div');
  const unsupported = document.createElement('pre');
  root.append(title, body, unsupported);
  document.body.append(root);
  const sent: FromEditor[] = [];
  const host = new EditorHost({ root, title, body, unsupported }, (message) => sent.push(message));
  hosts.push(host);
  return { host, sent, root, body };
}

function serverNote(title: string, text = ''): Yjs14Replica {
  const replica = createYjs14Replica();
  initNote(replica.doc, { id: NOTE, created: '2026-10-23T10:00:00-05:00', kind: 'note' }, title);
  if (text) {
    replica.doc.transact(() => {
      const paragraph = new Y.Node('paragraph');
      replica.doc.get(NOTE_ROOT).push([paragraph]);
      paragraph.insert(0, text);
    });
  }
  return replica;
}

const openMessage = (server: Yjs14Replica, editable = true): ToEditor => ({
  v: 1,
  type: 'open',
  noteId: NOTE,
  synced: [{ id: '1', update: toBase64(server.encodeStateAsUpdate()) }],
  pending: [],
  editable,
});

/** A note open on the page with `content` as its body (set as a local edit). */
function opened(content: JSONContent[] = [], options: { editable?: boolean; title?: string } = {}) {
  const parts = page();
  const server = serverNote(options.title ?? 'Parity');
  parts.host.handle(openMessage(server, options.editable ?? true));
  const { editor } = parts.host.editor!;
  if (content.length > 0) editor.commands.setContent({ type: 'doc', content });
  return { ...parts, server, editor, view: editor.view };
}

const text = (value: string, marks?: JSONContent['marks']): JSONContent =>
  marks ? { type: 'text', text: value, marks } : { type: 'text', text: value };
const paragraph = (value?: string): JSONContent =>
  value ? { type: 'paragraph', content: [text(value)] } : { type: 'paragraph' };
const cell = (value: string): JSONContent => ({ type: 'tableCell', content: [text(value)] });
const header = (value: string): JSONContent => ({ type: 'tableHeader', content: [text(value)] });
const table: JSONContent = {
  type: 'table',
  content: [
    { type: 'tableRow', content: [header('A'), header('B')] },
    { type: 'tableRow', content: [cell('1'), cell('2')] },
  ],
};

const message = (body: Record<string, unknown>): ToEditor =>
  ({ v: 1, noteId: NOTE, ...body }) as unknown as ToEditor;
const format = (command: FormatCommand) => message({ type: 'format', command });
const ofType = <T extends FromEditor['type']>(sent: FromEditor[], type: T) =>
  sent.filter((each): each is Extract<FromEditor, { type: T }> => each.type === type);
const texts = (host: EditorHost) =>
  (host.editor!.editor.getJSON().content ?? []).map((node) =>
    JSON.stringify(node.content ?? []).replace(/.*?"text":"([^"]*)".*|.*/, '$1'),
  );

/** Puts the caret `offset` characters into the text `needle`. */
function caretIn(host: EditorHost, needle: string, offset = 0, to?: number) {
  const { editor } = host.editor!;
  let at = -1;
  editor.state.doc.descendants((node, pos) => {
    if (at >= 0) return false;
    if (node.isText && node.text?.includes(needle)) at = pos + node.text.indexOf(needle);
    return true;
  });
  if (at < 0) throw new Error(`no text "${needle}"`);
  select(editor.view, at + offset, to === undefined ? at + offset : at + to);
}

describe('Copy as Markdown and rich text (ED9)', () => {
  it('copies the whole note as Markdown with its frontmatter, as the web does', async () => {
    const { host, sent } = opened([
      { type: 'paragraph', content: [text('Bold', [{ type: 'bold' }]), text(' and plain')] },
    ]);
    host.handle(message({ type: 'setTag', tag: 'garden', on: true }));
    host.handle(message({ type: 'copy', format: 'markdown', scope: 'note' }));
    await vi.waitFor(() => expect(ofType(sent, 'clipboard')).toHaveLength(1));
    const [copied] = ofType(sent, 'clipboard');
    expect(copied!.format).toBe('markdown');
    expect(copied!.noteId).toBe(NOTE);
    expect(copied!.text).toMatch(
      /^---\nid: 01JD2Z7Q8R4T6Y8W0E2R4T6YB1\ntitle: Parity\ncreated: 2026-10-23T10:00:00-05:00\ntags: \[garden\]\n---\n\n\*\*Bold\*\* and plain\n?$/s,
    );
    expect(copied!.html).toBeUndefined();
  });

  it('copies the selection as rich text: HTML and readable text, no frontmatter', async () => {
    const { host, sent } = opened([
      { type: 'paragraph', content: [text('Bold', [{ type: 'bold' }]), text(' and plain')] },
      paragraph('second'),
    ]);
    caretIn(host, 'Bold', 0, 4);
    host.handle(message({ type: 'copy', format: 'rich', scope: 'selection' }));
    await vi.waitFor(() => expect(ofType(sent, 'clipboard')).toHaveLength(1));
    const [copied] = ofType(sent, 'clipboard');
    expect(copied!.format).toBe('rich');
    expect(copied!.text).toBe('Bold');
    expect(copied!.html).toContain('<strong>Bold</strong>');
    expect(copied!.html).not.toContain('second');
  });

  it('copies a selection as Markdown, and never the whole note when nothing is selected', async () => {
    const { host, sent } = opened([paragraph('first'), paragraph('second')]);
    caretIn(host, 'second', 0, 6);
    host.handle(message({ type: 'copy', format: 'markdown', scope: 'selection' }));
    await vi.waitFor(() => expect(ofType(sent, 'clipboard')).toHaveLength(1));
    expect(ofType(sent, 'clipboard')[0]!.text).toBe('second');

    // Review B2: the selection's copy with nothing selected says so; the ⋮ menu copies notes.
    caretIn(host, 'first');
    host.handle(message({ type: 'copy', format: 'markdown', scope: 'selection' }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ofType(sent, 'clipboard')).toHaveLength(1);
    expect(ofType(sent, 'notice').map((each) => each.message)).toContain(NOTHING_SELECTED);
  });

  it('forgets a selection the menu kept once the note is opened again (re-review)', async () => {
    // The same note opened again (a reload): a kept selection would still fit its text.
    const { host, sent } = page();
    const server = serverNote('Parity', 'first second');
    host.handle(openMessage(server));
    caretIn(host, 'second', 0, 6);
    host.handle(message({ type: 'captureSelection' }));
    host.handle(openMessage(server));
    host.handle(message({ type: 'copy', format: 'markdown', scope: 'selection' }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ofType(sent, 'clipboard')).toEqual([]);
    expect(ofType(sent, 'notice').map((each) => each.message)).toContain(NOTHING_SELECTED);
  });

  it('copies a read-only note too', async () => {
    const { host, sent } = opened([], { editable: false });
    host.handle(message({ type: 'copy', format: 'rich', scope: 'note' }));
    await vi.waitFor(() => expect(ofType(sent, 'clipboard')).toHaveLength(1));
  });

  it('sends a code block’s Copy through the app’s clipboard as text (ED7)', async () => {
    const { sent, body } = opened([
      { type: 'codeBlock', attrs: { language: 'bash' }, content: [text('echo hi')] },
    ]);
    body.querySelector<HTMLButtonElement>('button[aria-label="Copy Code"]')!.click();
    await vi.waitFor(() =>
      expect(ofType(sent, 'clipboard')).toEqual([
        { v: 1, type: 'clipboard', noteId: NOTE, format: 'text', text: 'echo hi' },
      ]),
    );
  });
});

describe('paste and match style (ED11)', () => {
  it('inserts the app’s text plain, with the marks around the caret', () => {
    const { host, editor } = opened([
      { type: 'paragraph', content: [text('bold here', [{ type: 'bold' }])] },
    ]);
    caretIn(host, 'here');
    host.handle(message({ type: 'insertPlain', text: '# not **a** heading ' }));
    expect(editor.getJSON().content?.[0]).toEqual({
      type: 'paragraph',
      content: [text('bold # not **a** heading here', [{ type: 'bold' }])],
    });
  });

  it('refuses a read-only note with a notice', () => {
    const { host, sent } = opened([paragraph('x')], { editable: false });
    host.handle(message({ type: 'insertPlain', text: 'y' }));
    expect(ofType(sent, 'notice')).toHaveLength(1);
  });
});

describe('the selection menu acts on what was selected, where (review B2)', () => {
  const capture = message({ type: 'captureSelection' });

  it('pastes as plain text into the title, over its selection, not into the body', () => {
    const { host, sent, editor, root } = opened([paragraph('body text')]);
    const title = root.querySelector('textarea')!;
    title.focus();
    title.setSelectionRange(0, 'Parity'.length);
    host.handle(capture);
    // The WebView clears the selection as the menu closes, before the paste arrives.
    title.setSelectionRange(title.value.length, title.value.length);
    host.handle(message({ type: 'insertPlain', text: 'Garden' }));
    expect(title.value).toBe('Garden');
    expect(ofType(sent, 'title').at(-1)?.title).toBe('Garden');
    expect(editor.state.doc.textContent).toBe('body text');
  });

  it('pastes into a callout’s title, which keeps it', () => {
    const { host, editor, body } = opened([
      { type: 'callout', attrs: { type: 'note', title: 'Old' }, content: [paragraph('inside')] },
    ]);
    const field = body.querySelector<HTMLInputElement>('input.pm-callout-title')!;
    field.focus();
    field.setSelectionRange(0, 3);
    host.handle(capture);
    host.handle(message({ type: 'insertPlain', text: 'New' }));
    expect(field.value).toBe('New');
    expect(editor.state.doc.firstChild?.attrs['title']).toBe('New');
    expect(editor.state.doc.textContent).toBe('inside');
  });

  it('pastes over the body’s selection even after the WebView cleared it', () => {
    const { host, editor } = opened([paragraph('keep this word')]);
    caretIn(host, 'this', 0, 4);
    host.handle(capture);
    caretIn(host, 'keep');
    host.handle(message({ type: 'insertPlain', text: 'that' }));
    expect(editor.state.doc.textContent).toBe('keep that word');
  });

  it('copies the selection the menu opened on, not the whole note, after the WebView cleared it', async () => {
    const { host, sent } = opened([paragraph('first'), paragraph('second')]);
    caretIn(host, 'second', 0, 6);
    host.handle(capture);
    caretIn(host, 'first');
    host.handle(message({ type: 'copy', format: 'markdown', scope: 'selection' }));
    await vi.waitFor(() => expect(ofType(sent, 'clipboard')).toHaveLength(1));
    expect(ofType(sent, 'clipboard')[0]!.text).toBe('second');
  });

  it('follows edits made between the menu opening and the copy', async () => {
    const { host, sent, view } = opened([paragraph('first'), paragraph('second')]);
    caretIn(host, 'second', 0, 6);
    host.handle(capture);
    view.dispatch(view.state.tr.insertText('XY', 1));
    host.handle(message({ type: 'copy', format: 'markdown', scope: 'selection' }));
    await vi.waitFor(() => expect(ofType(sent, 'clipboard')).toHaveLength(1));
    expect(ofType(sent, 'clipboard')[0]!.text).toBe('second');
  });

  it('copies a title’s selection as its text', () => {
    const { host, sent, root } = opened([paragraph('body')]);
    const title = root.querySelector('textarea')!;
    title.focus();
    title.setSelectionRange(0, 3);
    host.handle(capture);
    host.handle(message({ type: 'copy', format: 'rich', scope: 'selection' }));
    expect(ofType(sent, 'clipboard')).toEqual([
      { v: 1, type: 'clipboard', noteId: NOTE, format: 'text', text: 'Par' },
    ]);
  });

  it('uses a capture once, and only for its note', async () => {
    const { host, sent } = opened([paragraph('first'), paragraph('second')]);
    caretIn(host, 'second', 0, 6);
    host.handle(message({ type: 'captureSelection', noteId: 'other' }));
    caretIn(host, 'first');
    host.handle(message({ type: 'copy', format: 'markdown', scope: 'selection' }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ofType(sent, 'clipboard')).toEqual([]);
    expect(ofType(sent, 'notice').map((each) => each.message)).toEqual([NOTHING_SELECTED]);
  });
});

describe('Delete block (review S4)', () => {
  it('names what it removed, for the app’s Undo', () => {
    const { host, sent } = opened([
      paragraph('A'),
      { type: 'bulletList', content: [{ type: 'listItem', content: [paragraph('item')] }] },
    ]);
    caretIn(host, 'item');
    host.handle(message({ type: 'block', action: 'delete' }));
    expect(ofType(sent, 'blockDeleted')).toEqual([
      { v: 1, type: 'blockDeleted', noteId: NOTE, label: 'List' },
    ]);
    caretIn(host, 'A');
    host.handle(message({ type: 'block', action: 'moveUp' }));
    expect(ofType(sent, 'blockDeleted')).toHaveLength(1);
  });

  it('undoes the delete from the snackbar’s Undo', () => {
    const { host } = opened([
      paragraph('A'),
      { type: 'bulletList', content: [{ type: 'listItem', content: [paragraph('item')] }] },
    ]);
    caretIn(host, 'item');
    host.handle(message({ type: 'block', action: 'delete' }));
    expect(texts(host)).not.toContain('item');
    host.handle(message({ type: 'undoDelete' }));
    expect(texts(host)).toContain('item');
  });

  it('never undoes typing made after the delete, and says so (re-review)', () => {
    const { host, sent, editor } = opened([paragraph('A'), paragraph('gone')]);
    caretIn(host, 'gone');
    host.handle(message({ type: 'block', action: 'delete' }));
    caretIn(host, 'A', 1);
    editor.commands.insertContent('BC');
    host.handle(message({ type: 'undoDelete' }));
    expect(texts(host)).toEqual(['ABC']);
    expect(ofType(sent, 'notice').map((each) => each.message)).toEqual([EDITED_SINCE]);
    // Used once: a second tap does nothing more.
    host.handle(message({ type: 'undoDelete' }));
    expect(texts(host)).toEqual(['ABC']);
  });

  it('says to wait while another device’s update waits for what it builds on', () => {
    const { host, sent, server } = opened([paragraph('mine')]);
    // The server note gets two edits; the page receives only the second.
    const paragraphNode = new Y.Node('paragraph');
    const start = server.encodeStateVector();
    server.doc.get(NOTE_ROOT).push([paragraphNode]);
    paragraphNode.insert(0, 'one');
    const first = Y.encodeStateAsUpdate(server.doc, start);
    const middle = server.encodeStateVector();
    paragraphNode.insert(3, ' two');
    host.handle(
      message({ type: 'remote', update: toBase64(Y.encodeStateAsUpdate(server.doc, middle)) }),
    );
    caretIn(host, 'mine');
    host.handle(message({ type: 'block', action: 'delete' }));
    expect(ofType(sent, 'notice').map((each) => each.message)).toContain(WAIT_FOR_SYNC);
    expect(ofType(sent, 'blockDeleted')).toEqual([]);
    expect(texts(host)).toContain('mine');
    // Once the missing edit arrives, the block can go.
    host.handle(message({ type: 'remote', update: toBase64(first) }));
    caretIn(host, 'mine');
    host.handle(message({ type: 'block', action: 'delete' }));
    expect(ofType(sent, 'blockDeleted')).toHaveLength(1);
  });
});

describe('the Markdown source (ED17)', () => {
  it('shows the stored markdown with frontmatter, read-only, and the note again', async () => {
    const { host, root, body, editor, sent } = opened([
      { type: 'heading', attrs: { level: 2 }, content: [text('Plan')] },
      paragraph('water the beds'),
    ]);
    host.handle(message({ type: 'source', on: true }));
    const pre = root.querySelector<HTMLPreElement>('.note-source pre')!;
    expect(pre.getAttribute('aria-label')).toBe('Markdown source');
    // The codec loads on first use.
    await vi.waitFor(() => expect(pre.textContent).toContain('## Plan'));
    expect(pre.textContent).toMatch(/^---\nid: 01JD2Z7Q8R4T6Y8W0E2R4T6YB1\ntitle: Parity\n/);
    expect(pre.textContent).toContain('## Plan\n\nwater the beds');
    expect(body.hidden).toBe(true);
    expect(pre.isContentEditable).toBe(false);
    // Editing commands do nothing while the source shows.
    host.handle(message({ type: 'insert', item: 'table' }));
    expect(JSON.stringify(editor.getJSON())).not.toContain('"table"');

    host.handle(message({ type: 'source', on: false }));
    expect(root.querySelector('.note-source')).toBeNull();
    expect(body.hidden).toBe(false);
    // The app's menu and bar follow what shows (review S6).
    expect(ofType(sent, 'source').map((each) => each.on)).toEqual([true, false]);
  });

  it('says what shows when the source cannot be shown, and asks to show the note to paste', () => {
    const { host, sent } = opened([paragraph('text')]);
    host.handle(message({ type: 'source', on: true }));
    host.handle(message({ type: 'source', on: true }));
    expect(ofType(sent, 'source').map((each) => each.on)).toEqual([true, true]);
    host.handle(message({ type: 'insertPlain', text: 'x' }));
    expect(ofType(sent, 'notice').map((each) => each.message)).toEqual([SOURCE_PASTE]);
  });

  it('follows edits from another device while it shows', async () => {
    const { host, root, server } = opened();
    host.handle(message({ type: 'source', on: true }));
    await vi.waitFor(() =>
      expect(root.querySelector('.note-source pre')!.textContent).toContain('title: Parity'),
    );
    vi.useFakeTimers();
    const before = server.encodeStateVector();
    setTitle(server.doc, 'Renamed');
    host.handle(
      message({ type: 'remote', update: toBase64(Y.encodeStateAsUpdate(server.doc, before)) }),
    );
    vi.advanceTimersByTime(SOURCE_DELAY_MS);
    expect(root.querySelector('.note-source pre')!.textContent).toContain('title: Renamed');
  });

  it('goes when the note closes', () => {
    const { host, root } = opened();
    host.handle(message({ type: 'source', on: true }));
    host.close();
    expect(root.querySelector('.note-source')).toBeNull();
  });
});

describe('the + sheet and the Block menu (ED4, ED5)', () => {
  it('lists the slash menu’s blocks for a search, best first, and inserts one', () => {
    const { host, sent, editor } = opened([paragraph('start')]);
    caretIn(host, 'start', 5);
    host.handle(message({ type: 'blocks', purpose: 'insert', query: 'tab' }));
    const [answer] = ofType(sent, 'blocks');
    expect(answer!.items[0]).toEqual({ id: 'table', label: 'Table', icon: '▦', hint: '| a | b |' });
    host.handle(message({ type: 'blocks', purpose: 'insert', query: '' }));
    const all = ofType(sent, 'blocks')[1]!.items.map((item) => item.id);
    // The slash menu's order, with Image and File through the app (ED12).
    expect(all.slice(0, 4)).toEqual(['paragraph', 'heading1', 'heading2', 'heading3']);
    expect(all).toContain('image');
    expect(all).toContain('file');

    host.handle(message({ type: 'insert', item: 'table' }));
    expect(JSON.stringify(editor.getJSON())).toContain('"type":"table"');
  });

  it('offers only inline blocks in a table cell, and nothing to turn into', () => {
    const { host, sent } = opened([table]);
    caretIn(host, '1');
    host.handle(message({ type: 'blocks', purpose: 'insert', query: '' }));
    host.handle(message({ type: 'blocks', purpose: 'turnInto', query: '' }));
    const [inserts, kinds] = ofType(sent, 'blocks');
    expect(inserts!.items.map((item) => item.id)).not.toContain('table');
    expect(inserts!.items.map((item) => item.id)).toContain('inlineMath');
    expect(kinds!.items).toEqual([]);
  });

  it('turns a block into a heading, a callout or a toggle, marking the current kind', () => {
    const { host, sent, editor } = opened([paragraph('title')]);
    caretIn(host, 'title');
    host.handle(message({ type: 'blocks', purpose: 'turnInto', query: '' }));
    const kinds = ofType(sent, 'blocks')[0]!.items;
    expect(kinds.find((item) => item.id === 'paragraph')!.active).toBe(true);
    expect(kinds.map((item) => item.id)).toEqual(
      expect.arrayContaining(['heading1', 'callout', 'toggle', 'codeBlock']),
    );
    host.handle(message({ type: 'turnInto', item: 'heading2' }));
    expect(editor.isActive('heading', { level: 2 })).toBe(true);
    host.handle(message({ type: 'turnInto', item: 'toggle' }));
    expect(editor.isActive('callout', { foldable: true })).toBe(true);
  });

  it('moves, duplicates and deletes the block holding the caret', () => {
    const { host } = opened([paragraph('A'), paragraph('B'), paragraph('C')]);
    caretIn(host, 'B');
    host.handle(message({ type: 'block', action: 'moveUp' }));
    expect(texts(host).slice(0, 3)).toEqual(['B', 'A', 'C']);
    host.handle(message({ type: 'block', action: 'moveDown' }));
    expect(texts(host).slice(0, 3)).toEqual(['A', 'B', 'C']);
    host.handle(message({ type: 'block', action: 'duplicate' }));
    expect(texts(host).slice(0, 4)).toEqual(['A', 'B', 'B', 'C']);
    host.handle(message({ type: 'block', action: 'delete' }));
    expect(texts(host).slice(0, 3)).toEqual(['A', 'B', 'C']);
  });

  it('says when the caret is in the title, where the app hides the bar (T39 pass 3, A554)', () => {
    vi.useFakeTimers();
    const { host, sent, root } = opened([paragraph('A')]);
    const title = root.querySelector('textarea')!;
    caretIn(host, 'A');
    vi.runOnlyPendingTimers();
    expect(ofType(sent, 'state').at(-1)).toMatchObject({ inTitle: false });
    title.focus();
    vi.runOnlyPendingTimers();
    expect(ofType(sent, 'state').at(-1)).toMatchObject({ inTitle: true });
    title.blur();
    vi.runOnlyPendingTimers();
    expect(ofType(sent, 'state').at(-1)).toMatchObject({ inTitle: false });
  });

  it('says where the block can move, in the bar’s state', () => {
    vi.useFakeTimers();
    const { host, sent } = opened([paragraph('A'), paragraph('B')]);
    caretIn(host, 'A');
    vi.runOnlyPendingTimers();
    expect(ofType(sent, 'state').at(-1)).toMatchObject({
      canMoveUp: false,
      canMoveDown: true,
      canTurnInto: true,
      inTable: false,
      inCode: false,
    });
  });

  it('ignores a block it does not know, and one that cannot go here', () => {
    const { host, sent } = opened([table]);
    caretIn(host, '1');
    host.handle(message({ type: 'insert', item: 'table' }));
    host.handle(message({ type: 'insert', item: 'nonsense' }));
    expect(ofType(sent, 'notice').map((each) => each.message)).toEqual([
      'That block cannot go here',
      'That block cannot go here',
    ]);
    expect(JSON.stringify(host.editor!.editor.getJSON()).match(/"type":"table"/g)).toHaveLength(1);
  });
});

describe('table, heading and code buttons (ED4, ED6, ED7)', () => {
  it('moves between cells, adds a row at the end, and adds rows and columns', () => {
    vi.useFakeTimers();
    const { host, sent, editor } = opened([table]);
    caretIn(host, 'A');
    vi.runOnlyPendingTimers();
    expect(ofType(sent, 'state').at(-1)).toMatchObject({ inTable: true, canTurnInto: false });

    host.handle(format('nextCell'));
    expect(editor.state.selection.$from.parent.textContent).toBe('B');
    host.handle(format('previousCell'));
    expect(editor.state.selection.$from.parent.textContent).toBe('A');
    caretIn(host, '2');
    host.handle(format('nextCell'));
    const grid = () => (editor.getJSON() as JSONContent).content![0]!;
    const rows = () => grid().content!.length;
    expect(rows()).toBe(3);
    host.handle(format('addRow'));
    expect(rows()).toBe(4);
    host.handle(format('addColumn'));
    expect(grid().content![0]!.content).toHaveLength(3);
  });

  it('runs headings 4 to 6 and shows them on', () => {
    vi.useFakeTimers();
    const { host, sent, editor } = opened([paragraph('deep')]);
    caretIn(host, 'deep');
    host.handle(format('heading5'));
    expect(editor.isActive('heading', { level: 5 })).toBe(true);
    vi.runOnlyPendingTimers();
    expect(ofType(sent, 'state').at(-1)!.active).toContain('heading5');
  });

  it('indents and outdents code lines with the bar’s buttons', () => {
    vi.useFakeTimers();
    const { host, sent, editor } = opened([
      { type: 'codeBlock', attrs: { language: null }, content: [text('a = 1')] },
    ]);
    caretIn(host, 'a = 1');
    vi.runOnlyPendingTimers();
    // Both on in code, as Tab and Shift+Tab are always the code's there.
    expect(ofType(sent, 'state').at(-1)).toMatchObject({
      inCode: true,
      canIndent: true,
      canOutdent: true,
    });
    host.handle(format('indent'));
    expect(editor.state.doc.firstChild!.textContent).toBe('  a = 1');
    host.handle(format('outdent'));
    expect(editor.state.doc.firstChild!.textContent).toBe('a = 1');
  });
});

describe('toggles remembered per note (ED8)', () => {
  const toggle = (title: string, collapsed: boolean): JSONContent => ({
    type: 'callout',
    attrs: { type: 'note', title, foldable: true, collapsed },
    content: [paragraph('inside')],
  });

  it('opens toggles as the app says this phone left them, and reports each change', () => {
    const parts = page();
    // Built as another device would, so the note opens with its toggles already there.
    const seed = opened([toggle('Details', true), toggle('More', false)]);
    const update = toBase64(seed.host.editor!.replica.encodeStateAsUpdate());
    seed.host.close();
    parts.host.handle(
      message({ type: 'folds', folds: { 'note|Details|0': true, 'note|More|0': false } }),
    );
    parts.host.handle(
      message({ type: 'open', synced: [{ id: '1', update }], pending: [], editable: true }),
    );
    const callouts = [...parts.body.querySelectorAll<HTMLElement>('[data-foldable="true"]')];
    expect(callouts.map((each) => each.dataset['open'])).toEqual(['true', 'false']);

    callouts[0]!.querySelector<HTMLButtonElement>('[aria-label="Collapse Toggle"]')!.click();
    expect(ofType(parts.sent, 'folds').at(-1)).toEqual({
      v: 1,
      type: 'folds',
      noteId: NOTE,
      folds: { 'note|More|0': false, 'note|Details|0': false },
    });
  });

  it('forgets toggles sent for another note', () => {
    const parts = page();
    const seed = opened([toggle('Details', true)]);
    const update = toBase64(seed.host.editor!.replica.encodeStateAsUpdate());
    seed.host.close();
    parts.host.handle({
      v: 1,
      type: 'folds',
      noteId: '01JD2Z7Q8R4T6Y8W0E2R4T6YB9',
      folds: { 'note|Details|0': true },
    });
    parts.host.handle(
      message({ type: 'open', synced: [{ id: '1', update }], pending: [], editable: true }),
    );
    expect(parts.body.querySelector<HTMLElement>('[data-foldable="true"]')!.dataset['open']).toBe(
      'false',
    );
  });
});

describe('counts (NT24)', () => {
  it('counts the note once typing pauses, and the selection when text is selected', () => {
    vi.useFakeTimers();
    const { host, sent, editor } = opened([paragraph("Don't plant before May.")]);
    vi.advanceTimersByTime(COUNT_DELAY_MS);
    expect(ofType(sent, 'counts').at(-1)).toEqual({
      v: 1,
      type: 'counts',
      noteId: NOTE,
      words: 4,
      characters: 23,
      minutes: 1,
      selection: null,
    });
    const before = ofType(sent, 'counts').length;
    editor.commands.insertContent(' Then wait');
    vi.advanceTimersByTime(COUNT_DELAY_MS - 1);
    expect(ofType(sent, 'counts')).toHaveLength(before);
    vi.advanceTimersByTime(1);
    expect(ofType(sent, 'counts').at(-1)).toMatchObject({ words: 6 });

    caretIn(host, 'plant', 0, 5);
    vi.advanceTimersByTime(SELECTION_COUNT_MS);
    expect(ofType(sent, 'counts').at(-1)!.selection).toEqual({ words: 1, characters: 5 });
  });
});
