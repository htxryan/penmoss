import { createYjs14Replica } from '@penmoss/sync-client/yjs14';
import { NodeSelection } from '@tiptap/pm/state';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCollabEditor, type CollabEditor } from '../src/collab';
import { noteExtensions } from '../src/extensions';
import type { ImageServices } from '../src/extensions/image';
import {
  MAX_ZOOM,
  openLightbox,
  openLightboxNow,
  setLightboxHooks,
  ZOOM_STEP,
} from '../src/lightbox';

// The image lightbox (T51 item 20, A948).

const pictures = [
  { src: 'blob:one', alt: 'First chart' },
  { src: 'blob:two', alt: '' },
  { src: 'blob:three', alt: 'Third' },
];

const editors: CollabEditor[] = [];
afterEach(() => {
  openLightboxNow()?.close();
  for (const editor of editors.splice(0)) editor.destroy();
  document.body.replaceChildren();
});

const key = (target: EventTarget, key: string, init: KeyboardEventInit = {}) => {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
};

/** A mouse click as the browser makes one: pressed and released on `target`, then the click. */
const press = (target: HTMLElement) => {
  const init = { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', button: 0 };
  target.dispatchEvent(new PointerEvent('pointerdown', init));
  target.dispatchEvent(new PointerEvent('pointerup', init));
  target.click();
};

/** A double click as the browser makes one: two presses, then the `dblclick`. */
const doubleClick = (target: HTMLElement) => {
  press(target);
  press(target);
  target.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
};

describe('openLightbox', () => {
  it('opens a modal dialog named by the alt text, and closes back to the opener', () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    const onClose = vi.fn();
    const box = openLightbox({ images: pictures, index: 0, onClose });

    const root = document.querySelector<HTMLElement>('[data-testid="lightbox"]')!;
    expect(root).toBe(box.element);
    expect(root.getAttribute('role')).toBe('dialog');
    expect(root.getAttribute('aria-modal')).toBe('true');
    const label = document.getElementById(root.getAttribute('aria-labelledby')!);
    expect(label?.textContent).toBe('First chart');
    expect(root.querySelector('img')?.getAttribute('src')).toBe('blob:one');
    expect(root.contains(document.activeElement)).toBe(true);

    root.querySelector<HTMLButtonElement>('[aria-label="Close"]')!.click();
    expect(box.open).toBe(false);
    expect(document.querySelector('[data-testid="lightbox"]')).toBeNull();
    expect(document.activeElement).toBe(opener);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('is named plainly for a picture without alt text', () => {
    const box = openLightbox({ images: pictures, index: 1 });
    expect(box.element.getAttribute('aria-label')).toBe('Image');
    expect(box.element.hasAttribute('aria-labelledby')).toBe(false);
  });

  it('zooms with the buttons and keys, within its limits, and Reset fits it again', () => {
    const box = openLightbox({ images: pictures, index: 0 });
    const root = box.element;
    const zoomIn = root.querySelector<HTMLButtonElement>('[aria-label="Zoom In"]')!;
    const zoomOut = root.querySelector<HTMLButtonElement>('[aria-label="Zoom Out"]')!;
    const level = root.querySelector('[data-testid="lightbox-zoom"]')!;
    expect(box.zoom).toBe(1);
    expect(zoomOut.disabled).toBe(true);
    expect(level.textContent).toBe('100%');

    zoomIn.click();
    expect(box.zoom).toBe(ZOOM_STEP);
    expect(level.textContent).toBe('150%');
    expect(root.querySelector('img')!.style.transform).toContain(`scale(${ZOOM_STEP})`);
    key(root, '+');
    expect(box.zoom).toBeCloseTo(ZOOM_STEP * ZOOM_STEP);
    for (let i = 0; i < 10; i++) zoomIn.click();
    expect(box.zoom).toBe(MAX_ZOOM);
    expect(zoomIn.disabled).toBe(true);

    key(root, '-');
    expect(box.zoom).toBeCloseTo(MAX_ZOOM / ZOOM_STEP);
    key(root, '0');
    expect(box.zoom).toBe(1);
    expect(box.offset).toEqual({ x: 0, y: 0 });

    zoomIn.click();
    root.querySelector<HTMLButtonElement>('[aria-label="Reset"]')!.click();
    expect(box.zoom).toBe(1);
  });

  it('keeps focus inside when a pressed button turns itself off (Reset, Zoom In at the most)', () => {
    const box = openLightbox({ images: pictures, index: 0 });
    const root = box.element;
    root.querySelector<HTMLButtonElement>('[aria-label="Zoom In"]')!.click();
    const reset = root.querySelector<HTMLButtonElement>('[aria-label="Reset"]')!;
    reset.focus();
    reset.click();
    expect(reset.disabled).toBe(true);
    // Not left on a disabled button, where the page would take it: the keys still reach it.
    expect(document.activeElement).toBe(root);
    key(document.activeElement!, 'ArrowRight');
    expect(box.index).toBe(1);
  });

  it('zooms at a point, keeping that point under it', () => {
    const box = openLightbox({ images: pictures, index: 0 });
    box.zoomBy(2, { x: 100, y: -50 });
    expect(box.zoom).toBe(2);
    // The point 100 px right of centre stays there: the picture moved left by as much.
    expect(box.offset).toEqual({ x: -100, y: 50 });
    box.zoomBy(0.5);
    expect(box.offset).toEqual({ x: 0, y: 0 });
  });

  it('zooms with the wheel', () => {
    const box = openLightbox({ images: pictures, index: 0 });
    const stage = box.element.querySelector('.pm-lightbox-stage')!;
    const wheel = new WheelEvent('wheel', { deltaY: -100, ctrlKey: true, cancelable: true });
    stage.dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(true);
    expect(box.zoom).toBeGreaterThan(1);
  });

  it('steps through the pictures with the arrow keys and buttons, wrapping around', () => {
    const box = openLightbox({ images: pictures, index: 0 });
    const root = box.element;
    const img = root.querySelector('img')!;
    const count = root.querySelector('.pm-lightbox-count')!;
    expect(count.textContent).toBe('1 of 3');
    box.zoomBy(2);

    key(root, 'ArrowRight');
    expect(box.index).toBe(1);
    expect(img.getAttribute('src')).toBe('blob:two');
    // A new picture shows fitted.
    expect(box.zoom).toBe(1);
    expect(count.textContent).toBe('2 of 3');

    key(root, 'ArrowLeft');
    key(root, 'ArrowLeft');
    expect(box.index).toBe(2);
    expect(img.getAttribute('src')).toBe('blob:three');

    root.querySelector<HTMLButtonElement>('[aria-label="Next Image"]')!.click();
    expect(box.index).toBe(0);
  });

  it('hides stepping for a single picture', () => {
    const box = openLightbox({ images: [pictures[0]!], index: 0 });
    expect(box.element.querySelector<HTMLElement>('[aria-label="Next Image"]')!.hidden).toBe(true);
    key(box.element, 'ArrowRight');
    expect(box.index).toBe(0);
  });

  it('closes on Escape and on a click on the backdrop, not on the picture', () => {
    let box = openLightbox({ images: pictures, index: 0 });
    const escape = key(box.element, 'Escape');
    expect(escape.defaultPrevented).toBe(true);
    expect(box.open).toBe(false);

    box = openLightbox({ images: pictures, index: 0 });
    press(box.element.querySelector('img')!);
    expect(box.open).toBe(true);
    press(box.element.querySelector<HTMLElement>('.pm-lightbox-stage')!);
    expect(box.open).toBe(false);
  });

  it('stays open for the click a phone sends after the double tap that opened it', () => {
    const box = openLightbox({ images: pictures, index: 0 });
    // Pressed on the note's picture, before the lightbox was there: it lands on the backdrop.
    box.element.querySelector<HTMLElement>('.pm-lightbox-stage')!.click();
    expect(box.open).toBe(true);
    box.element.click();
    expect(box.open).toBe(true);
    press(box.element.querySelector<HTMLElement>('.pm-lightbox-stage')!);
    expect(box.open).toBe(false);
  });

  it('keeps Tab inside the dialog', () => {
    const box = openLightbox({ images: pictures, index: 0 });
    const root = box.element;
    const buttons = [...root.querySelectorAll<HTMLButtonElement>('button')].filter(
      (button) => !button.hidden && !button.disabled,
    );
    buttons.at(-1)!.focus();
    key(buttons.at(-1)!, 'Tab');
    expect(document.activeElement).toBe(buttons[0]);
    key(buttons[0]!, 'Tab', { shiftKey: true });
    expect(document.activeElement).toBe(buttons.at(-1));
  });

  it('hides Full Screen where the platform has none', () => {
    const box = openLightbox({ images: pictures, index: 0 });
    const full = box.element.querySelector<HTMLElement>('.pm-lightbox-full')!;
    expect(full.hidden).toBe(document.fullscreenEnabled !== true);
  });

  it('toggles twice the size on a double click of the picture', () => {
    const box = openLightbox({ images: pictures, index: 0 });
    const img = box.element.querySelector('img')!;
    doubleClick(img);
    expect(box.zoom).toBe(2);
    doubleClick(img);
    expect(box.zoom).toBe(1);
  });

  it('opens fitted after the double tap that opened it: its own dblclick does not zoom (T51)', () => {
    const box = openLightbox({ images: pictures, index: 0 });
    const img = box.element.querySelector('img')!;
    // Pressed on the note's picture, before the lightbox was there.
    img.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    expect(box.zoom).toBe(1);
    doubleClick(img);
    expect(box.zoom).toBe(2);
  });

  it('tells the host while it is open, so the app’s shortcuts wait (T51 review)', () => {
    const undo = vi.fn();
    const onOpen = vi.fn(() => undo);
    const off = setLightboxHooks({ onOpen });
    try {
      const box = openLightbox({ images: pictures, index: 0 });
      expect(onOpen).toHaveBeenCalledWith(box);
      expect(undo).not.toHaveBeenCalled();
      box.close();
      expect(undo).toHaveBeenCalledTimes(1);
      box.close();
      expect(undo).toHaveBeenCalledTimes(1);
      // Opening another closes the first: its undo runs before the second's open.
      openLightbox({ images: pictures, index: 0 });
      openLightbox({ images: pictures, index: 1 });
      expect(onOpen).toHaveBeenCalledTimes(3);
      expect(undo).toHaveBeenCalledTimes(2);
    } finally {
      off();
    }
  });

  it('removes its listeners from the page when it closes', () => {
    const added = vi.spyOn(document, 'addEventListener');
    const removed = vi.spyOn(document, 'removeEventListener');
    const box = openLightbox({ images: pictures, index: 0 });
    const types = added.mock.calls.map(([type, listener]) => ({ type, listener }));
    box.close();
    for (const { type, listener } of types) {
      expect(removed.mock.calls.some(([t, l]) => t === type && l === listener)).toBe(true);
    }
    added.mockRestore();
    removed.mockRestore();
  });

  it('skips a picture that left the note when stepping', () => {
    const sources = pictures.map((picture) => {
      const img = document.createElement('img');
      img.src = picture.src;
      document.body.append(img);
      return { ...picture, source: img };
    });
    const box = openLightbox({ images: sources, index: 0 });
    sources[1]!.source.remove();
    key(box.element, 'ArrowRight');
    expect(box.index).toBe(2);
    key(box.element, 'ArrowRight');
    expect(box.index).toBe(0);
    // With none other left, it stays.
    sources[2]!.source.remove();
    key(box.element, 'ArrowLeft');
    expect(box.index).toBe(0);
  });

  it('opens one at a time', () => {
    const first = openLightbox({ images: pictures, index: 0 });
    const second = openLightbox({ images: pictures, index: 1 });
    expect(first.open).toBe(false);
    expect(openLightboxNow()).toBe(second);
    expect(document.querySelectorAll('[data-testid="lightbox"]')).toHaveLength(1);
  });
});

describe('an image in a note', () => {
  const HASH = 'a'.repeat(64);
  const PATH = `attachments/${HASH}.png`;
  const OTHER = `attachments/${'b'.repeat(64)}.png`;
  const images: ImageServices = {
    add: () => Promise.resolve({ path: PATH }),
    resolve: (src) => Promise.resolve(`blob:local/${src}`),
  };

  async function note(editable = true) {
    const element = document.createElement('div');
    document.body.append(element);
    const collab = createCollabEditor({
      element,
      extensions: noteExtensions({ images }),
      replica: createYjs14Replica(),
    });
    editors.push(collab);
    collab.editor.commands.setContent([
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'see ' },
          { type: 'image', attrs: { src: PATH, alt: 'Chart' } },
          { type: 'text', text: ' and ' },
          { type: 'image', attrs: { src: OTHER, alt: 'Graph' } },
        ],
      },
    ]);
    const imgs = [...collab.editor.view.dom.querySelectorAll('img')];
    await vi.waitFor(() => expect(imgs.every((img) => img.getAttribute('src'))).toBe(true));
    // happy-dom loads no pictures: as the browser would once they arrived.
    for (const img of imgs) img.dispatchEvent(new Event('load'));
    if (!editable) collab.editor.setEditable(false);
    return { collab, imgs };
  }

  it('opens from Open in Lightbox in its tools, on its own picture of the note', async () => {
    const { collab } = await note();
    const { view } = collab.editor;
    const pos = 1 + 4 + 1 + 5; // the paragraph, "see ", the first image, " and "
    view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, pos)));
    const tools = view.dom.querySelectorAll<HTMLElement>('.pm-image-tools')[1]!;
    expect(tools.hidden).toBe(false);
    const button = tools.querySelector<HTMLButtonElement>('[data-testid="image-lightbox"]')!;
    expect(button.textContent).toBe('Open in Lightbox');
    button.click();

    const box = openLightboxNow()!;
    expect(box).not.toBeNull();
    expect(box.index).toBe(1);
    // Its opener is the button, where focus goes back, even where a click left it in the note.
    expect(box.element.contains(document.activeElement)).toBe(true);
    expect(box.element.querySelector('img')!.getAttribute('src')).toBe(`blob:local/${OTHER}`);
    key(box.element, 'ArrowRight');
    expect(box.element.querySelector('img')!.getAttribute('src')).toBe(`blob:local/${PATH}`);
    key(box.element, 'Escape');
    expect(document.activeElement).toBe(button);
  });

  it('opens on a double click, in a read-only note too', async () => {
    const { imgs } = await note(false);
    imgs[0]!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    const box = openLightboxNow()!;
    expect(box?.index).toBe(0);
    expect(box.element.getAttribute('aria-labelledby')).toBeTruthy();
  });

  it('closes when the note’s editor goes (T51 review)', async () => {
    const { collab, imgs } = await note();
    imgs[0]!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    const box = openLightboxNow()!;
    expect(box.open).toBe(true);
    collab.editor.view.dom.parentElement!.remove();
    collab.destroy();
    editors.splice(editors.indexOf(collab), 1);
    await Promise.resolve();
    expect(box.open).toBe(false);
    expect(document.querySelector('[data-testid="lightbox"]')).toBeNull();
  });

  it('stays open when only another picture of the note goes', async () => {
    const { collab, imgs } = await note();
    imgs[0]!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    const box = openLightboxNow()!;
    const { view } = collab.editor;
    // The second picture (after "see ", the first, " and ") is deleted.
    view.dispatch(view.state.tr.delete(11, 12));
    await Promise.resolve();
    expect(box.open).toBe(true);
    // Stepping skips it: only the first is left.
    key(box.element, 'ArrowRight');
    expect(box.index).toBe(0);
  });

  it('shows only Open in Lightbox in a read-only note’s tools', async () => {
    const { collab } = await note(false);
    const { view } = collab.editor;
    view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, 5)));
    const tools = view.dom.querySelector<HTMLElement>('.pm-image-tools')!;
    expect(tools.hidden).toBe(false);
    expect([...tools.querySelectorAll('label')].every((label) => label.hidden)).toBe(true);
    expect(tools.querySelector<HTMLElement>('[data-testid="image-lightbox"]')!.hidden).toBe(false);
  });

  it('does not open while the picture has not loaded', () => {
    const element = document.createElement('div');
    document.body.append(element);
    const collab = createCollabEditor({
      element,
      extensions: noteExtensions({ images: { ...images, resolve: () => Promise.resolve(null) } }),
      replica: createYjs14Replica(),
    });
    editors.push(collab);
    collab.editor.commands.setContent([
      { type: 'paragraph', content: [{ type: 'image', attrs: { src: PATH, alt: 'Lost' } }] },
    ]);
    const img = collab.editor.view.dom.querySelector('img')!;
    img.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    expect(openLightboxNow()).toBeNull();
  });
});
