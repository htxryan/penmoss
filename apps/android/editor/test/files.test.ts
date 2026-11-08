/**
 * The editor page's T40 P8 second part: files through the app (ED12) and
 * pictures from web addresses on the page's own origin (ED13).
 */
import { NOTE_ROOT } from '@penmoss/sync-client';
import { initNote } from '@penmoss/sync-client/note';
import { createYjs14Replica } from '@penmoss/sync-client/yjs14';
import type { JSONContent } from '@tiptap/core';
import * as Y from '@y/y';
import { toBase64 } from 'lib0/buffer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { select } from '../../../../packages/editor/test/support/editor';
import { EditorHost, REMOTE_PICTURE_PATH } from '../src/host';
import { parseToEditor, type FromEditor, type ToEditor } from '../src/protocol';

const NOTE = '01JD2Z7Q8R4T6Y8W0E2R4T6YB2';
const PDF_BYTES = new TextEncoder().encode('%PDF-1.7\nhello');
const CSV_BYTES = new TextEncoder().encode('a,b\n1,2\n');
const PDF = `attachments/${'c'.repeat(64)}.pdf`;
const CSV = `attachments/${'d'.repeat(64)}.csv`;
const WEB = 'https://example.com/cat.png';

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
  /** Every message in order, with files' bytes as the app receives them. */
  const log: Array<FromEditor | Uint8Array> = [];
  const host = new EditorHost(
    { root, title, body, unsupported },
    (message) => {
      sent.push(message);
      log.push(message);
    },
    { postBytes: (bytes) => log.push(bytes) },
  );
  hosts.push(host);
  return { host, sent, log, body };
}

const message = (body: Record<string, unknown>): ToEditor =>
  ({ v: 1, noteId: NOTE, ...body }) as unknown as ToEditor;

function opened(content: JSONContent[] = [], before: ToEditor[] = []) {
  const parts = page();
  const server = createYjs14Replica();
  initNote(server.doc, { id: NOTE, created: '2026-10-25T10:00:00-05:00', kind: 'note' }, 'Files');
  server.doc.transact(() => {
    const paragraph = new Y.Node('paragraph');
    server.doc.get(NOTE_ROOT).push([paragraph]);
    paragraph.insert(0, 'ab');
  });
  for (const each of before) parts.host.handle(each);
  parts.host.handle({
    v: 1,
    type: 'open',
    noteId: NOTE,
    synced: [{ id: '1', update: toBase64(server.encodeStateAsUpdate()) }],
    pending: [],
    editable: true,
  });
  const { editor } = parts.host.editor!;
  if (content.length > 0) editor.commands.setContent({ type: 'doc', content });
  return { ...parts, editor, view: editor.view };
}

const ofType = <T extends FromEditor['type']>(sent: FromEditor[], type: T) =>
  sent.filter((each): each is Extract<FromEditor, { type: T }> => each.type === type);

const chipDoc = (href: string, name: string): JSONContent[] => [
  {
    type: 'paragraph',
    content: [
      { type: 'text', text: 'See ' },
      { type: 'attachment', attrs: { href, name } },
    ],
  },
];
const pictureDoc = (src: string, alt = 'Cat'): JSONContent[] => [
  { type: 'paragraph', content: [{ type: 'image', attrs: { src, alt } }] },
];

function pasteEvent(files: File[]): ClipboardEvent {
  const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent;
  Object.defineProperty(event, 'clipboardData', {
    value: { files, getData: () => '' },
  });
  return event;
}

async function sha(bytes: Uint8Array<ArrayBuffer>) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

const nodes = (host: EditorHost, type: string) => {
  const found: Array<Record<string, unknown>> = [];
  host.editor!.editor.state.doc.descendants((node) => {
    if (node.type.name === type) found.push(node.attrs);
  });
  return found;
};

describe('files through the app (ED12)', () => {
  it('hands a pasted file to the app with its bytes, and inserts it once stored', async () => {
    const { host, view, sent, log } = opened();
    select(view, 2);
    view.dom.dispatchEvent(
      pasteEvent([
        new File([PDF_BYTES], 'Q3 report.pdf', { type: 'application/pdf' }),
        new File([CSV_BYTES], 'Budget.CSV', { type: 'text/csv' }),
      ]),
    );
    await vi.waitFor(() => expect(ofType(sent, 'file')).toHaveLength(1));
    const [pdf] = ofType(sent, 'file');
    // Named by the bytes' hash and sniffed type, as the web's `filePath`.
    expect(pdf).toEqual({
      v: 1,
      type: 'file',
      noteId: NOTE,
      path: `attachments/${await sha(PDF_BYTES)}.pdf`,
      name: 'Q3 report.pdf',
      size: PDF_BYTES.byteLength,
    });
    // Its bytes are the very next message, as a picture's (A304).
    expect([...(log[log.indexOf(pdf!) + 1] as Uint8Array)]).toEqual([...PDF_BYTES]);
    // Not in the note until the phone has stored it (A311).
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(nodes(host, 'attachment')).toEqual([]);

    host.handle(message({ type: 'fileStored', path: pdf!.path, ok: true }));
    await vi.waitFor(() => expect(ofType(sent, 'file')).toHaveLength(2));
    const csv = ofType(sent, 'file')[1]!;
    // Any other file keeps its own extension, lower-cased.
    expect(csv.path).toBe(`attachments/${await sha(CSV_BYTES)}.csv`);
    host.handle(message({ type: 'fileStored', path: csv.path, ok: true }));
    await vi.waitFor(() => expect(nodes(host, 'attachment')).toHaveLength(2));
    expect(nodes(host, 'attachment')).toEqual([
      { href: pdf!.path, name: 'Q3 report.pdf' },
      { href: csv.path, name: 'Budget.CSV' },
    ]);
  });

  it('leaves a file out of the note when the phone could not store it', async () => {
    const { host, view, sent } = opened();
    view.dom.dispatchEvent(pasteEvent([new File([CSV_BYTES], 'a.csv', { type: 'text/csv' })]));
    await vi.waitFor(() => expect(ofType(sent, 'file')).toHaveLength(1));
    host.handle(message({ type: 'fileStored', path: ofType(sent, 'file')[0]!.path, ok: false }));
    await vi.waitFor(() =>
      expect(ofType(sent, 'notice').map((each) => each.message)).toContain(
        '“a.csv” could not be stored on this phone',
      ),
    );
    expect(nodes(host, 'attachment')).toEqual([]);
  });

  it('refuses a file over 50 MB before reading it', async () => {
    const { view, sent } = opened();
    const big = new File([CSV_BYTES], 'huge.zip', { type: 'application/zip' });
    Object.defineProperty(big, 'size', { value: 50 * 1024 * 1024 + 1 });
    const read = vi.spyOn(big, 'arrayBuffer');
    view.dom.dispatchEvent(pasteEvent([big]));
    await vi.waitFor(() =>
      expect(ofType(sent, 'notice').map((each) => each.message)).toContain(
        '“huge.zip” is over 50 MB, the largest file Penmoss stores',
      ),
    );
    expect(read).not.toHaveBeenCalled();
    expect(ofType(sent, 'file')).toEqual([]);
  });

  it('inserts files the app stored from the document picker: pictures as pictures', () => {
    const { host, view } = opened();
    select(view, 2);
    const png = `attachments/${'e'.repeat(64)}.png`;
    host.handle(
      message({
        type: 'insertFiles',
        files: [
          { path: PDF, name: 'Lease.pdf' },
          { path: png, name: 'photo.png' },
        ],
      }),
    );
    expect(nodes(host, 'attachment')).toEqual([{ href: PDF, name: 'Lease.pdf' }]);
    expect(nodes(host, 'image').map((attrs) => attrs['src'])).toEqual([png]);
    expect(host.editor!.editor.state.doc.textContent).toBe('ab');
  });

  it('asks the app for a chip’s size and type once, and shows Open and Save a copy', async () => {
    const { host, sent, body } = opened(chipDoc(`../${PDF}`, 'Lease.pdf'));
    await vi.waitFor(() => expect(ofType(sent, 'fileInfo')).toHaveLength(1));
    // The path as the app keeps it, whatever folder the note's link is relative to.
    expect(ofType(sent, 'fileInfo')[0]).toEqual({
      v: 1,
      type: 'fileInfo',
      noteId: NOTE,
      path: PDF,
    });
    host.handle(
      message({ type: 'fileInfo', path: PDF, info: { size: 1536, type: 'application/pdf' } }),
    );
    const chip = body.querySelector<HTMLElement>('[data-testid="attachment"]')!;
    await vi.waitFor(() =>
      expect(chip.querySelector('.pm-attachment-size')!.textContent).toBe('1.5 KB'),
    );
    const shown = [...chip.querySelectorAll('button')]
      .filter((button) => !button.hidden)
      .map((button) => button.textContent);
    expect(shown).toEqual(['Open', 'Save a Copy']);

    chip.querySelector<HTMLButtonElement>('.pm-attachment-open')!.click();
    chip.querySelector<HTMLButtonElement>('.pm-attachment-download')!.click();
    expect(ofType(sent, 'openFile')).toEqual([
      { v: 1, type: 'openFile', noteId: NOTE, path: PDF, name: 'Lease.pdf', action: 'open' },
      { v: 1, type: 'openFile', noteId: NOTE, path: PDF, name: 'Lease.pdf', action: 'save' },
    ]);
    // Never a PDF inside the page (A293).
    expect(body.querySelector('iframe')).toBeNull();
  });

  it('shows a chip with no size when the app does not know the file', async () => {
    vi.useFakeTimers();
    const { sent, body } = opened(chipDoc(CSV, 'old.csv'));
    await vi.advanceTimersByTimeAsync(0);
    expect(ofType(sent, 'fileInfo')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5_000);
    const chip = body.querySelector<HTMLElement>('[data-testid="attachment"]')!;
    expect(chip.querySelector('.pm-attachment-size')!.textContent).toBe('');
    expect(chip.querySelector<HTMLButtonElement>('.pm-attachment-open')!.hidden).toBe(false);
  });

  it('offers File in the + sheet, which opens the page’s file picker for the app', () => {
    const { host, sent, editor } = opened();
    host.handle(message({ type: 'blocks', purpose: 'insert', query: 'file' }));
    expect(ofType(sent, 'blocks')[0]!.items[0]).toMatchObject({ id: 'file', label: 'File' });
    const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => undefined);
    host.handle(message({ type: 'insert', item: 'file' }));
    expect(click).toHaveBeenCalledTimes(1);
    const input = click.mock.contexts[0] as HTMLInputElement;
    // Any type: the app routes it to the document picker, not the photo picker.
    expect(input.type).toBe('file');
    expect(input.accept).toBe('');
    expect(editor.state.doc.textContent).toBe('ab');
  });
});

describe('pictures from web addresses (ED13)', () => {
  const remote = (src: string, now = false) =>
    `${REMOTE_PICTURE_PATH}?${now ? 'now=1&' : ''}u=${encodeURIComponent(src)}`;
  const mode = (value: string) => message({ type: 'webPictures', mode: value });

  it('asks the app for them on the page’s own origin, never the address', () => {
    const { body } = opened(pictureDoc(WEB), [mode('on')]);
    expect(body.querySelector('.pm-image img')!.getAttribute('src')).toBe(remote(WEB));
  });

  it('holds one back for a tap on mobile data with Wi-Fi only', () => {
    const { body, editor } = opened(pictureDoc(WEB), [mode('wait')]);
    const picture = body.querySelector<HTMLElement>('.pm-image')!;
    expect(picture.dataset['state']).toBe('waiting');
    expect(picture.querySelector('img')!.hasAttribute('src')).toBe(false);
    const before = JSON.stringify(editor.getJSON());
    picture.querySelector<HTMLButtonElement>('.pm-image-load')!.click();
    expect(picture.querySelector('img')!.getAttribute('src')).toBe(remote(WEB, true));
    expect(JSON.stringify(editor.getJSON())).toBe(before);
  });

  it('shows the alt text when they are off, when the app has not said, and for http', () => {
    for (const [before, src] of [
      [[mode('off')], WEB],
      [[], WEB],
      [[mode('on')], 'http://example.com/cat.png'],
      [[message({ type: 'webPictures', noteId: 'another', mode: 'on' })], WEB],
    ] as const) {
      const { body, host } = opened(pictureDoc(src), [...before]);
      const picture = body.querySelector<HTMLElement>('.pm-image')!;
      expect(picture.dataset['state']).toBe('missing');
      expect(picture.querySelector('img')!.hasAttribute('src')).toBe(false);
      host.close();
      document.body.replaceChildren();
    }
  });

  it('reads the app’s messages strictly', () => {
    const raw = (body: Record<string, unknown>) =>
      parseToEditor(JSON.stringify({ v: 1, noteId: NOTE, ...body }));
    expect(raw({ type: 'webPictures', mode: 'sometimes' })).toBeNull();
    expect(raw({ type: 'insertFiles', files: [] })).toBeNull();
    expect(
      raw({ type: 'insertFiles', files: [{ path: 'attachments/x.pdf', name: 'x' }] }),
    ).toBeNull();
    expect(
      raw({ type: 'fileInfo', path: PDF, info: { size: -1, type: 'application/pdf' } }),
    ).toBeNull();
    expect(
      raw({ type: 'fileInfo', path: PDF, info: { size: 1, type: 'text/html; x' } }),
    ).toBeNull();
    expect(raw({ type: 'fileStored', path: '../attachments/x.pdf', ok: true })).toBeNull();
  });
});
