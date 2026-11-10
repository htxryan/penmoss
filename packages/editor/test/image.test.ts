import { createYjs14Replica } from '@penmoss/sync-client/yjs14';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCollabEditor, type CollabEditor } from '../src/collab';
import { noteExtensions } from '../src/extensions';
import type { ImageServices } from '../src/extensions/image';

const HASH = 'a'.repeat(64);
const PATH = `attachments/${HASH}.png`;

const editors: CollabEditor[] = [];
afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
});

function services(overrides: Partial<ImageServices> = {}) {
  const add = vi.fn((bytes: Uint8Array<ArrayBuffer>) => Promise.resolve({ path: PATH, bytes }));
  const resolve = vi.fn((src: string, signal: AbortSignal) =>
    Promise.resolve(signal.aborted ? null : `blob:local/${src}`),
  );
  const onError = vi.fn((message: string) => message);
  const release = vi.fn((src: string) => src);
  const images: ImageServices = { add, resolve, onError, release, ...overrides };
  return { images, add, resolve, onError, release };
}

function open(images: ImageServices, replica = createYjs14Replica()): CollabEditor {
  const element = document.createElement('div');
  document.body.append(element);
  const collab = createCollabEditor({ element, extensions: noteExtensions({ images }), replica });
  editors.push(collab);
  return collab;
}

const imageDoc = (attrs: Record<string, unknown>) => [
  {
    type: 'paragraph',
    content: [
      { type: 'text', text: 'see ' },
      { type: 'image', attrs },
    ],
  },
];

/** A ClipboardEvent stand-in carrying files (happy-dom's DataTransfer holds none). */
function pasteEvent(files: File[], data: Record<string, string> = {}): ClipboardEvent {
  const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent;
  Object.defineProperty(event, 'clipboardData', {
    value: { files, getData: (type: string) => data[type] ?? '' },
  });
  return event;
}

const png = () =>
  new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2])], 'shot.png', {
    type: 'image/png',
  });

describe('image node', () => {
  it('renders an attachment from the resolved URL without writing to the document', async () => {
    const { images, resolve } = services();
    const a = open(images);
    a.editor.commands.setContent(imageDoc({ src: PATH, alt: 'Chart', width: 240 }));
    const b = createYjs14Replica();
    b.applyUpdate(a.replica.encodeStateAsUpdate(), 'remote');
    const updates: Uint8Array[] = [];
    b.onUpdate((update) => updates.push(update));

    const view = open(images, b);
    const img = view.editor.view.dom.querySelector('img')!;
    await vi.waitFor(() => expect(img.getAttribute('src')).toBe(`blob:local/${PATH}`));

    expect(img.alt).toBe('Chart');
    expect(img.style.width).toBe('240px');
    expect(resolve).toHaveBeenCalledWith(PATH, expect.any(AbortSignal));
    expect(updates).toEqual([]);
  });

  it('shows the alt text when the image is unavailable', async () => {
    const collab = open(services({ resolve: () => Promise.resolve(null) }).images);
    collab.editor.commands.setContent(imageDoc({ src: PATH, alt: 'Lost' }));
    const wrapper = collab.editor.view.dom.querySelector<HTMLElement>('.pm-image')!;
    await vi.waitFor(() => expect(wrapper.dataset['state']).toBe('missing'));
    expect(wrapper.querySelector('.pm-image-fallback')?.textContent).toBe('Lost');
  });

  it('edits alt text and width from the fields shown while selected', () => {
    const collab = open(services().images);
    collab.editor.commands.setContent(imageDoc({ src: PATH, alt: '' }));
    const { view } = collab.editor;
    const pos = 5; // after "see "
    view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, pos)));
    const tools = view.dom.querySelector<HTMLElement>('.pm-image-tools')!;
    expect(tools.hidden).toBe(false);

    const alt = tools.querySelector<HTMLInputElement>('.pm-image-alt')!;
    const width = tools.querySelector<HTMLInputElement>('.pm-image-width')!;
    alt.value = 'A bar chart';
    width.value = '320';
    alt.dispatchEvent(new Event('change'));

    expect(view.state.doc.nodeAt(pos)?.attrs).toMatchObject({ alt: 'A bar chart', width: 320 });
    expect(collab.replica.plainText()).toBeDefined();
    // The image stays selected so the fields stay open.
    expect(view.state.selection).toBeInstanceOf(NodeSelection);
  });

  it('puts the caret after a picture on a click in the empty rest of its line (PEN-66)', () => {
    const collab = open(services().images);
    collab.editor.commands.setContent(imageDoc({ src: PATH, alt: '' }));
    const { view } = collab.editor;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1)));
    const picture = view.dom.querySelector<HTMLElement>('.pm-image')!;

    // The box itself, beside the picture: the caret goes after it, and the editor leaves it be.
    const beside = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 });
    picture.dispatchEvent(beside);
    expect(beside.defaultPrevented).toBe(true);
    expect(view.state.selection).toBeInstanceOf(TextSelection);
    expect(view.state.selection.from).toBe(6); // after "see " and the picture

    // The picture itself is the editor's to select, as before.
    const img = picture.querySelector('img')!;
    const onPicture = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 });
    img.dispatchEvent(onPicture);
    expect(onPicture.defaultPrevented).toBe(false);
  });

  it('stores a pasted screenshot and inserts it at the cursor', async () => {
    const { images, add } = services();
    const collab = open(images);
    collab.editor.commands.setContent([
      { type: 'paragraph', content: [{ type: 'text', text: 'x' }] },
    ]);
    collab.editor.commands.setTextSelection(2);

    const event = pasteEvent([png()]);
    collab.editor.view.dom.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    await vi.waitFor(() =>
      expect(collab.editor.getJSON().content?.[0]?.content?.[1]).toEqual({
        type: 'image',
        attrs: { src: PATH, alt: '', title: null, width: null, height: null },
      }),
    );
    const bytes = add.mock.calls[0]![0];
    expect([...bytes.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it('leaves a paste with text (and a picture of it, as Office sends) to the editor', async () => {
    const { images, add } = services();
    const collab = open(images);
    const event = pasteEvent([png()], { 'text/html': '<p>Quarterly numbers</p>' });
    collab.editor.view.dom.dispatchEvent(event);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(add).not.toHaveBeenCalled();
    expect(collab.editor.getText()).toContain('Quarterly numbers');
  });

  it('reports an image that cannot be added', async () => {
    const { images, onError } = services({
      add: () => Promise.reject(new Error('Images over 50 MB cannot be added')),
    });
    const collab = open(images);
    collab.editor.view.dom.dispatchEvent(pasteEvent([png()]));
    await vi.waitFor(() =>
      expect(onError).toHaveBeenCalledWith('Images over 50 MB cannot be added'),
    );
    expect(collab.editor.view.dom.querySelector('img')).toBeNull();
  });

  it('releases the URL it was given when the view goes away or the source changes', async () => {
    const { images, release } = services();
    const collab = open(images);
    collab.editor.commands.setContent(imageDoc({ src: PATH, alt: '' }));
    const img = collab.editor.view.dom.querySelector('img')!;
    await vi.waitFor(() => expect(img.getAttribute('src')).toBe(`blob:local/${PATH}`));

    const other = `attachments/${'b'.repeat(64)}.png`;
    const { view } = collab.editor;
    view.dispatch(view.state.tr.setNodeAttribute(5, 'src', other));
    expect(release).toHaveBeenCalledWith(PATH);
    await vi.waitFor(() => expect(img.getAttribute('src')).toBe(`blob:local/${other}`));

    collab.editor.commands.setContent([{ type: 'paragraph' }]);
    expect(release).toHaveBeenCalledWith(other);
    expect(release).toHaveBeenCalledTimes(2);
  });

  it('releases a URL that arrives after the view went away', async () => {
    let finish: (url: string) => void = () => undefined;
    const { images, release } = services({
      resolve: () => new Promise<string | null>((resolve) => (finish = resolve)),
    });
    const collab = open(images);
    collab.editor.commands.setContent(imageDoc({ src: PATH, alt: '' }));
    collab.editor.commands.setContent([{ type: 'paragraph' }]);
    expect(release).not.toHaveBeenCalled();

    finish(`blob:late/${PATH}`);
    await vi.waitFor(() => expect(release).toHaveBeenCalledWith(PATH));
  });

  it('takes the file from a paste whose HTML is only the image (a browser "Copy image")', async () => {
    const { images, add } = services();
    const collab = open(images);
    const html = '<meta charset="utf-8"><img src="https://example.com/cat.png" alt="cat"/>';
    collab.editor.view.dom.dispatchEvent(pasteEvent([png()], { 'text/html': html }));
    await vi.waitFor(() => expect(add).toHaveBeenCalledTimes(1));
  });

  it('leaves a paragraph with an inline picture (Word, Docs, Outlook) to the normal paste', async () => {
    const { images, add } = services();
    const collab = open(images);
    const html =
      '<html><body><!--StartFragment--><p>Q3 results <img src="cid:chart"> look good&nbsp;</p><!--EndFragment--></body></html>';
    const event = pasteEvent([png()], { 'text/html': html, 'text/plain': 'Q3 results look good' });
    collab.editor.view.dom.dispatchEvent(event);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(add).not.toHaveBeenCalled();
    expect(collab.editor.getText()).toContain('Q3 results');
  });

  it('inserts a dropped image where it was dropped, even if the note changed meanwhile', async () => {
    let finish: ((value: { path: string }) => void) | null = null;
    const { images } = services({
      add: () => new Promise((resolve) => (finish = resolve)),
    });
    const collab = open(images);
    collab.editor.commands.setContent([
      { type: 'paragraph', content: [{ type: 'text', text: 'abcdef' }] },
    ]);
    const { view } = collab.editor;
    // happy-dom has no layout: the drop lands between "abc" and "def".
    view.posAtCoords = () => ({ pos: 4, inside: -1 });
    const drop = new Event('drop', { bubbles: true, cancelable: true }) as DragEvent;
    Object.defineProperty(drop, 'dataTransfer', {
      value: { files: [png()], getData: () => '', types: ['Files'] },
    });
    view.dom.dispatchEvent(drop);
    expect(drop.defaultPrevented).toBe(true);

    // Someone types at the start while the image is being stored.
    await vi.waitFor(() => expect(finish).not.toBeNull());
    view.dispatch(view.state.tr.insertText('XY', 1));
    finish!({ path: PATH });

    await vi.waitFor(() => expect(view.state.doc.firstChild?.childCount).toBe(3));
    const para = view.state.doc.firstChild!;
    expect(para.child(0).text).toBe('XYabc');
    expect(para.child(1).type.name).toBe('image');
    expect(para.child(2).text).toBe('def');
  });

  it('puts the old width back when a resize is cancelled', () => {
    const collab = open(services().images);
    collab.editor.commands.setContent(imageDoc({ src: PATH, alt: '', width: 240 }));
    const wrapper = collab.editor.view.dom.querySelector<HTMLElement>('.pm-image')!;
    const img = wrapper.querySelector('img')!;
    const handle = wrapper.querySelector<HTMLElement>('.pm-image-resize')!;
    const pointer = (type: string, clientX: number) =>
      new PointerEvent(type, { bubbles: true, cancelable: true, clientX, button: 0, pointerId: 1 });

    handle.dispatchEvent(pointer('pointerdown', 300));
    handle.dispatchEvent(pointer('pointermove', 200));
    expect(img.style.width).not.toBe('240px');
    handle.dispatchEvent(pointer('pointercancel', 200));

    expect(img.style.width).toBe('240px');
    expect(collab.editor.view.state.doc.nodeAt(5)?.attrs['width']).toBe(240);
  });

  describe('pictures from web addresses in an app shell (T40 P8, ED13)', () => {
    const WEB = 'https://example.com/cat.png';

    it('loads the address itself without the hook, as on the web', () => {
      const collab = open(services().images);
      collab.editor.commands.setContent(imageDoc({ src: WEB, alt: 'Cat' }));
      expect(collab.editor.view.dom.querySelector('img')!.getAttribute('src')).toBe(WEB);
    });

    it("shows the shell's URL, never the address", () => {
      const web = vi.fn((src: string) => ({ url: `/remote?u=${encodeURIComponent(src)}` }));
      const { images, resolve } = services({ web });
      const collab = open(images);
      collab.editor.commands.setContent(imageDoc({ src: WEB, alt: 'Cat' }));
      const img = collab.editor.view.dom.querySelector('img')!;
      expect(img.getAttribute('src')).toBe(`/remote?u=${encodeURIComponent(WEB)}`);
      expect(web).toHaveBeenCalledWith(WEB, false);
      expect(resolve).not.toHaveBeenCalled();
    });

    it('shows the alt text when web pictures are off', () => {
      const collab = open(services({ web: () => null }).images);
      collab.editor.commands.setContent(imageDoc({ src: WEB, alt: 'Cat' }));
      const wrapper = collab.editor.view.dom.querySelector<HTMLElement>('.pm-image')!;
      expect(wrapper.dataset['state']).toBe('missing');
      expect(wrapper.querySelector('img')!.hasAttribute('src')).toBe(false);
      expect(wrapper.querySelector<HTMLButtonElement>('.pm-image-load')!.hidden).toBe(true);
    });

    it('waits for a tap, then loads that picture only', () => {
      const web = vi.fn((src: string, now: boolean) =>
        now ? { url: `/remote?now=1&u=${src}` } : ('wait' as const),
      );
      const collab = open(services({ web }).images);
      collab.editor.commands.setContent(imageDoc({ src: WEB, alt: 'Cat' }));
      const wrapper = collab.editor.view.dom.querySelector<HTMLElement>('.pm-image')!;
      const button = wrapper.querySelector<HTMLButtonElement>('.pm-image-load')!;
      expect(wrapper.dataset['state']).toBe('waiting');
      expect(button.hidden).toBe(false);
      expect(button.textContent).toBe('Tap to Load');
      expect(button.getAttribute('aria-label')).toBe('Load the Picture Cat');
      const before = JSON.stringify(collab.editor.getJSON());

      button.click();
      expect(web).toHaveBeenLastCalledWith(WEB, true);
      expect(wrapper.querySelector('img')!.getAttribute('src')).toBe(`/remote?now=1&u=${WEB}`);
      expect(button.hidden).toBe(true);
      // Loading a picture never writes to the note.
      expect(JSON.stringify(collab.editor.getJSON())).toBe(before);
    });

    it('asks the hook for web addresses only: attachments still resolve', async () => {
      const web = vi.fn(() => 'wait' as const);
      const { images, resolve } = services({ web });
      const collab = open(images);
      collab.editor.commands.setContent(imageDoc({ src: PATH, alt: '' }));
      await vi.waitFor(() => expect(resolve).toHaveBeenCalled());
      expect(web).not.toHaveBeenCalled();
    });
  });
});
