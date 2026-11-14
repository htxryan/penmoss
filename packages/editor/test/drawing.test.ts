/**
 * Drawings (PEN-28): an SVG picture linked to its Excalidraw scene, shown as a drawing block that
 * opens in the app's drawing editor. The model is core's image with a link mark, so the markdown
 * is `[![Drawing](….svg)](….excalidraw)` and every client keeps it as it is.
 */
import { schema as coreSchema, serializeMarkdown } from '@penmoss/core';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import { describe, expect, it, vi } from 'vitest';
import type { CollabEditor } from '../src/collab';
import { availableBlockItems } from '../src/extensions/block-items';
import {
  drawingNode,
  drawingOf,
  placeDrawing,
  replaceDrawing,
  type DrawingFiles,
  type DrawingServices,
} from '../src/extensions/drawing';
import type { ImageServices } from '../src/extensions/image';
import { noteBody } from '../src/markdown';
import { openEditor, press, type } from './support/editor';

const pair = (svg: string, scene: string): DrawingFiles => ({
  svg: `attachments/${svg.repeat(64)}.svg`,
  scene: `attachments/${scene.repeat(64)}.excalidraw`,
});
const FIRST = pair('a', 'b');
const SECOND = pair('c', 'd');
const LINE = (files: DrawingFiles) => `[![Drawing](${files.svg})](${files.scene})`;

const images = (): ImageServices => ({
  add: vi.fn(() => Promise.resolve({ path: 'attachments/x.png' })),
  resolve: vi.fn((src: string) => Promise.resolve(`data:image/svg+xml;base64,${btoa(src)}`)),
  release: vi.fn(),
});

/** Drawing services whose editor resolves when the test says. */
function drawings() {
  let finish: (files: DrawingFiles | null) => void = () => undefined;
  const edit = vi.fn<DrawingServices['edit']>(
    () =>
      new Promise<DrawingFiles | null>((resolve) => {
        finish = resolve;
      }),
  );
  const services: DrawingServices = { edit };
  return { services, edit, finish: (files: DrawingFiles | null) => finish(files) };
}

const markdownOf = (collab: CollabEditor) =>
  serializeMarkdown({ frontmatter: null, doc: coreSchema.nodeFromJSON(collab.editor.getJSON()) });

/** The markdown of the note as the replica holds it: what is rendered into git. */
const replicaMarkdown = (collab: CollabEditor) =>
  serializeMarkdown({
    frontmatter: null,
    doc: noteBody((collab.replica as unknown as { doc: Parameters<typeof noteBody>[0] }).doc),
  });

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A note with a line of text and a drawing after it. */
function withDrawing(options: Parameters<typeof openEditor>[1] = {}) {
  const collab = openEditor([{ type: 'paragraph', content: [{ type: 'text', text: 'Beds' }] }], {
    images: images(),
    ...options,
  });
  const { view } = collab.editor;
  const tr = view.state.tr;
  placeDrawing(tr, view.state.doc.content.size - 1, FIRST);
  view.dispatch(tr);
  return collab;
}

describe('what a drawing is', () => {
  const { schema } = openEditor().editor;
  const link = (href: string) => schema.marks['link']!.create({ href });
  const image = (src: string, marks = [link(FIRST.scene)]) =>
    schema.nodes['image']!.create({ src }, null, marks);

  it('is an SVG attachment linked to an .excalidraw attachment, with any folder before them', () => {
    expect(drawingOf(drawingNode(schema, FIRST))).toEqual(FIRST);
    const nested = pair('e', 'f');
    const relative = { svg: `../${nested.svg}`, scene: `../${nested.scene}` };
    expect(drawingOf(drawingNode(schema, relative))).toEqual(relative);
  });

  it('is not a picture of another type, an unlinked SVG, or a web address', () => {
    expect(drawingOf(image(`attachments/${'a'.repeat(64)}.png`))).toBeNull();
    expect(drawingOf(image(FIRST.svg, []))).toBeNull();
    expect(drawingOf(image(FIRST.svg, [link('https://example.com/a.excalidraw')]))).toBeNull();
    expect(drawingOf(image('https://example.com/attachments/x.svg'))).toBeNull();
    expect(drawingOf(image(FIRST.svg, [link(`attachments/${'b'.repeat(64)}.json`)]))).toBeNull();
  });
});

describe('a new drawing from the slash menu', () => {
  it('is offered only where the app has a drawing editor, and never in a table cell', () => {
    const without = openEditor(undefined, { images: images() });
    expect(availableBlockItems(without.editor).map((item) => item.id)).not.toContain('drawing');
    const { services } = drawings();
    const collab = openEditor(undefined, { images: images(), drawings: services });
    expect(availableBlockItems(collab.editor).map((item) => item.id)).toContain('drawing');
    type(collab.editor.view, '| a | b |\n');
    expect(availableBlockItems(collab.editor).map((item) => item.id)).not.toContain('drawing');
  });

  it('opens the drawing editor at once and, on Done, puts the drawing on its own line', async () => {
    const { services, edit, finish } = drawings();
    const collab = openEditor(undefined, { images: images(), drawings: services });
    const { view } = collab.editor;
    type(view, 'The beds:\n/drawing');
    expect(press(view, 'Enter')).toBe(true);
    expect(edit).toHaveBeenCalledWith(null);
    // Typed while the editor is open (another device): the drawing still goes where the menu was.
    view.dispatch(view.state.tr.insertText('Plan. ', 1));
    finish(FIRST);
    await flush();
    expect(markdownOf(collab)).toBe(`Plan. The beds:\n\n${LINE(FIRST)}\n`);
    expect(replicaMarkdown(collab)).toBe(`Plan. The beds:\n\n${LINE(FIRST)}\n`);
    const { selection } = view.state;
    expect(selection).toBeInstanceOf(NodeSelection);
    expect(drawingOf((selection as NodeSelection).node)).toEqual(FIRST);
    expect(view.dom.querySelector('[data-testid="drawing"]')).not.toBeNull();
  });

  it('puts nothing in the note when cancelled, and drops the typed /drawing', async () => {
    const { services, finish } = drawings();
    const collab = openEditor(undefined, { images: images(), drawings: services });
    const { view } = collab.editor;
    type(view, 'Text\n/drawing');
    press(view, 'Enter');
    finish(null);
    await flush();
    expect(markdownOf(collab)).toBe('Text\n');
  });

  it('after text in the same line, goes in a paragraph of its own below it', async () => {
    const { services, finish } = drawings();
    const collab = openEditor(undefined, { images: images(), drawings: services });
    const { view } = collab.editor;
    type(view, 'Sketch here /drawing');
    press(view, 'Enter');
    finish(FIRST);
    await flush();
    expect(markdownOf(collab)).toBe(`Sketch here\n\n${LINE(FIRST)}\n`);
  });
});

describe('a drawing in a note', () => {
  it('shows its SVG and opens its scene on a click; Done points it at the new pair', async () => {
    const { services, edit, finish } = drawings();
    const collab = withDrawing({ drawings: services });
    const { view } = collab.editor;
    const shown = view.dom.querySelector<HTMLElement>('[data-testid="drawing"]')!;
    await flush();
    expect(shown.querySelector('img')!.getAttribute('src')).toBe(
      `data:image/svg+xml;base64,${btoa(FIRST.svg)}`,
    );
    expect(shown.getAttribute('aria-label')).toBe('Drawing: click or press Enter to edit');
    shown.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(edit).toHaveBeenCalledWith(FIRST.scene);
    finish(SECOND);
    await flush();
    expect(markdownOf(collab)).toBe(`Beds\n\n${LINE(SECOND)}\n`);
    // The editor's document and the replica's agree (two transactions, see replaceDrawing): the
    // next click opens the new scene, and git gets it.
    expect(replicaMarkdown(collab)).toBe(`Beds\n\n${LINE(SECOND)}\n`);
    view.dom
      .querySelector('[data-testid="drawing"]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(edit).toHaveBeenLastCalledWith(SECOND.scene);
  });

  it('opens with Enter while selected', () => {
    const { services, edit } = drawings();
    const collab = withDrawing({ drawings: services });
    const { view } = collab.editor;
    let at = -1;
    view.state.doc.descendants((node, pos) => {
      if (drawingOf(node)) at = pos;
    });
    view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, at)));
    expect(press(view, 'Enter')).toBe(true);
    expect(edit).toHaveBeenCalledWith(FIRST.scene);
    expect(markdownOf(collab)).toBe(`Beds\n\n${LINE(FIRST)}\n`);
  });

  it('keeps its alt text and width through an edit', () => {
    const collab = withDrawing();
    const { view } = collab.editor;
    let at = -1;
    view.state.doc.descendants((node, pos) => {
      if (drawingOf(node)) at = pos;
    });
    view.dispatch(
      view.state.tr.setNodeMarkup(at, undefined, { src: FIRST.svg, alt: 'Beds plan', width: 480 }),
    );
    expect(replaceDrawing(view, at, SECOND)).toBe(true);
    expect(markdownOf(collab)).toBe(`Beds\n\n[![Beds plan|480](${SECOND.svg})](${SECOND.scene})\n`);
    expect(replicaMarkdown(collab)).toBe(markdownOf(collab));
  });

  it('without a drawing editor (Android), shows as a picture that a click does not follow', async () => {
    const collab = withDrawing();
    const { view } = collab.editor;
    const shown = view.dom.querySelector<HTMLElement>('[data-testid="drawing"]')!;
    await flush();
    expect(shown.querySelector('img')!.getAttribute('src')).toMatch(/^data:image\/svg\+xml;/);
    expect(shown.hasAttribute('aria-label')).toBe(false);
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    shown.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    // Edited around: the drawing stays as it is.
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 5)));
    type(view, ' and paths\nMore text');
    expect(markdownOf(collab)).toBe(`Beds and paths\n\nMore text\n\n${LINE(FIRST)}\n`);
    expect(replicaMarkdown(collab)).toBe(markdownOf(collab));
  });
});
