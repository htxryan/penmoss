/**
 * The editor page's T33 side: what long-form writing on the phone needs from
 * the bridge. The formatting bar's commands and the state it shows (A301),
 * Back closing a menu (A302), wikilinks from the phone's note list (A303),
 * pictures through the app (A304), the theme (A305), conflict copies
 * (A306), and the IME and caret care (A307).
 */
import { NOTE_ROOT } from '@penmoss/sync-client';
import {
  initNote,
  readNoteNotebook,
  readTitle,
  setNoteNotebook,
  setTitle,
} from '@penmoss/sync-client/note';
import { CONFLICT_SUFFIX } from '@penmoss/sync-client/records';
import { createYjs14Replica, type Yjs14Replica } from '@penmoss/sync-client/yjs14';
import { NORD, PENMOSS } from '@penmoss/ui/theme';
import * as Y from '@y/y';
import { fromBase64, toBase64 } from 'lib0/buffer';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { press, select, type } from '../../../../packages/editor/test/support/editor';
import { ATTACHMENT_URL_PREFIX, EditorHost, HOLD_MAX_MS, normaliseHref } from '../src/host';
import { parseToEditor, type FormatCommand, type FromEditor, type ToEditor } from '../src/protocol';

const NOTE = '01JD2Z7Q8R4T6Y8W0E2R4T6YB1';
const OTHER = '01JD2Z7Q8R4T6Y8W0E2R4T6YB2';
/** A notebook's folder id (T43). */
const WORK = '01JD2Z7Q8R4T6Y8W0E2R4T6YW1';
const NOW = new Date('2026-10-23T15:00:00Z');

const hosts: EditorHost[] = [];
afterEach(() => {
  for (const host of hosts.splice(0)) host.close();
  document.body.replaceChildren();
  document.documentElement.removeAttribute('style');
  document.documentElement.removeAttribute('data-theme');
});

function page() {
  const root = document.createElement('main');
  root.hidden = true;
  const title = document.createElement('input');
  const body = document.createElement('div');
  const unsupported = document.createElement('pre');
  root.append(title, body, unsupported);
  document.body.append(root);
  const sent: FromEditor[] = [];
  /** Every message in order, with pictures' bytes as the app receives them. */
  const log: Array<FromEditor | Uint8Array> = [];
  const host = new EditorHost(
    { root, title, body, unsupported },
    (message) => {
      sent.push(message);
      log.push(message);
    },
    { now: () => NOW, postBytes: (bytes) => log.push(bytes) },
  );
  hosts.push(host);
  return { host, sent, log, root, title, body };
}

function note(title: string, text = ''): Yjs14Replica {
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

function opened(text = '', notebook?: string) {
  const parts = page();
  const server = note('Writing', text);
  parts.host.handle({
    v: 1,
    type: 'open',
    noteId: NOTE,
    synced: [{ id: '1', update: toBase64(server.encodeStateAsUpdate()) }],
    pending: [],
    editable: true,
    ...(notebook ? { notebook } : {}),
  });
  const { editor } = parts.host.editor!;
  return { ...parts, server, editor, view: editor.view };
}

const format = (command: FormatCommand, href?: string): ToEditor =>
  href === undefined
    ? { v: 1, type: 'format', noteId: NOTE, command }
    : { v: 1, type: 'format', noteId: NOTE, command, href };

type State = Extract<FromEditor, { type: 'state' }>;
const states = (sent: FromEditor[]) =>
  sent.filter((message): message is State => message.type === 'state');
const lastState = (sent: FromEditor[]) => states(sent).at(-1);

/** The note's body as markdown-ish JSON, for asserting structure. */
const json = (host: EditorHost) => JSON.stringify(host.editor!.editor.getJSON());

describe('the formatting bar (A301)', () => {
  it('runs the shared editor commands on the selection', () => {
    const { host, view } = opened('make this bold');
    select(view, 6, 10);
    host.handle(format('bold'));
    expect(json(host)).toContain('"marks":[{"type":"bold"}]');
    host.handle(format('heading2'));
    expect(host.editor!.editor.isActive('heading', { level: 2 })).toBe(true);
    host.handle(format('paragraph'));
    host.handle(format('taskList'));
    expect(host.editor!.editor.isActive('taskList')).toBe(true);
    host.handle(format('codeBlock'));
    expect(host.editor!.editor.isActive('codeBlock')).toBe(true);
  });

  it('indents and outdents list items', () => {
    const { host, view } = opened();
    host.handle(format('bulletList'));
    type(view, 'first\nsecond');
    host.handle(format('indent'));
    expect(json(host).match(/"bulletList"/g)).toHaveLength(2);
    host.handle(format('outdent'));
    expect(json(host).match(/"bulletList"/g)).toHaveLength(1);
  });

  it('leaves a paragraph outside a list as it is when asked to indent', () => {
    const { host } = opened('just a paragraph');
    const before = json(host);
    host.handle(format('indent'));
    host.handle(format('outdent'));
    expect(json(host)).toBe(before);
  });

  it('undoes and redoes this editor’s own changes only', () => {
    // The note as stored is not undoable: only what is done here.
    const { host } = opened('a list item');
    host.handle(format('undo'));
    expect(host.editor!.editor.state.doc.textContent).toBe('a list item');
    host.handle(format('bulletList'));
    expect(host.editor!.editor.isActive('bulletList')).toBe(true);
    host.handle(format('undo'));
    expect(json(host)).not.toContain('"bulletList"');
    expect(host.editor!.editor.state.doc.textContent).toBe('a list item');
    host.handle(format('redo'));
    expect(json(host)).toContain('"bulletList"');
  });

  it('links the selection, links a bare address as its own text, and removes a link', () => {
    const { host, view, sent } = opened('read the docs');
    select(view, 10, 14);
    host.handle(format('link', 'penmoss.app/docs'));
    expect(json(host)).toContain('"href":"https://penmoss.app/docs"');

    select(view, 1);
    host.handle(format('link', 'https://example.com'));
    const text = host.editor!.editor.state.doc.textContent;
    expect(text.startsWith('https://example.com')).toBe(true);
    // Typing after the inserted link is not linked.
    type(view, ' x');
    expect(json(host)).toContain(
      '"text":"https://example.com"},{"type":"text","text":" xread the "}',
    );

    select(view, 3);
    host.handle(format('link', ''));
    expect(json(host)).not.toContain('example.com"');

    // A script address is refused, with a word to the person.
    select(view, 10, 14);
    host.handle(format('link', 'javascript:alert(1)'));
    expect(json(host)).not.toContain('javascript');
    expect(sent.at(-1)).toMatchObject({ type: 'notice', noteId: NOTE });
  });

  it('reports what the bar shows, after the change and only when it changed', async () => {
    const { host, view, sent } = opened('plain words');
    // Sent after the transaction, not during it (the app reads one message at a time).
    expect(states(sent)).toHaveLength(0);
    await vi.waitFor(() => expect(lastState(sent)).toBeDefined());
    expect(lastState(sent)).toMatchObject({
      noteId: NOTE,
      active: [],
      canUndo: false,
      canRedo: false,
      canIndent: false,
      href: null,
      menu: false,
    });

    select(view, 1, 6);
    host.handle(format('bold'));
    await vi.waitFor(() => expect(lastState(sent)?.active).toEqual(['bold']));
    expect(lastState(sent)?.canUndo).toBe(true);

    const count = states(sent).length;
    select(view, 2, 4);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(states(sent)).toHaveLength(count);

    host.handle(format('link', 'https://penmoss.app'));
    await vi.waitFor(() => expect(lastState(sent)?.href).toBe('https://penmoss.app'));
    expect(lastState(sent)?.active).toEqual(['bold', 'link']);
  });

  it('says when a list item can be indented', async () => {
    const { host, view, sent } = opened();
    host.handle(format('orderedList'));
    type(view, 'one\ntwo');
    await vi.waitFor(() =>
      expect(lastState(sent)).toMatchObject({ active: ['orderedList'], canIndent: true }),
    );
  });

  it('changes nothing in a note opened read-only', () => {
    const parts = page();
    parts.host.handle({
      v: 1,
      type: 'open',
      noteId: NOTE,
      synced: [{ id: '1', update: toBase64(note('Locked', 'keep').encodeStateAsUpdate()) }],
      pending: [],
      editable: false,
    });
    const before = json(parts.host);
    parts.host.handle(format('bulletList'));
    expect(json(parts.host)).toBe(before);
  });
});

describe('Back with a menu open (A302)', () => {
  it('closes the slash menu first, and says the menu is open meanwhile', async () => {
    const { host, view, sent } = opened();
    type(view, '/');
    await vi.waitFor(() => expect(lastState(sent)?.menu).toBe(true));
    expect(document.querySelector('.pm-slash-menu')).not.toBeNull();
    host.handle({ v: 1, type: 'dismiss', noteId: NOTE });
    expect(document.querySelector('.pm-slash-menu')).toBeNull();
    await vi.waitFor(() => expect(lastState(sent)?.menu).toBe(false));
  });
});

describe('wikilinks from the phone’s notes (A303)', () => {
  const directory = (notes: Array<{ id: string; title: string; folder?: string }>): ToEditor => ({
    v: 1,
    type: 'directory',
    notes,
  });

  it('shows a link by its note’s current title, and follows renames', () => {
    const { host, editor } = opened();
    host.handle(directory([{ id: OTHER, title: 'Garden plan' }]));
    editor.commands.setContent({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'wikilink', attrs: { target: 'old name', noteId: OTHER } }],
        },
      ],
    });
    const link = () => editor.view.dom.querySelector('a.pm-wikilink')!.textContent;
    expect(link()).toBe('Garden plan');
    host.handle(directory([{ id: OTHER, title: 'Garden plan 2027' }]));
    expect(link()).toBe('Garden plan 2027');
  });

  it('completes [[ from the list, fuzzily, with the folder beside each note', async () => {
    const { host, view, editor } = opened();
    host.handle(
      directory([
        { id: NOTE, title: 'Writing' },
        { id: OTHER, title: 'Garden plan', folder: 'Home' },
        { id: '01JD2Z7Q8R4T6Y8W0E2R4T6YB3', title: 'Grocery list' },
      ]),
    );
    type(view, 'See [[gpl');
    await vi.waitFor(() => expect(document.querySelector('.pm-link-menu')).not.toBeNull());
    const options = [...document.querySelectorAll('.pm-link-menu .pm-slash-option')].map(
      (option) => option.textContent,
    );
    expect(options[0]).toContain('Garden plan');
    expect(options[0]).toContain('Home');
    // The open note never links to itself.
    expect(options.join(' ')).not.toContain('Writing');
    expect(press(view, 'Enter')).toBe(true);
    expect(JSON.stringify(editor.getJSON())).toContain(`"noteId":"${OTHER}"`);
  });

  it('creates a note from a link on the phone and hands it to the app', async () => {
    const { host, view, sent, editor } = opened();
    host.handle(directory([{ id: OTHER, title: 'Garden plan' }]));
    type(view, '[[Holiday ideas');
    await vi.waitFor(() => expect(document.querySelector('.pm-link-menu')).not.toBeNull());
    const options = [...document.querySelectorAll('.pm-link-menu .pm-slash-option')];
    const create = options.findIndex((option) => option.textContent?.includes('Holiday ideas'));
    expect(create).toBeGreaterThanOrEqual(0);
    for (let i = 0; i < create; i++) press(view, 'ArrowDown');
    expect(press(view, 'Enter')).toBe(true);

    const made = sent.find((message) => message.type === 'newNote') as Extract<
      FromEditor,
      { type: 'newNote' }
    >;
    expect(made).toMatchObject({ noteId: NOTE, note: { title: 'Holiday ideas' } });
    const replica = createYjs14Replica();
    replica.applyUpdate(fromBase64(made.note.update));
    expect(readTitle(replica.doc)).toBe('Holiday ideas');
    expect(replica.doc.get('meta').getAttr('id')).toBe(made.note.id);
    expect(JSON.stringify(editor.getJSON())).toContain(`"noteId":"${made.note.id}"`);
    // Following it opens it through the app.
    expect(editor.view.dom.querySelector('a.pm-wikilink')!.textContent).toBe('Holiday ideas');
    // Opened with no notebook said (an older app): the new note records none.
    expect(replica.doc.get('meta').getAttr('notebook')).toBeUndefined();
  });

  it('records the open note’s notebook in a note made from a link in it (T43, A766)', async () => {
    const { host, view, sent } = opened('', WORK);
    host.handle(directory([{ id: OTHER, title: 'Garden plan' }]));
    type(view, '[[Client brief');
    await vi.waitFor(() => expect(document.querySelector('.pm-link-menu')).not.toBeNull());
    const options = [...document.querySelectorAll('.pm-link-menu .pm-slash-option')];
    const create = options.findIndex((option) => option.textContent?.includes('Client brief'));
    for (let i = 0; i < create; i++) press(view, 'ArrowDown');
    expect(press(view, 'Enter')).toBe(true);
    const made = sent.find((message) => message.type === 'newNote') as Extract<
      FromEditor,
      { type: 'newNote' }
    >;
    const replica = createYjs14Replica();
    replica.applyUpdate(fromBase64(made.note.update));
    expect(readNoteNotebook(replica.doc)).toBe(WORK);
  });
});

describe('pictures through the app (A304)', () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

  function pasteEvent(files: File[]): ClipboardEvent {
    const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(event, 'clipboardData', {
      value: { files, getData: () => '' },
    });
    return event;
  }

  it('hands a pasted picture to the app by its hash, and shows it from the app’s origin', async () => {
    const { host, view, sent, log } = opened('x');
    select(view, 2);
    view.dom.dispatchEvent(pasteEvent([new File([PNG], 'shot.png', { type: 'image/png' })]));
    await vi.waitFor(() =>
      expect(sent.some((message) => message.type === 'attachment')).toBe(true),
    );
    const attachment = sent.find((message) => message.type === 'attachment') as Extract<
      FromEditor,
      { type: 'attachment' }
    >;
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', PNG));
    const sha256 = [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    expect(attachment).toMatchObject({
      noteId: NOTE,
      path: `attachments/${sha256}.png`,
      size: PNG.byteLength,
    });
    // Its bytes are the very next message, as an array buffer (no base64 for Kotlin).
    const bytes = log[log.indexOf(attachment) + 1];
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect([...(bytes as Uint8Array)]).toEqual([...PNG]);
    // Not in the note until the phone has stored it (A311).
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(view.dom.querySelector('.pm-image')).toBeNull();
    host.handle({ v: 1, type: 'attachmentStored', noteId: NOTE, path: attachment.path, ok: true });
    await vi.waitFor(() =>
      expect(view.dom.querySelector('.pm-image img')?.getAttribute('src')).toBe(
        `${ATTACHMENT_URL_PREFIX}${sha256}.png`,
      ),
    );
    expect(JSON.stringify(view.state.doc.toJSON())).toContain(`attachments/${sha256}.png`);
  });

  it('leaves a pasted picture out of the note when the phone could not store it (A311)', async () => {
    const { host, view, sent } = opened('x');
    view.dom.dispatchEvent(pasteEvent([new File([PNG], 'shot.png', { type: 'image/png' })]));
    await vi.waitFor(() =>
      expect(sent.some((message) => message.type === 'attachment')).toBe(true),
    );
    const attachment = sent.find((message) => message.type === 'attachment') as Extract<
      FromEditor,
      { type: 'attachment' }
    >;
    host.handle({ v: 1, type: 'attachmentStored', noteId: NOTE, path: attachment.path, ok: false });
    await vi.waitFor(() =>
      expect(sent).toContainEqual(
        expect.objectContaining({
          type: 'notice',
          message: 'The picture could not be stored on this phone',
        }),
      ),
    );
    expect(view.dom.querySelector('.pm-image')).toBeNull();
    expect(JSON.stringify(view.state.doc.toJSON())).not.toContain('attachments/');
  });

  it('refuses a file that is not a picture, saying why', async () => {
    const { view, sent } = opened('x');
    view.dom.dispatchEvent(
      pasteEvent([new File([new Uint8Array([1, 2, 3, 4])], 'fake.png', { type: 'image/png' })]),
    );
    await vi.waitFor(() =>
      expect(sent).toContainEqual(expect.objectContaining({ type: 'notice', noteId: NOTE })),
    );
    expect(sent.some((message) => message.type === 'attachment')).toBe(false);
  });

  it('inserts pictures the app stored from the photo picker at the selection', () => {
    const { host, view } = opened('ab');
    select(view, 2);
    const paths = [`attachments/${'a'.repeat(64)}.jpg`, `attachments/${'b'.repeat(64)}.png`];
    host.handle({ v: 1, type: 'insertImages', noteId: NOTE, paths });
    const srcs: string[] = [];
    view.state.doc.descendants((node) => {
      if (node.type.name === 'image') srcs.push(node.attrs['src'] as string);
    });
    expect(srcs).toEqual(paths);
    expect(view.state.doc.textContent).toBe('ab');
  });

  it('shows a stored picture from the app’s origin, whatever folder the path is relative to', async () => {
    const { editor, view } = opened();
    editor.commands.setContent({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'image', attrs: { src: `../../attachments/${'c'.repeat(64)}.gif` } }],
        },
      ],
    });
    await vi.waitFor(() =>
      expect(view.dom.querySelector('.pm-image img')?.getAttribute('src')).toBe(
        `${ATTACHMENT_URL_PREFIX}${'c'.repeat(64)}.gif`,
      ),
    );
  });
});

describe('the chosen theme (A305)', () => {
  const variable = (name: string) => document.documentElement.style.getPropertyValue(name);

  it('shows a built-in theme in the variant the app asks for', () => {
    const { host } = page();
    host.handle({
      v: 1,
      type: 'theme',
      theme: NORD as unknown as Record<string, unknown>,
      variant: 'dark',
    });
    expect(document.documentElement.dataset['theme']).toBe('nord');
    expect(document.documentElement.dataset['mode']).toBe('dark');
    expect(variable('--pm-bg')).toBe(NORD.dark.bg);
    host.handle({
      v: 1,
      type: 'theme',
      theme: PENMOSS as unknown as Record<string, unknown>,
      variant: 'light',
    });
    expect(variable('--pm-bg')).toBe(PENMOSS.light.bg);
  });

  it('checks a custom theme again before showing it', () => {
    const { host, sent } = page();
    host.handle({
      v: 1,
      type: 'theme',
      theme: {
        id: 'custom-ink',
        name: 'Ink',
        base: 'penmoss',
        editorWidth: 40,
        fonts: { ui: 'x;} body{background:url(https://evil)}', body: 'Georgia', mono: 'Menlo' },
        light: { ...PENMOSS.light, bg: '#fefefe' },
        dark: PENMOSS.dark,
      },
      variant: 'light',
    });
    expect(variable('--pm-bg')).toBe('#fefefe');
    expect(variable('--pm-font')).not.toContain('url(');
    host.handle({ v: 1, type: 'theme', theme: { id: 'not-a-theme' }, variant: 'light' });
    expect(sent.at(-1)).toMatchObject({ type: 'error' });
  });
});

describe('the note width (A413)', () => {
  it('caps the note at the theme’s width, and full width lifts the cap', () => {
    const { host, root } = page();
    host.handle({
      v: 1,
      type: 'theme',
      theme: { ...PENMOSS, id: 'custom-wide', name: 'Wide', base: 'penmoss', editorWidth: 64 },
      variant: 'light',
    });
    // The page's stylesheet caps `.android-note` at this variable (android.css).
    expect(document.documentElement.style.getPropertyValue('--pm-editor-width')).toBe('64rem');
    expect(root.dataset['width']).toBeUndefined();
    host.handle({ v: 1, type: 'width', full: true });
    expect(root.dataset['width']).toBe('full');
    host.handle({ v: 1, type: 'width', full: false });
    expect(root.dataset['width']).toBeUndefined();
  });
});

describe('the image lightbox on the phone (T51, A948)', () => {
  // Read when the suite is collected: happy-dom lays nothing out, so the rule is read from the sheet.
  const sheet = '../src/android.css';
  const phone = readFileSync(fileURLToPath(new URL(sheet, import.meta.url)), 'utf8');

  it('opens on a double tap, tells the app, and closes on the back gesture', async () => {
    const { host, editor, view, sent } = opened();
    editor.commands.setContent({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'image', attrs: { src: `attachments/${'d'.repeat(64)}.png`, alt: 'Beds' } },
          ],
        },
      ],
    });
    await vi.waitFor(() => expect(view.dom.querySelector('.pm-image img')).not.toBeNull());
    const img = view.dom.querySelector<HTMLImageElement>('.pm-image img')!;
    img.dispatchEvent(new Event('load'));
    const tap = () =>
      img.dispatchEvent(
        new PointerEvent('pointerup', {
          bubbles: true,
          cancelable: true,
          clientX: 10,
          clientY: 10,
          pointerType: 'touch',
          pointerId: 1,
        }),
      );
    tap();
    tap();
    await vi.waitFor(() => expect(sent).toContainEqual({ v: 1, type: 'lightbox', open: true }));
    const box = document.querySelector<HTMLElement>('.pm-lightbox')!;
    expect(box.querySelector('img')?.getAttribute('alt')).toBe('Beds');
    // A WebView gives no full screen of its own: the app's bars step aside instead, and the
    // page's stylesheet hides the button (happy-dom lays nothing out: read from the sheet).
    expect(box.querySelector('.pm-lightbox-full')).not.toBeNull();
    expect(phone).toMatch(/\.pm-lightbox \.pm-lightbox-full \{\s*display: none;/);
    expect(phone).toMatch(/\.pm-lightbox-stage \{\s*touch-action: none;/);
    host.handle({ v: 1, type: 'closeLightbox' });
    expect(document.querySelector('.pm-lightbox')).toBeNull();
    await vi.waitFor(() => expect(sent.at(-1)).toEqual({ v: 1, type: 'lightbox', open: false }));
    // The note is still there, and a close with none open does nothing.
    host.handle({ v: 1, type: 'closeLightbox' });
    expect(view.dom.querySelector('.pm-image img')).not.toBeNull();
  });
});

describe('the person’s fonts (T51, A944)', () => {
  it('lays the interface and note fonts and the note size over the theme, and back', () => {
    const { host } = page();
    const variable = (name: string) => document.documentElement.style.getPropertyValue(name);
    host.handle({ v: 1, type: 'theme', theme: { id: 'penmoss' }, variant: 'light' });
    const themeFont = variable('--pm-font');
    const themeBody = variable('--pm-font-body');
    host.handle({ v: 1, type: 'fonts', interface: 'mono', note: 'custom:Charter', noteSize: 20 });
    expect(variable('--pm-font')).toContain('monospace');
    expect(variable('--pm-font-body').startsWith("'Charter', ")).toBe(true);
    expect(variable('--pm-note-size')).toBe('20px');
    // A theme sent after keeps the person's fonts over it.
    host.handle({ v: 1, type: 'theme', theme: { id: 'nord' }, variant: 'dark' });
    expect(variable('--pm-font-body').startsWith("'Charter', ")).toBe(true);
    // Back to the theme's own: the theme's fonts again, at the default size.
    host.handle({ v: 1, type: 'fonts', interface: 'theme', note: 'theme', noteSize: 16 });
    host.handle({ v: 1, type: 'theme', theme: { id: 'penmoss' }, variant: 'light' });
    expect(variable('--pm-font')).toBe(themeFont);
    expect(variable('--pm-font-body')).toBe(themeBody);
    expect(variable('--pm-note-size')).toBe('16px');
  });

  it('refuses fonts the server would not store', () => {
    for (const bad of [
      { v: 1, type: 'fonts', interface: 'Serif', note: 'theme', noteSize: 16 },
      { v: 1, type: 'fonts', interface: 'theme', note: 'custom:x;}body{', noteSize: 16 },
      { v: 1, type: 'fonts', interface: 'theme', note: 'theme', noteSize: 30 },
      { v: 1, type: 'fonts', interface: 'theme', note: 'theme' },
    ]) {
      expect(parseToEditor(JSON.stringify(bad))).toBeNull();
    }
  });
});

describe('the theme editor’s preview (A418)', () => {
  it('shows the sample note read-only, sends nothing, and re-themes as colours change', async () => {
    const { host, sent, root, title, body } = page();
    host.handle({ v: 1, type: 'preview' });
    expect(root.hidden).toBe(false);
    expect(root.dataset['preview']).toBe('true');
    expect(title.value).toBe('Garden plan');
    expect(title.readOnly).toBe(true);
    // The note's own blocks, in the editor's stylesheet: a link, a highlight, code, a
    // checklist, a callout and a code block.
    expect(body.querySelector('a[href="https://example.com/fence"]')).not.toBeNull();
    expect(body.querySelector('mark')?.textContent).toBe('tomatoes');
    expect(body.querySelector('.pm-callout[data-callout-type="tip"]')).not.toBeNull();
    expect(body.querySelector('pre')?.textContent).toContain('const beds = 4;');
    expect(body.querySelectorAll('[data-type="taskList"] li[data-checked]').length).toBe(2);
    expect(host.editor!.editor.isEditable).toBe(false);
    host.handle({
      v: 1,
      type: 'theme',
      theme: NORD as unknown as Record<string, unknown>,
      variant: 'dark',
    });
    expect(document.documentElement.style.getPropertyValue('--pm-bg')).toBe(NORD.dark.bg);
    const custom = {
      ...NORD,
      id: 'custom-x',
      name: 'X',
      base: 'nord',
      dark: { ...NORD.dark, bg: '#101418' },
    };
    host.handle({ v: 1, type: 'theme', theme: custom, variant: 'dark' });
    expect(document.documentElement.style.getPropertyValue('--pm-bg')).toBe('#101418');
    await new Promise((done) => setTimeout(done, 2_500));
    // Nothing of the sample note ever goes to the app.
    expect(sent).toEqual([]);
    host.close();
    expect(root.dataset['preview']).toBeUndefined();
  });
});

describe('conflict copies (A306)', () => {
  it('builds a copy from the edits kept apart and the copy they were made on', () => {
    const { host, sent } = page();
    const server = note('Trip', 'before the restore');
    const base = toBase64(server.encodeStateAsUpdate());
    const before = server.encodeStateVector();
    setTitle(server.doc, 'Trip to Austin');
    const edit = toBase64(Y.encodeStateAsUpdate(server.doc, before));
    host.handle({
      v: 1,
      type: 'copyConflicts',
      noteId: NOTE,
      base: [{ id: '7', update: base }],
      edits: [{ id: '9', update: edit }],
    });
    const reply = sent.at(-1) as Extract<FromEditor, { type: 'conflictCopy' }>;
    // The copy holds the edits; what they were made on stays with the server's note.
    expect(reply).toMatchObject({ type: 'conflictCopy', noteId: NOTE, replaces: ['9'] });
    expect(reply.merged).toBeUndefined();
    expect(reply.note.id).not.toBe(NOTE);
    expect(reply.note.title).toBe(`Trip to Austin${CONFLICT_SUFFIX}`);
    const copy = createYjs14Replica();
    copy.applyUpdate(fromBase64(reply.note.update));
    expect(copy.plainText()).toContain('before the restore');
    expect(readTitle(copy.doc)).toBe(`Trip to Austin${CONFLICT_SUFFIX}`);
    expect(copy.doc.get('meta').getAttr('id')).toBe(reply.note.id);
  });

  it('files the copy in its original’s notebook: the note’s own record, else the app’s (T43, A766)', () => {
    const copyOf = (server: Yjs14Replica, notebook?: string) => {
      const { host, sent } = page();
      const base = toBase64(server.encodeStateAsUpdate());
      const before = server.encodeStateVector();
      setTitle(server.doc, 'Trip to Austin');
      host.handle({
        v: 1,
        type: 'copyConflicts',
        noteId: NOTE,
        base: [{ id: '7', update: base }],
        edits: [{ id: '9', update: toBase64(Y.encodeStateAsUpdate(server.doc, before)) }],
        ...(notebook ? { notebook } : {}),
      });
      const reply = sent.at(-1) as Extract<FromEditor, { type: 'conflictCopy' }>;
      const copy = createYjs14Replica();
      copy.applyUpdate(fromBase64(reply.note.update));
      return readNoteNotebook(copy.doc);
    };
    // The original says nothing (made before notebooks): where the app sees it.
    expect(copyOf(note('Trip', 'x'), WORK)).toBe(WORK);
    expect(copyOf(note('Trip', 'x'))).toBeNull();
    // The original says: its own record wins.
    const recorded = note('Trip', 'x');
    setNoteNotebook(recorded.doc, 'default');
    expect(copyOf(recorded, WORK)).toBe('default');
  });

  it('reports bytes it cannot read instead of making a copy', () => {
    const { host, sent } = page();
    host.handle({
      v: 1,
      type: 'copyConflicts',
      noteId: NOTE,
      base: [],
      edits: [{ id: '1', update: 'AQID' }],
    });
    expect(sent.at(-1)).toMatchObject({
      type: 'copyFailed',
      noteId: NOTE,
      reason: 'unreadable',
      replaces: ['1'],
    });
  });
});

describe('conflict copies that keep every edit (A309)', () => {
  /** A note on "the server" and the phone's edits of it, each as its own update. */
  function edited() {
    const server = note('Trip', 'hello');
    const base = toBase64(server.encodeStateAsUpdate());
    const paragraph = server.doc.get(NOTE_ROOT).get(0) as Y.Node;
    const edit = (text: string) => {
      const before = server.encodeStateVector();
      paragraph.insert(paragraph.length, text);
      return toBase64(Y.encodeStateAsUpdate(server.doc, before));
    };
    return { server, base, edit };
  }

  const copyOf = (update: string, more: readonly string[] = []) => {
    const replica = createYjs14Replica();
    replica.applyUpdate(fromBase64(update));
    for (const extra of more) replica.applyUpdate(fromBase64(extra));
    return replica.plainText();
  };

  const ask = (
    host: EditorHost,
    base: readonly string[],
    edits: readonly string[],
    into?: { noteId: string; updates: readonly string[] },
  ) =>
    host.handle({
      v: 1,
      type: 'copyConflicts',
      noteId: NOTE,
      base: base.map((update, i) => ({ id: `b${i}`, update })),
      edits: edits.map((update, i) => ({ id: `e${i}`, update })),
      ...(into
        ? {
            into: {
              noteId: into.noteId,
              updates: into.updates.map((update, i) => ({ id: `c${i}`, update })),
            },
          }
        : {}),
    });

  it('refuses edits sent without what they build on, rather than copy them without it', () => {
    const { host, sent } = page();
    const { edit } = edited();
    const typed = edit(' world');
    ask(host, [], [typed]);
    expect(sent.at(-1)).toEqual({
      v: 1,
      type: 'copyFailed',
      noteId: NOTE,
      reason: 'incomplete',
      replaces: ['e0'],
    });
    expect(sent.some((message) => message.type === 'conflictCopy')).toBe(false);
  });

  it('refuses a later edit sent without the earlier edit it builds on', () => {
    const { host, sent } = page();
    const { base, edit } = edited();
    edit(' world');
    const later = edit(' again');
    ask(host, [base], [later]);
    expect(sent.at(-1)).toMatchObject({ type: 'copyFailed', reason: 'incomplete' });
  });

  it('copies a later edit with the earlier ones a copy already holds', () => {
    const { host, sent } = page();
    const { base, edit } = edited();
    const first = edit(' world');
    const later = edit(' again');
    ask(host, [base, first], [later]);
    const reply = sent.at(-1) as Extract<FromEditor, { type: 'conflictCopy' }>;
    expect(reply.replaces).toEqual(['e0']);
    expect(copyOf(reply.note.update)).toContain('hello world again');
  });

  it('merges a late edit into the copy made of the earlier ones while it shows only those', () => {
    const { host, sent } = page();
    const { base, edit } = edited();
    const first = edit(' world');
    ask(host, [base], [first]);
    const copy = sent.at(-1) as Extract<FromEditor, { type: 'conflictCopy' }>;
    expect(copyOf(copy.note.update)).toContain('hello world');

    const late = edit(' and the last seconds');
    ask(host, [base, first], [late], { noteId: copy.note.id, updates: [copy.note.update] });
    const merged = sent.at(-1) as Extract<FromEditor, { type: 'conflictCopy' }>;
    expect(merged).toMatchObject({ type: 'conflictCopy', merged: true, replaces: ['e0'] });
    expect(merged.note.id).toBe(copy.note.id);
    expect(merged.note.title).toBe(copy.note.title);
    // An edit of the copy: with what the copy already was, it reads as everything typed.
    expect(copyOf(copy.note.update, [merged.note.update])).toContain(
      'hello world and the last seconds',
    );
    expect(copyOf(copy.note.update, [merged.note.update])).not.toContain('hello worldhello');
  });

  it('makes a second, complete copy when the first was edited since', () => {
    const { host, sent } = page();
    const { base, edit } = edited();
    const first = edit(' world');
    ask(host, [base], [first]);
    const copy = sent.at(-1) as Extract<FromEditor, { type: 'conflictCopy' }>;
    // Ryan wrote in the copy meanwhile.
    const replica = createYjs14Replica();
    replica.applyUpdate(fromBase64(copy.note.update));
    const before = replica.encodeStateVector();
    replica.doc.transact(() => {
      const paragraph = new Y.Node('paragraph');
      replica.doc.get(NOTE_ROOT).push([paragraph]);
      paragraph.insert(0, 'written in the copy');
    });
    const written = toBase64(Y.encodeStateAsUpdate(replica.doc, before));

    const late = edit('!');
    ask(host, [base, first], [late], {
      noteId: copy.note.id,
      updates: [copy.note.update, written],
    });
    const second = sent.at(-1) as Extract<FromEditor, { type: 'conflictCopy' }>;
    expect(second.merged).toBeUndefined();
    expect(second.note.id).not.toBe(copy.note.id);
    expect(copyOf(second.note.update)).toContain('hello world!');
  });

  it('makes no copy of edits that leave nothing to keep', () => {
    const { host, sent } = page();
    const { server, base } = edited();
    // Typed and deleted again: the copy would be the server's old copy, unchanged.
    const before = server.encodeStateVector();
    const paragraph = server.doc.get(NOTE_ROOT).get(0) as Y.Node;
    paragraph.insert(5, 'x');
    paragraph.delete(5, 1);
    const typedAndDeleted = toBase64(Y.encodeStateAsUpdate(server.doc, before));
    ask(host, [base], [typedAndDeleted]);
    expect(sent.at(-1)).toMatchObject({ type: 'copyFailed', reason: 'empty' });

    // Everything deleted: a copy would hold nothing.
    const cleared = server.encodeStateVector();
    server.doc.get(NOTE_ROOT).delete(0, 1);
    ask(host, [base, typedAndDeleted], [toBase64(Y.encodeStateAsUpdate(server.doc, cleared))]);
    expect(sent.at(-1)).toMatchObject({ type: 'copyFailed', reason: 'empty' });
    expect(sent.some((message) => message.type === 'conflictCopy')).toBe(false);
  });
});

describe('typing on a phone (A307)', () => {
  it('lets the keyboard correct and capitalise, and keeps room below the caret', () => {
    const { view } = opened();
    expect(view.dom.getAttribute('autocapitalize')).toBe('sentences');
    expect(view.dom.getAttribute('autocorrect')).toBe('on');
    expect(view.dom.getAttribute('spellcheck')).toBe('true');
    type(view, 'still there after typing');
    expect(view.dom.getAttribute('autocapitalize')).toBe('sentences');
    expect(view.someProp('scrollMargin')).toMatchObject({ bottom: 48 });
  });

  it('holds updates from other devices while a word is being composed', async () => {
    const { host, view, server, title } = opened('hello');
    const before = server.encodeStateVector();
    setTitle(server.doc, 'Renamed on the Mac');
    const update = toBase64(Y.encodeStateAsUpdate(server.doc, before));

    view.dom.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
    expect(view.composing).toBe(true);
    host.handle({ v: 1, type: 'remote', noteId: NOTE, update });
    expect(title.value).toBe('Writing');
    view.dom.dispatchEvent(new CompositionEvent('compositionend', { data: 'wor' }));
    await vi.waitFor(() => expect(title.value).toBe('Renamed on the Mac'));
  });

  it('holds them no longer than a few seconds when the keyboard keeps a word composing', () => {
    vi.useFakeTimers();
    try {
      const { host, view, server, title } = opened('hello');
      const before = server.encodeStateVector();
      setTitle(server.doc, 'Renamed on the Mac');
      const update = toBase64(Y.encodeStateAsUpdate(server.doc, before));
      view.dom.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
      host.handle({ v: 1, type: 'remote', noteId: NOTE, update });
      vi.advanceTimersByTime(HOLD_MAX_MS - 1);
      expect(title.value).toBe('Writing');
      vi.advanceTimersByTime(1);
      expect(view.composing).toBe(true);
      expect(title.value).toBe('Renamed on the Mac');
    } finally {
      vi.useRealTimers();
    }
  });

  it('brings the caret back into view when the keyboard shrinks the page', () => {
    const { host, editor } = opened('a long note');
    const scrolled: boolean[] = [];
    editor.on('transaction', ({ transaction }) => scrolled.push(transaction.scrolledIntoView));
    host.viewportChanged(900);
    editor.view.focus();
    host.viewportChanged(900);
    host.viewportChanged(1000);
    expect(scrolled.filter(Boolean)).toHaveLength(0);
    host.viewportChanged(520);
    expect(scrolled.filter(Boolean)).toHaveLength(1);
  });

  it('goes on from the title to the note with Enter', async () => {
    const { title, view } = opened('body');
    title.focus();
    title.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
    // TipTap moves the focus on the next frame.
    await vi.waitFor(() => expect(view.hasFocus()).toBe(true));
    expect(view.state.selection.from).toBe(1);
    expect(title.enterKeyHint).toBe('next');
  });
});

describe('normaliseHref', () => {
  it('takes web, mail and phone links and a bare host, and refuses other schemes', () => {
    expect(normaliseHref('penmoss.app')).toBe('https://penmoss.app');
    expect(normaliseHref(' http://x.test ')).toBe('http://x.test');
    expect(normaliseHref('mailto:me@x.test')).toBe('mailto:me@x.test');
    expect(normaliseHref('javascript:alert(1)')).toBeNull();
    expect(normaliseHref('data:text/html,hi')).toBeNull();
    expect(normaliseHref('')).toBeNull();
  });
});

describe('the title against a first heading (T39 pass 3, A554)', () => {
  // Read from the stylesheets themselves: happy-dom lays nothing out. The note's text is 1rem.
  const css = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
  const size = (sheet: string, rule: RegExp) => Number(rule.exec(sheet)?.[1] ?? Number.NaN);

  it('sets the title a step above a first heading on the phone and on a narrow web page', () => {
    const web = css('../../../web/src/styles.css');
    const phone = css('../src/android.css');
    const heading = size(web, /\.note-body h1 \{\s*font-size: ([\d.]+)em;/);
    const wide = size(web, /\.doc-title \{[^}]*font: 700 ([\d.]+)rem/);
    const narrow = size(web, /\n {2}\.doc-title \{\s*font-size: ([\d.]+)rem;/);
    const android = size(phone, /\.android-note \.doc-title \{[^}]*font-size: ([\d.]+)rem;/);
    expect(heading).toBe(1.6);
    for (const title of [wide, narrow, android])
      expect(title).toBeGreaterThanOrEqual(heading * 1.15);
  });

  it('gives a picture its own line with no empty line under it, as the web does (PEN-66, A1283)', () => {
    const web = css('../../../web/src/styles.css');
    const phone = css('../src/android.css');
    // The page loads the web's stylesheet (main.ts), whose picture rules lay a picture out: the
    // node inline, its frame (the picture) an inline grid its own size, so ProseMirror's cursor
    // helpers after it share its line rather than making an empty one.
    const main = css('../src/main.ts');
    expect(main).toContain("import '../../../web/src/styles.css';");
    expect(web).toMatch(/\n\.note-body \.pm-image-frame \{[^}]*display: inline-grid;/);
    // Not positioned (only while its fields show): beside a positioned box in the node, Chromium
    // and the WebView draw no caret after the picture (AC5).
    expect(web).not.toMatch(/\n\.note-body \.pm-image-frame \{[^}]*position:/);
    expect(web).not.toMatch(/\n\.note-body \.pm-image-resize \{[^}]*position:/);
    // Text keeps off the picture's line: a block 0.4 em tall breaks the line before it, unless it
    // starts its line; the frame's end margin, as wide as the line, wraps what follows, unless the
    // picture ends its block.
    expect(web).toMatch(
      /\n\.note-body \.pm-image::before \{[^}]*display: block;[^}]*height: 0\.4em;/,
    );
    expect(web).toMatch(/\.ProseMirror-separator \+ \.pm-image::before \{\s*display: none;/);
    expect(web).toMatch(/\.pm-image \+ \.pm-image::before \{\s*height: 0;/);
    expect(web).toMatch(
      /\n\.note-body \.pm-image-frame \{\s*width: max-content;\s*margin-inline-end: 100%;/,
    );
    expect(web).toMatch(
      /\+ \.ProseMirror-separator \+ \.ProseMirror-trailingBreak\)[^{]*\{\s*margin-inline-end: 0;\s*padding-inline-end: 3px;/,
    );
    // No picture rule of its own on the phone undoes that, and the old lone-picture exception
    // (a `:has()` on the paragraph's exact children, A1107) is gone.
    expect(phone).not.toMatch(
      /\.pm-image(-frame)?(::before)? \{[^}]*(display|width|margin[a-z-]*|height):/,
    );
    expect(web).not.toContain('.ProseMirror-trailingBreak:last-child');
  });

  it('sets the title in the Note Font, as the web does, not the interface font (T51, A944)', () => {
    const web = css('../../../web/src/styles.css');
    const phone = css('../src/android.css');
    const family = (sheet: string, rule: RegExp) => rule.exec(sheet)?.[1]?.trim();
    const webTitle = family(web, /\.doc-title \{[^}]*font: 700 [\d.]+rem\/[\d.]+ ([^;]+);/);
    const phoneTitle = family(phone, /\.android-note \.doc-title \{[^}]*font-family: ([^;]+);/);
    expect(webTitle).toBe('var(--pm-font-body, var(--pm-font))');
    expect(phoneTitle).toBe(webTitle);
  });
});
