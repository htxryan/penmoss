/**
 * The editor side of the Android bridge (T32, A282): the page builds the note
 * from the app's stored bytes, sends every local edit back as bytes, never
 * echoes what the app gave it, and merges the synced updates for the app.
 */
import { NOTE_ROOT } from '@penmoss/sync-client';
import { initNote, readTitle, setTitle } from '@penmoss/sync-client/note';
import { createYjs14Replica, type Yjs14Replica } from '@penmoss/sync-client/yjs14';
import * as Y from '@y/y';
import { fromBase64, toBase64 } from 'lib0/buffer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as core from '@penmoss/core';
import { periodicNote } from '@penmoss/editor/periodic';
import { EDIT_IDLE_MS, EDIT_MAX_WAIT_MS, EditorHost, TEXT_IDLE_MS } from '../src/host';
import { capNoteText } from '@penmoss/core/note-text';
import type { FromEditor, ToEditor } from '../src/protocol';
import fixture from '../../contract/periodic-fixture.json';

const NOTE = '01JD2Z7Q8R4T6Y8W0E2R4T6YB1';

function page() {
  const root = document.createElement('main');
  root.hidden = true;
  // The page's title field wraps a long title (T39): a textarea, kept to one paragraph.
  const title = document.createElement('textarea');
  const body = document.createElement('div');
  const unsupported = document.createElement('pre');
  root.append(title, body, unsupported);
  document.body.append(root);
  const sent: FromEditor[] = [];
  const host = new EditorHost({ root, title, body, unsupported }, (message) => sent.push(message));
  hosts.push(host);
  return { host, sent, root, title, body, unsupported };
}

const hosts: EditorHost[] = [];
afterEach(() => {
  for (const host of hosts.splice(0)) host.close();
  document.body.replaceChildren();
});

/** A note on "the server": its title and one paragraph. */
function serverNote(title: string, text: string): Yjs14Replica {
  const replica = createYjs14Replica();
  initNote(replica.doc, { id: NOTE, created: '2026-10-23T10:00:00-05:00', kind: 'note' }, title);
  if (text) {
    // As the @y/prosemirror binding lays a paragraph out.
    replica.doc.transact(() => {
      const paragraph = new Y.Node('paragraph');
      replica.doc.get(NOTE_ROOT).push([paragraph]);
      paragraph.insert(0, text);
    });
  }
  return replica;
}

/** The changes since `before` as one update, as the server would send them. */
function since(replica: Yjs14Replica, before: Uint8Array): string {
  return toBase64(Y.encodeStateAsUpdate(replica.doc, before));
}

const open = (
  synced: string[],
  pending: string[] = [],
  editable = true,
): Extract<ToEditor, { type: 'open' }> => ({
  v: 1,
  type: 'open',
  noteId: NOTE,
  synced: synced.map((update, i) => ({ id: `s${i}`, update })),
  pending: pending.map((update, i) => ({ id: `p${i}`, update })),
  editable,
});

describe('EditorHost', () => {
  it('says ready, then opens a note from stored bytes and reports its title', () => {
    const { host, sent, root, title } = page();
    host.start();
    const server = serverNote('Groceries', 'eggs');
    host.handle(open([toBase64(server.encodeStateAsUpdate())]));

    expect(sent).toEqual([
      { v: 1, type: 'ready' },
      {
        v: 1,
        type: 'opened',
        noteId: NOTE,
        title: 'Groceries',
        compacted: null,
        compactedPending: null,
      },
      // The note's frontmatter tags follow at once (T38).
      { v: 1, type: 'tags', noteId: NOTE, tags: [] },
      // And its details for the Info sheet (T40 P7, NT23).
      {
        v: 1,
        type: 'noteInfo',
        noteId: NOTE,
        created: '2026-10-23T10:00:00-05:00',
        kind: 'note',
        period: null,
        fields: [
          { key: 'id', value: NOTE },
          { key: 'title', value: 'Groceries' },
          { key: 'created', value: '2026-10-23T10:00:00-05:00' },
        ],
        links: [],
      },
      // And its comment threads (T48), none here.
      { v: 1, type: 'comments', noteId: NOTE, open: 0, active: null, threads: [] },
    ]);
    expect(root.hidden).toBe(false);
    expect(title.value).toBe('Groceries');
    expect(host.editor).not.toBeNull();
  });

  it('merges several synced updates into one for the app, leaving pending edits apart', () => {
    const { host, sent } = page();
    const server = serverNote('Plan', '');
    const first = toBase64(server.encodeStateAsUpdate());
    const before = server.encodeStateVector();
    setTitle(server.doc, 'Plan for Saturday');
    const second = since(server, before);

    // An edit this device made that the server has not confirmed.
    const phone = createYjs14Replica();
    phone.applyUpdate(server.encodeStateAsUpdate());
    const phoneBefore = phone.encodeStateVector();
    setTitle(phone.doc, 'Plan for Saturday morning');
    const pending = since(phone, phoneBefore);

    host.handle(open([first, second], [pending]));
    const opened = sent.find((message) => message.type === 'opened');
    expect(opened).toMatchObject({ title: 'Plan for Saturday morning' });
    const compacted = (opened as Extract<FromEditor, { type: 'opened' }>).compacted!;
    expect(compacted.replaces).toEqual(['s0', 's1']);
    // The merged update is the synced state only: the pending title is not in it.
    const merged = createYjs14Replica();
    merged.applyUpdate(fromBase64(compacted.update));
    expect(readTitle(merged.doc)).toBe('Plan for Saturday');
    // Nothing the app gave the page is sent back as a local edit.
    expect(sent.filter((message) => message.type === 'update')).toEqual([]);
  });

  it('keeps a pasted title on one line, as the single-line field did (T39)', () => {
    const { host, sent, title } = page();
    host.handle(open([toBase64(serverNote('Draft', '').encodeStateAsUpdate())]));

    title.value = 'Shopping\nlist\r\nfor Sunday';
    title.setSelectionRange(title.value.length, title.value.length);
    title.dispatchEvent(new Event('input'));

    expect(title.value).toBe('Shopping list for Sunday');
    expect(title.selectionStart).toBe(title.value.length);
    expect(sent).toContainEqual({
      v: 1,
      type: 'title',
      noteId: NOTE,
      title: 'Shopping list for Sunday',
    });
  });

  it('drops control characters typed or pasted into the title, as the web does (T39)', () => {
    const { host, title } = page();
    host.handle(open([toBase64(serverNote('Draft', '').encodeStateAsUpdate())]));

    title.value = 'Bills\u0007 for\u202e May';
    title.setSelectionRange(8, 8);
    title.dispatchEvent(new Event('input'));

    expect(title.value).toBe('Bills for May');
    // The caret stays after "Bills f": one character earlier, for the dropped bell.
    expect(title.selectionStart).toBe(7);
  });

  it('puts the caret in the title for focusTitle, to rename the note from a list (T40 P4, NT10)', () => {
    const { host, title } = page();
    host.start();
    host.handle(open([toBase64(serverNote('Groceries', 'eggs').encodeStateAsUpdate())]));
    title.blur();
    expect(document.activeElement).not.toBe(title);
    host.handle({ v: 1, type: 'focusTitle', noteId: NOTE });
    expect(document.activeElement).toBe(title);
    // For another note, or a read-only one, the title is left alone.
    host.handle({ v: 1, type: 'focusTitle', noteId: '01JD2Z7Q8R4T6Y8W0E2R4T6YB2' });
    expect(document.activeElement).toBe(title);
  });

  it('takes Enter in the title as next, never as a line break, read-only too (T39)', () => {
    const { host, title } = page();
    host.handle(open([toBase64(serverNote('Draft', 'Body').encodeStateAsUpdate())], [], false));
    const enter = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true });
    title.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(true);
  });

  it('puts the caret at the end of the note for a tap below its text (T39 pass 2, A527)', () => {
    const { host, title } = page();
    host.handle(open([toBase64(serverNote('Short', 'Only a line').encodeStateAsUpdate())]));
    const editor = host.editor!.editor;
    editor.commands.setTextSelection(1);
    const end = editor.state.doc.content.size - 1;
    const tap = (target: Element, clientY = 900) =>
      target.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true, clientY, button: 0 }),
      );
    // Beside or above the text: nothing moves.
    tap(title);
    expect(editor.state.selection.from).toBe(1);
    const link = document.createElement('a');
    document.body.append(link);
    tap(link);
    expect(editor.state.selection.from).toBe(1);
    // Below it, on the empty page: the caret goes to the end, to type on.
    tap(document.documentElement);
    expect(editor.state.selection.from).toBe(end);
  });

  /** Types as the keyboard does, through the editor's input handlers (menus open on `/` and `[[`). */
  const typeInto = (editor: NonNullable<EditorHost['editor']>['editor'], text: string) => {
    const { view } = editor;
    for (const char of text) {
      const { from, to } = view.state.selection;
      const handled = view.someProp('handleTextInput', (handle) =>
        handle(view, from, to, char, () => view.state.tr.insertText(char, from, to)),
      );
      if (!handled) view.dispatch(view.state.tr.insertText(char, from, to));
    }
  };

  /** A tap on a menu option, low on the screen: below the note's text in a short note. */
  const tapOption = (label: string) => {
    const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((each) =>
      each.textContent?.includes(label),
    );
    expect(option, label).toBeDefined();
    for (const type of ['mousedown', 'mouseup', 'click'])
      option!.dispatchEvent(
        new MouseEvent(type, { bubbles: true, cancelable: true, clientY: 900, button: 0 }),
      );
  };

  /** A short note of three lines, the caret at the start of the empty middle one. */
  const threeLines = () => {
    const { host } = page();
    host.handle(open([toBase64(serverNote('Short', 'First line').encodeStateAsUpdate())]));
    const editor = host.editor!.editor;
    editor.commands.insertContentAt(editor.state.doc.content.size, [
      { type: 'paragraph' },
      { type: 'paragraph', content: [{ type: 'text', text: 'Last line' }] },
    ]);
    const middle = editor.state.doc.child(0).nodeSize + 1;
    editor.commands.setTextSelection(middle);
    return { host, editor, middle };
  };

  it("applies a slash-menu choice where it was typed, not at the note's end (A527)", () => {
    const { editor, middle } = threeLines();
    typeInto(editor, '/head');
    tapOption('Heading 1');
    const { doc, selection } = editor.state;
    expect(doc.child(1).type.name).toBe('heading');
    expect(doc.child(2).textContent).toBe('Last line');
    // The caret stays in the new heading, on the middle line.
    expect(selection.from).toBe(middle);
    expect(doc.resolve(selection.from).parent.type.name).toBe('heading');
  });

  it("links a [[ choice where it was typed, not at the note's end (A527)", () => {
    const { host, editor, middle } = threeLines();
    host.handle({ v: 1, type: 'directory', notes: [{ id: 'n2', title: 'Garden plan' }] });
    typeInto(editor, '[[gar');
    tapOption('Garden plan');
    const { doc, selection } = editor.state;
    // The link (a wikilink node to the note's id) is on the middle line.
    expect(JSON.stringify(doc.child(1).toJSON())).toContain('n2');
    expect(doc.child(2).textContent).toBe('Last line');
    // The caret is on the middle line, after the link.
    expect(selection.from).toBeGreaterThan(middle);
    expect(selection.from).toBeLessThan(middle + doc.child(1).nodeSize);
  });

  it('leaves a read-only note alone when tapped below its text', () => {
    const { host } = page();
    host.handle(open([toBase64(serverNote('Read', 'Only').encodeStateAsUpdate())], [], false));
    const editor = host.editor!.editor;
    const before = editor.state.selection.from;
    document.documentElement.dispatchEvent(
      new MouseEvent('click', { bubbles: true, clientY: 900, button: 0 }),
    );
    expect(editor.state.selection.from).toBe(before);
  });

  it('sizes the title to its text where the WebView has no field-sizing (T39)', async () => {
    vi.stubGlobal('CSS', { supports: () => false });
    try {
      const { host, title } = page();
      // happy-dom lays nothing out: a long title is two lines high, a short one one.
      Object.defineProperty(title, 'scrollHeight', {
        get: () => (title.value.length > 20 ? 80 : 40),
      });
      const server = serverNote('Short', '');
      host.handle(open([toBase64(server.encodeStateAsUpdate())]));
      expect(title.style.height).toBe('40px');

      // Rewritten from another device.
      const before = server.encodeStateVector();
      setTitle(server.doc, 'A much longer title from the Mac');
      host.handle({ v: 1, type: 'remote', noteId: NOTE, update: since(server, before) });
      await Promise.resolve();
      expect(title.value).toBe('A much longer title from the Mac');
      expect(title.style.height).toBe('80px');

      title.value = 'Short again';
      title.dispatchEvent(new Event('input'));
      expect(title.style.height).toBe('40px');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('sends local edits as update bytes that rebuild the edit elsewhere', () => {
    const { host, sent, title } = page();
    const server = serverNote('Draft', '');
    host.handle(open([toBase64(server.encodeStateAsUpdate())]));

    title.value = 'Draft two';
    title.dispatchEvent(new Event('input'));
    host.editor!.editor.commands.insertContent('typed on the phone');
    host.flush();

    const updates = sent.flatMap((message) => (message.type === 'update' ? [message.update] : []));
    expect(updates.length).toBeGreaterThan(0);
    for (const update of updates) server.applyUpdate(fromBase64(update));
    expect(readTitle(server.doc)).toBe('Draft two');
    expect(server.plainText()).toContain('typed on the phone');
    expect(sent).toContainEqual({ v: 1, type: 'title', noteId: NOTE, title: 'Draft two' });
  });

  it('merges a burst of edits into one update, and sends what waits when the note closes', () => {
    vi.useFakeTimers();
    try {
      const { host, sent } = page();
      const server = serverNote('Burst', '');
      host.handle(open([toBase64(server.encodeStateAsUpdate())]));
      const { editor } = host.editor!;
      for (const word of ['one ', 'two ', 'three']) editor.commands.insertContent(word);
      expect(sent.filter((message) => message.type === 'update')).toEqual([]);
      vi.advanceTimersByTime(EDIT_IDLE_MS);
      const first = sent.filter((message) => message.type === 'update');
      expect(first).toHaveLength(1);

      editor.commands.insertContent(' four');
      host.handle({ v: 1, type: 'flush', noteId: NOTE });
      expect(sent.filter((message) => message.type === 'update')).toHaveLength(2);
      editor.commands.insertContent('!');
      host.handle({ v: 1, type: 'close', noteId: NOTE });
      // The last edit goes before the acknowledgement, and the note's text with it (FD4).
      expect(sent.slice(-3).map((message) => message.type)).toEqual(['update', 'text', 'closed']);
      const updates = sent.flatMap((message) =>
        message.type === 'update' ? [message.update] : [],
      );
      expect(updates).toHaveLength(3);
      for (const update of updates) server.applyUpdate(fromBase64(update));
      expect(server.plainText()).toBe('one two three four!');
    } finally {
      vi.useRealTimers();
    }
  });

  it('sends typing that never pauses every EDIT_MAX_WAIT_MS, not once per pause only (A289)', () => {
    vi.useFakeTimers();
    try {
      const { host, sent } = page();
      const server = serverNote('Long', '');
      host.handle(open([toBase64(server.encodeStateAsUpdate())]));
      const { editor } = host.editor!;
      // Ten seconds of typing, a character every 100 ms: never a pause of EDIT_IDLE_MS.
      for (let i = 0; i < 100; i++) {
        editor.commands.insertContent('x');
        vi.advanceTimersByTime(100);
      }
      const during = sent.filter((message) => message.type === 'update').length;
      expect(during).toBeGreaterThanOrEqual(10_000 / EDIT_MAX_WAIT_MS - 1);
      expect(during).toBeLessThanOrEqual(10_000 / EDIT_MAX_WAIT_MS + 1);
      vi.advanceTimersByTime(EDIT_IDLE_MS);
      const updates = sent.flatMap((message) =>
        message.type === 'update' ? [message.update] : [],
      );
      for (const update of updates) server.applyUpdate(fromBase64(update));
      expect(server.plainText()).toBe('x'.repeat(100));
    } finally {
      vi.useRealTimers();
    }
  });

  it('merges stored edits the app asks it to, open note or not', () => {
    const { host, sent } = page();
    const server = serverNote('Offline', '');
    const phone = createYjs14Replica();
    phone.applyUpdate(server.encodeStateAsUpdate());
    const edits = ['first', 'second', 'third'].map((text, i) => {
      const before = phone.encodeStateVector();
      setTitle(phone.doc, text);
      return { id: String(40 + i), update: since(phone, before) };
    });
    host.handle({ v: 1, type: 'compact', noteId: NOTE, updates: edits });
    const reply = sent.at(-1) as Extract<FromEditor, { type: 'compacted' }>;
    expect(reply).toMatchObject({ type: 'compacted', noteId: NOTE });
    expect(reply.compacted.replaces).toEqual(['40', '41', '42']);
    server.applyUpdate(fromBase64(reply.compacted.update));
    expect(readTitle(server.doc)).toBe('third');
    // Bytes that are not Yjs updates are reported, never merged.
    host.handle({
      v: 1,
      type: 'compact',
      noteId: NOTE,
      updates: [...edits, { id: '43', update: 'AQID' }],
    });
    expect(sent.at(-1)).toMatchObject({ type: 'error', noteId: NOTE });
  });

  it('merges several pending edits into one for the app', () => {
    const { host, sent } = page();
    const server = serverNote('Offline', '');
    const phone = createYjs14Replica();
    phone.applyUpdate(server.encodeStateAsUpdate());
    const edits = ['first', 'second'].map((text) => {
      const before = phone.encodeStateVector();
      setTitle(phone.doc, text);
      return since(phone, before);
    });
    host.handle(open([toBase64(server.encodeStateAsUpdate())], edits));
    const opened = sent.find((message) => message.type === 'opened') as Extract<
      FromEditor,
      { type: 'opened' }
    >;
    expect(opened.compacted).toBeNull();
    expect(opened.compactedPending?.replaces).toEqual(['p0', 'p1']);
    server.applyUpdate(fromBase64(opened.compactedPending!.update));
    expect(readTitle(server.doc)).toBe('second');
  });

  it('reports the open note text once typing pauses for long, for the offline index (T40 P6, FD4)', () => {
    vi.useFakeTimers();
    try {
      const { host, sent } = page();
      const server = serverNote('Index me', 'first line');
      host.handle(open([toBase64(server.encodeStateAsUpdate())]));
      const { editor } = host.editor!;
      editor.commands.insertContentAt(
        editor.state.doc.content.size,
        '<h2>Desserts</h2><p>lemon tart for #baking and #Area/Kitchen</p>',
      );
      vi.advanceTimersByTime(EDIT_IDLE_MS);
      // The edit went at once; its text waits for a longer pause.
      expect(sent.filter((message) => message.type === 'text')).toEqual([]);
      vi.advanceTimersByTime(TEXT_IDLE_MS);
      const texts = sent.filter((message) => message.type === 'text');
      expect(texts).toHaveLength(1);
      const replica = createYjs14Replica();
      replica.applyUpdate(server.encodeStateAsUpdate());
      for (const message of sent)
        if (message.type === 'update') replica.applyUpdate(fromBase64(message.update));
      // With the headings (the index's own column) and every tag, inline ones too (S5, S6).
      expect(texts[0]).toEqual({
        v: 1,
        type: 'text',
        noteId: NOTE,
        text: replica.plainText(),
        headings: 'Desserts',
        tags: ['area/kitchen', 'baking'],
      });
      expect((texts[0] as { text: string }).text).toContain('lemon tart');
      // Nothing changed since: closing sends no text again.
      host.handle({ v: 1, type: 'close', noteId: NOTE });
      expect(sent.filter((message) => message.type === 'text')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports no text for what came from the app, and caps a long one as the server does (FD4)', () => {
    vi.useFakeTimers();
    try {
      const { host, sent } = page();
      const server = serverNote('Remote', '');
      host.handle(open([toBase64(server.encodeStateAsUpdate())]));
      const before = server.encodeStateVector();
      setTitle(server.doc, 'Changed on the Mac');
      host.handle({ v: 1, type: 'remote', noteId: NOTE, update: since(server, before) });
      vi.advanceTimersByTime(TEXT_IDLE_MS * 2);
      host.handle({ v: 1, type: 'flush', noteId: NOTE });
      expect(sent.filter((message) => message.type === 'text')).toEqual([]);

      const { editor } = host.editor!;
      editor.commands.insertContent('é'.repeat(140_000));
      host.handle({ v: 1, type: 'flush', noteId: NOTE });
      const text = sent.filter((message) => message.type === 'text');
      expect(text).toHaveLength(1);
      const sentText = (text[0] as { text: string }).text;
      expect(sentText).toBe(capNoteText(sentText + 'é'.repeat(10)).slice(0, sentText.length));
      expect(new TextEncoder().encode(sentText).length).toBeLessThanOrEqual(256 * 1024);
    } finally {
      vi.useRealTimers();
    }
  });

  it('applies remote updates without echoing them, and reports a new title', () => {
    const { host, sent, title } = page();
    const server = serverNote('Old', '');
    host.handle(open([toBase64(server.encodeStateAsUpdate())]));
    const before = server.encodeStateVector();
    setTitle(server.doc, 'New from the Mac');
    host.handle({ v: 1, type: 'remote', noteId: NOTE, update: since(server, before) });

    expect(title.value).toBe('New from the Mac');
    expect(sent.filter((message) => message.type === 'update')).toEqual([]);
    expect(sent.at(-1)).toEqual({ v: 1, type: 'title', noteId: NOTE, title: 'New from the Mac' });
  });

  it('ignores a remote update for another note, and closes only the open note', () => {
    const { host, root, sent } = page();
    host.handle(open([toBase64(serverNote('Kept', '').encodeStateAsUpdate())]));
    host.handle({ v: 1, type: 'remote', noteId: 'another-note', update: 'AAA=' });
    host.handle({ v: 1, type: 'close', noteId: 'another-note' });
    expect(host.openNoteId).toBe(NOTE);
    host.handle({ v: 1, type: 'close', noteId: NOTE });
    expect(host.openNoteId).toBeNull();
    expect(root.hidden).toBe(true);
    // Each close is acknowledged, after the note's last edits, so the app can let go.
    expect(sent.filter((message) => message.type === 'closed')).toEqual([
      { v: 1, type: 'closed', noteId: 'another-note' },
      { v: 1, type: 'closed', noteId: NOTE },
    ]);
  });

  it('opens read-only when the app says so', () => {
    const { host, title } = page();
    host.handle(open([toBase64(serverNote('Locked', '').encodeStateAsUpdate())], [], false));
    expect(host.editor!.editor.isEditable).toBe(false);
    expect(title.readOnly).toBe(true);
  });

  it('reports bytes it cannot read instead of opening a broken note', () => {
    const { host, sent, root } = page();
    host.handle(open(['AQID']));
    expect(sent.at(-1)).toMatchObject({ type: 'error', noteId: NOTE });
    expect(host.openNoteId).toBeNull();
    expect(root.hidden).toBe(true);
  });

  it('answers a malformed message with an error', () => {
    const { host, sent } = page();
    host.receive('{"v":1,"type":"open"}');
    expect(sent).toEqual([
      {
        v: 1,
        type: 'error',
        noteId: null,
        message: 'The app sent a message this editor cannot read',
      },
    ]);
  });

  it('opens an inline #tag tapped while reading, or Ctrl-tapped while typing (T40 P6, TG5)', () => {
    const { host, sent } = page();
    host.handle(
      open([toBase64(serverNote('Tags', 'Soup for #Area/Cooking tonight').encodeStateAsUpdate())]),
    );
    const editor = host.editor!.editor;
    const tag = () => editor.view.dom.querySelector<HTMLElement>('.pm-tag')!;
    expect(tag().dataset['tag']).toBe('area/cooking');
    const tap = (init: MouseEventInit = {}) => {
      const down = new MouseEvent('mousedown', {
        bubbles: true,
        cancelable: true,
        button: 0,
        ...init,
      });
      tag().dispatchEvent(down);
      tag().dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init }),
      );
      return down.defaultPrevented;
    };
    const opened = () => sent.filter((message) => message.type === 'openTag');
    // Reading (the note not focused): the tap opens the tag, and does not focus the note.
    expect(editor.view.hasFocus()).toBe(false);
    expect(tap()).toBe(true);
    expect(opened()).toEqual([{ v: 1, type: 'openTag', noteId: NOTE, tag: 'area/cooking' }]);
    // Typing: a tap places the caret, as anywhere in the text; Ctrl-tap opens it.
    editor.view.focus();
    expect(editor.view.hasFocus()).toBe(true);
    expect(tap()).toBe(false);
    expect(opened()).toHaveLength(1);
    expect(tap({ ctrlKey: true })).toBe(true);
    expect(opened()).toHaveLength(2);
    // A tap elsewhere in the text sends nothing.
    editor.view.dom
      .querySelector('p')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
    expect(opened()).toHaveLength(2);
  });

  it('opens a #tag tapped once the keyboard is down, though the note keeps focus (review S8)', () => {
    const { host, sent } = page();
    host.handle(
      open([toBase64(serverNote('Tags', 'Soup for #soup tonight').encodeStateAsUpdate())]),
    );
    const editor = host.editor!.editor;
    const tag = editor.view.dom.querySelector<HTMLElement>('.pm-tag')!;
    const tap = () => {
      tag.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }),
      );
      tag.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    };
    const opened = () => sent.filter((message) => message.type === 'openTag');
    editor.view.focus();
    host.handle({ v: 1, type: 'ime', visible: true });
    tap();
    expect(opened()).toHaveLength(0);
    // Back or the swipe hides the keyboard and leaves the note focused.
    host.handle({ v: 1, type: 'ime', visible: false });
    expect(editor.view.hasFocus()).toBe(true);
    tap();
    expect(opened()).toEqual([{ v: 1, type: 'openTag', noteId: NOTE, tag: 'soup' }]);
  });

  it('opens a #tag tapped in a read-only note', () => {
    const { host, sent } = page();
    host.handle(open([toBase64(serverNote('Read', 'See #soup').encodeStateAsUpdate())], [], false));
    const tag = host.editor!.editor.view.dom.querySelector<HTMLElement>('.pm-tag')!;
    tag.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
    tag.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    expect(sent.filter((message) => message.type === 'openTag')).toEqual([
      { v: 1, type: 'openTag', noteId: NOTE, tag: 'soup' },
    ]);
  });

  it('opens wikilinks through the app', () => {
    const { host, sent } = page();
    host.handle(open([toBase64(serverNote('Links', '').encodeStateAsUpdate())]));
    const { editor } = host.editor!;
    const target = '01JD2Z7Q8R4T6Y8W0E2R4T6YB2';
    editor.commands.setContent({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'wikilink', attrs: { target: 'Other', noteId: target } }],
        },
      ],
    });
    let at = -1;
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === 'wikilink') at = pos;
    });
    const node = editor.state.doc.nodeAt(at)!;
    const event = new MouseEvent('click', { button: 0 });
    editor.view.someProp('handleClickOn', (handle) =>
      handle(editor.view, at, node, at, event, true),
    );
    expect(sent.at(-1)).toEqual({ v: 1, type: 'openNote', noteId: target });
  });
});

describe('periodic notes (T40 P5)', () => {
  /** The update bytes of the period's note, as the page would store them. */
  const periodicUpdate = (
    kind: 'daily' | 'weekly',
    period: string,
    template = '## Plan\n\n## Notes\n',
  ): string => toBase64(periodicNote(core, kind, period, template).update);

  /** A Yjs document of stored update bytes, to read what the note shows. */
  const bytesOf = (update: string): Y.Doc => {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, fromBase64(update));
    return doc;
  };

  const periodic = (
    kind: 'daily' | 'weekly',
    day: string | null,
    at: number,
    timeZone = 'America/Chicago',
    template = '## Plan\n\n## Notes\n',
  ): Extract<ToEditor, { type: 'createPeriodic' }> => ({
    v: 1,
    type: 'createPeriodic',
    kind,
    day,
    at,
    timeZone,
    template,
  });

  type FixtureCase = {
    kind: 'daily' | 'weekly';
    period: string;
    template: string;
    id: string;
    update: string;
  };
  const fixtureCase = (kind: string, period: string): FixtureCase =>
    (fixture as unknown as { cases: FixtureCase[] }).cases.find(
      (entry) => entry.kind === kind && entry.period === period,
    )!;

  /** The page's answer: `createPeriodic` loads the note's codec lazily (review S5). */
  const madeOf = async (sent: FromEditor[]) =>
    vi.waitFor(() => {
      const answer = sent.find((message) => message.type === 'createdPeriodic');
      if (answer?.type !== 'createdPeriodic') throw new Error('no createdPeriodic yet');
      return answer;
    });

  it('builds the daily note for an explicit day with the fixture bytes', async () => {
    const expected = fixtureCase('daily', '2026-10-21');
    const { host, sent } = page();
    host.handle(
      periodic(
        'daily',
        '2026-10-21',
        Date.parse('2026-10-21T13:10:00Z'),
        'America/Chicago',
        expected.template,
      ),
    );
    const answer = await madeOf(sent);
    expect(answer).toMatchObject({ v: 1, kind: 'daily', period: '2026-10-21' });
    // The shared fixture's id and update bytes: what the web builds, byte for byte (review S4).
    expect(answer.note).toEqual({ id: expected.id, title: '2026-10-21', update: expected.update });
    expect(readTitle(bytesOf(answer.note.update))).toBe('2026-10-21');
  });

  it('builds a weekly note from a day in its week with the fixture bytes', async () => {
    const expected = fixtureCase('weekly', '2026-W43');
    const { host, sent } = page();
    host.handle(
      periodic(
        'weekly',
        '2026-10-21',
        Date.parse('2026-10-21T13:10:00Z'),
        'America/Chicago',
        expected.template,
      ),
    );
    const answer = await madeOf(sent);
    expect(answer).toMatchObject({ kind: 'weekly', period: '2026-W43', date: '2026-10-19' });
    expect(answer.note).toEqual({ id: expected.id, title: '2026-W43', update: expected.update });
  });

  it('builds today from the synced zone at a fixed instant with the fixture bytes', async () => {
    const expected = fixtureCase('daily', '2026-10-21');
    const { host, sent } = page();
    // 13:10 UTC on the 21st is the 21st in Chicago.
    host.handle(
      periodic(
        'daily',
        null,
        Date.parse('2026-10-21T13:10:00Z'),
        'America/Chicago',
        expected.template,
      ),
    );
    const answer = await madeOf(sent);
    expect(answer.note.update).toBe(expected.update);
    // Another template is another note's bytes: the page fills the template it was given.
    const { host: other, sent: otherSent } = page();
    other.handle(
      periodic('daily', null, Date.parse('2026-10-21T13:10:00Z'), 'America/Chicago', '## Other\n'),
    );
    expect((await madeOf(otherSent)).note.update).not.toBe(expected.update);
  });

  it('reads today in the synced time zone, never the phone zone', async () => {
    const { host, sent } = page();
    const zone = process.env.TZ;
    process.env.TZ = 'Asia/Tokyo';
    try {
      // 04:10 UTC is the 20th in Chicago and the 21st in Tokyo and UTC.
      host.handle(periodic('daily', null, Date.parse('2026-10-21T04:10:00Z')));
    } finally {
      process.env.TZ = zone;
    }
    expect(await madeOf(sent)).toMatchObject({
      kind: 'daily',
      period: '2026-10-20',
      note: { title: '2026-10-20' },
    });
  });

  it('resolves a weekly note to the day ISO week, and falls back for an unknown zone', async () => {
    const { host, sent } = page();
    host.handle(periodic('weekly', '2026-10-21', Date.parse('2026-10-21T13:10:00Z')));
    expect(await madeOf(sent)).toMatchObject({
      kind: 'weekly',
      period: '2026-W43',
      date: '2026-10-19',
      note: { title: '2026-W43' },
    });
    const { host: fallback, sent: fallen } = page();
    fallback.handle(periodic('weekly', null, Date.parse('2026-10-21T13:10:00Z'), 'Mars/Olympus'));
    // America/Chicago by default, as the web reads it.
    expect(await madeOf(fallen)).toMatchObject({
      kind: 'weekly',
      period: '2026-W43',
    });
  });

  it('answers an error for a day that is no date', () => {
    const { host, sent } = page();
    host.receive(
      '{"v":1,"type":"createPeriodic","kind":"daily","day":"2026-13-40","at":0,"timeZone":"America/Chicago","template":"x"}',
    );
    const error = sent.find((message) => message.type === 'error');
    if (error?.type !== 'error') throw new Error('expected an error');
    expect(sent).toHaveLength(1);
    expect(error.noteId).toBeNull();
    expect(error.message).toContain('The daily note could not be made');
    // An untagged request's error names none.
    expect(error).not.toHaveProperty('request');
  });

  it('names the tagged request an error answers (T40 P9, P5 review N7)', async () => {
    const { host, sent } = page();
    host.receive(
      '{"v":1,"type":"createPeriodic","kind":"daily","day":"2026-02-30","at":0,"timeZone":"America/Chicago","template":"x","request":"p-7"}',
    );
    await vi.waitFor(() => expect(sent.some((message) => message.type === 'error')).toBe(true));
    expect(sent.find((message) => message.type === 'error')).toMatchObject({
      noteId: null,
      request: 'p-7',
    });
    // An error that answers no request (a message the page cannot read) names none.
    host.receive('{"v":1,"type":"launch"}');
    expect(sent.at(-1)).toEqual({
      v: 1,
      type: 'error',
      noteId: null,
      message: 'The app sent a message this editor cannot read',
    });
  });

  it('names a daily note period and neighbours in the web words', () => {
    const { host, sent } = page();
    host.handle(open([periodicUpdate('daily', '2026-10-21')]));
    host.handle({ v: 1, type: 'periodicNav', noteId: NOTE });
    expect(sent.at(-1)).toEqual({
      v: 1,
      type: 'periodicNav',
      noteId: NOTE,
      nav: {
        kind: 'daily',
        period: '2026-10-21',
        label: 'Wednesday 21 October 2026',
        prev: {
          date: '2026-10-20',
          label: '2026-10-20',
          full: 'Tuesday 20 October 2026',
          period: '2026-10-20',
        },
        next: {
          date: '2026-10-22',
          label: '2026-10-22',
          full: 'Thursday 22 October 2026',
          period: '2026-10-22',
        },
        // Each target names its note's period, so the app can mark one it holds (P5 review N4).
        week: {
          date: '2026-10-19',
          label: 'Week 2026-W43',
          full: 'Week of Monday 19 October 2026',
          period: '2026-W43',
        },
        days: null,
      },
    });
  });

  it('names a weekly note seven days Monday to Sunday', () => {
    const { host, sent } = page();
    host.handle(open([periodicUpdate('weekly', '2026-W43', '## Goals\n\n## Review\n')]));
    host.handle({ v: 1, type: 'periodicNav', noteId: NOTE });
    const answer = sent.at(-1);
    if (answer?.type !== 'periodicNav' || !answer.nav) {
      throw new Error('expected a periodicNav');
    }
    const nav = answer.nav;
    if (!nav.days) throw new Error('expected a weekly periodicNav');
    expect(nav.days.map((day) => day.date)).toEqual([
      '2026-10-19',
      '2026-10-20',
      '2026-10-21',
      '2026-10-22',
      '2026-10-23',
      '2026-10-24',
      '2026-10-25',
    ]);
    expect(nav.days[2]).toMatchObject({
      label: 'Wed 21',
      date: '2026-10-21',
      period: '2026-10-21',
    });
    expect(nav.prev).toMatchObject({ date: '2026-10-12', period: '2026-W42' });
    expect(nav.next).toMatchObject({ date: '2026-10-26', period: '2026-W44' });
  });

  it('answers no period for a regular note, or nothing open', () => {
    const { host, sent } = page();
    host.handle(open([toBase64(serverNote('Groceries', 'eggs').encodeStateAsUpdate())]));
    host.handle({ v: 1, type: 'periodicNav', noteId: NOTE });
    expect(sent.at(-1)).toEqual({ v: 1, type: 'periodicNav', noteId: NOTE, nav: null });
    const { host: empty, sent: none } = page();
    empty.handle({ v: 1, type: 'periodicNav', noteId: NOTE });
    expect(none.at(-1)).toEqual({ v: 1, type: 'periodicNav', noteId: NOTE, nav: null });
  });
});
