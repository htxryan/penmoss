/**
 * Drawings on Android (PEN-189): the note editor's drawing services through the app. Excalidraw
 * itself is stood in for (it needs a real browser; `DrawingInstrumentedTest` runs it in the
 * phone's WebView): what is tested is the page's side of the bridge. Diagram: Excalidraw is
 * offered, the app is told when the editor opens and closes, its Done stores the scene and the
 * SVG as files and puts the drawing in the note, its Cancel puts nothing, Edit asks the app for
 * the scene, and a drawing that couldn't be saved keeps the editor open.
 */
import { NOTE_ROOT } from '@penmoss/model/replica';
import { initNote } from '@penmoss/model/note';
import { createYjs14Replica } from '@penmoss/model/yjs14';
import * as Y from '@y/y';
import { toBase64 } from 'lib0/buffer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorHost } from '../src/host';
import type { FromEditor, ToEditor } from '../src/protocol';

/** The stand-in drawing editor: what it was opened on, and what Done will take. */
const editors = vi.hoisted(() => ({
  opened: [] as Array<{ scene: string | null; title: string }>,
  closed: 0,
  take: (): Promise<{ scene: string; svg: string } | null> =>
    Promise.resolve({ scene: '{"type":"excalidraw","elements":[{}]}', svg: '<svg>1</svg>' }),
}));

vi.mock('../src/drawing-editor', () => ({
  openDrawingEditor: (scene: string | null, title: string) => {
    if (scene === 'not a scene') throw new Error('not an Excalidraw scene');
    editors.opened.push({ scene, title });
    return { take: () => editors.take(), close: () => void editors.closed++ };
  },
}));

const NOTE = '01JD2Z7Q8R4T6Y8W0E2R4T6YB2';
const hosts: EditorHost[] = [];

beforeEach(() => {
  editors.opened = [];
  editors.closed = 0;
  editors.take = () =>
    Promise.resolve({ scene: '{"type":"excalidraw","elements":[{}]}', svg: '<svg>1</svg>' });
});

afterEach(() => {
  for (const host of hosts.splice(0)) host.close();
  document.body.replaceChildren();
});

function opened() {
  const root = document.createElement('main');
  const title = document.createElement('textarea');
  const body = document.createElement('div');
  const unsupported = document.createElement('pre');
  root.append(title, body, unsupported);
  document.body.append(root);
  const sent: FromEditor[] = [];
  const bytes: Uint8Array[] = [];
  const host = new EditorHost({ root, title, body, unsupported }, (message) => sent.push(message), {
    postBytes: (each) => bytes.push(each),
  });
  hosts.push(host);
  const server = createYjs14Replica();
  initNote(server.doc, { id: NOTE, created: '2026-11-25T10:00:00-05:00', kind: 'note' }, 'Plan');
  server.doc.transact(() => {
    const paragraph = new Y.Node('paragraph');
    server.doc.get(NOTE_ROOT).push([paragraph]);
    paragraph.insert(0, 'Garden');
  });
  host.handle({
    v: 1,
    type: 'open',
    noteId: NOTE,
    synced: [{ id: '1', update: toBase64(server.encodeStateAsUpdate()) }],
    pending: [],
    editable: true,
  });
  const { editor } = host.editor!;
  /** Answers each `file` the page sends as the app does: stored. */
  const storeFiles = () => {
    for (const each of sent.splice(0)) {
      if (each.type === 'file')
        host.handle(message({ type: 'fileStored', path: each.path, ok: true }));
      else later.push(each);
    }
  };
  const later: FromEditor[] = [];
  return { host, sent, bytes, editor, storeFiles, later };
}

const message = (body: Record<string, unknown>): ToEditor =>
  ({ v: 1, noteId: NOTE, ...body }) as unknown as ToEditor;

/** Lets the page's promises run (a lazy import, hashing, the app's answers). */
const settle = async (times = 20) => {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

/** The note's drawings as markdown would name them: picture, then scene. */
function drawings(editor: ReturnType<typeof opened>['editor']): Array<[string, string]> {
  const found: Array<[string, string]> = [];
  editor.state.doc.descendants((node) => {
    const link = node.marks.find((mark) => mark.type.name === 'link');
    if (node.type.name === 'image' && link) {
      found.push([node.attrs['src'] as string, link.attrs['href'] as string]);
    }
  });
  return found;
}

describe('drawings on Android (PEN-189)', () => {
  it('offers Diagram: Excalidraw in the + sheet and the slash menu', () => {
    const { host, sent } = opened();
    host.handle(message({ type: 'blocks', purpose: 'insert', query: 'excalidraw' }));
    const blocks = sent.filter((each) => each.type === 'blocks').at(-1) as Extract<
      FromEditor,
      { type: 'blocks' }
    >;
    expect(blocks.items.map((item) => item.label)).toContain('Diagram: Excalidraw');
  });

  it('opens over the note, and Done stores both files and puts the drawing in', async () => {
    const { host, sent, bytes, editor, storeFiles, later } = opened();
    host.handle(message({ type: 'insert', item: 'drawing' }));
    await settle();
    expect(editors.opened).toEqual([{ scene: null, title: 'New Excalidraw Diagram' }]);
    expect(sent).toContainEqual({
      v: 1,
      type: 'drawing',
      title: 'New Excalidraw Diagram',
      saving: false,
    });

    host.handle({ v: 1, type: 'drawing', action: 'done' });
    for (let i = 0; i < 4; i++) {
      await settle();
      storeFiles();
    }
    const files = later.filter((each) => each.type === 'file');
    expect(files).toEqual([]);
    expect(bytes).toHaveLength(2);
    const [[svg, scene]] = drawings(editor) as [[string, string]];
    expect(svg).toMatch(/^attachments\/[0-9a-f]{64}\.svg$/);
    expect(scene).toMatch(/^attachments\/[0-9a-f]{64}\.excalidraw$/);
    expect(new TextDecoder().decode(bytes[0])).toBe('{"type":"excalidraw","elements":[{}]}');
    expect(new TextDecoder().decode(bytes[1])).toBe('<svg>1</svg>');
    expect(editors.closed).toBe(1);
    // The bar's buttons waited while Done was saved, and the drawing was kept.
    expect(later).toContainEqual({
      v: 1,
      type: 'drawing',
      title: 'New Excalidraw Diagram',
      saving: true,
    });
    expect(later).toContainEqual({ v: 1, type: 'drawing', title: null, kept: true });
  });

  it('Cancel, or a new drawing left empty, puts nothing in the note', async () => {
    const { host, sent, bytes, editor } = opened();
    host.handle(message({ type: 'insert', item: 'drawing' }));
    await settle();
    host.handle({ v: 1, type: 'drawing', action: 'cancel' });
    await settle();
    expect(drawings(editor)).toEqual([]);
    expect(editors.closed).toBe(1);
    expect(sent).toContainEqual({ v: 1, type: 'drawing', title: null, kept: false });

    editors.take = () => Promise.resolve(null);
    host.handle(message({ type: 'insert', item: 'drawing' }));
    await settle();
    host.handle({ v: 1, type: 'drawing', action: 'done' });
    await settle();
    expect(drawings(editor)).toEqual([]);
    expect(bytes).toEqual([]);
    expect(editors.closed).toBe(2);
  });

  it('a drawing that could not be saved keeps the editor open, with a notice', async () => {
    const { host, sent, editor } = opened();
    editors.take = () => Promise.reject(new Error('the export failed'));
    host.handle(message({ type: 'insert', item: 'drawing' }));
    await settle();
    host.handle({ v: 1, type: 'drawing', action: 'done' });
    await settle();
    expect(editors.closed).toBe(0);
    expect(sent).toContainEqual(
      expect.objectContaining({
        type: 'notice',
        message: "The drawing couldn't be saved: the export failed",
      }),
    );
    host.handle({ v: 1, type: 'drawing', action: 'cancel' });
    await settle();
    expect(editors.closed).toBe(1);
    expect(drawings(editor)).toEqual([]);
  });

  it('a file the phone could not store keeps the editor open too, and Done again saves it', async () => {
    const { host, sent, editor, storeFiles, later } = opened();
    host.handle(message({ type: 'insert', item: 'drawing' }));
    await settle();
    host.handle({ v: 1, type: 'drawing', action: 'done' });
    for (let i = 0; i < 4; i++) {
      await settle();
      for (const each of sent.splice(0)) {
        if (each.type === 'file')
          host.handle(message({ type: 'fileStored', path: each.path, ok: false }));
        else later.push(each);
      }
    }
    expect(editors.closed).toBe(0);
    const notices = later.flatMap((each) => (each.type === 'notice' ? [each.message] : []));
    expect(notices.some((each) => each.startsWith("The drawing couldn't be saved"))).toBe(true);
    expect(later.at(-1)).toEqual({
      v: 1,
      type: 'drawing',
      title: 'New Excalidraw Diagram',
      saving: false,
    });
    host.handle({ v: 1, type: 'drawing', action: 'done' });
    for (let i = 0; i < 4; i++) {
      await settle();
      storeFiles();
    }
    expect(editors.closed).toBe(1);
    expect(drawings(editor)).toHaveLength(1);
  });

  it('Edit asks the app for the scene and opens it; a scene the phone lacks is said', async () => {
    const { host, sent, editor } = opened();
    const scene = `attachments/${'5'.repeat(64)}.excalidraw`;
    const svg = `attachments/${'6'.repeat(64)}.svg`;
    editor.commands.insertContent({
      type: 'paragraph',
      content: [
        {
          type: 'image',
          attrs: { src: svg, alt: 'Excalidraw Diagram' },
          marks: [{ type: 'link', attrs: { href: scene } }],
        },
      ],
    });
    await settle();
    const button = document.querySelector<HTMLButtonElement>('.pm-drawing-edit');
    expect(button).not.toBeNull();
    button!.click();
    await settle();
    expect(sent).toContainEqual({ v: 1, type: 'drawingScene', noteId: NOTE, path: scene });
    host.handle(message({ type: 'drawingScene', path: scene, text: '{"type":"excalidraw"}' }));
    await settle();
    expect(editors.opened).toEqual([
      { scene: '{"type":"excalidraw"}', title: 'Edit Excalidraw Diagram' },
    ]);
    host.handle({ v: 1, type: 'drawing', action: 'cancel' });
    await settle();
    expect(drawings(editor)).toEqual([[svg, scene]]);

    document.querySelector<HTMLButtonElement>('.pm-drawing-edit')!.click();
    await settle();
    host.handle(message({ type: 'drawingScene', path: scene, text: null }));
    await settle();
    expect(editors.opened).toHaveLength(1);
    expect(sent).toContainEqual(
      expect.objectContaining({
        type: 'notice',
        message: "This drawing's file isn't on this phone yet",
      }),
    );
  });

  it('asks for a scene linked from a folder by its path in the notebook', async () => {
    const { sent, editor } = opened();
    const sha = '7'.repeat(64);
    editor.commands.insertContent({
      type: 'paragraph',
      content: [
        {
          type: 'image',
          attrs: { src: `../attachments/${'8'.repeat(64)}.svg`, alt: 'Excalidraw Diagram' },
          marks: [{ type: 'link', attrs: { href: `../attachments/${sha}.excalidraw` } }],
        },
      ],
    });
    await settle();
    document.querySelector<HTMLButtonElement>('.pm-drawing-edit')!.click();
    await settle();
    expect(sent).toContainEqual({
      v: 1,
      type: 'drawingScene',
      noteId: NOTE,
      path: `attachments/${sha}.excalidraw`,
    });
  });

  it('closing the note closes a drawing open over it, as Cancel', async () => {
    const { host, editor } = opened();
    host.handle(message({ type: 'insert', item: 'drawing' }));
    await settle();
    host.handle(message({ type: 'close' }));
    await settle();
    expect(editors.closed).toBe(1);
    expect(drawings(editor)).toEqual([]);
  });

  it('closing the note while Done is saved closes the drawing once the save gives up', async () => {
    const { host } = opened();
    let fail: (error: Error) => void = () => {};
    editors.take = () => new Promise((_, reject) => (fail = reject));
    host.handle(message({ type: 'insert', item: 'drawing' }));
    await settle();
    host.handle({ v: 1, type: 'drawing', action: 'done' });
    await settle();
    host.handle(message({ type: 'close' }));
    await settle();
    expect(editors.closed).toBe(0);
    fail(new Error('the note has closed'));
    await settle();
    expect(editors.closed).toBe(1);
  });
});
