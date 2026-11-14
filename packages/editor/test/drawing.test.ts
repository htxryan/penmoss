/**
 * Drawings (PEN-28): an SVG picture linked to its Excalidraw scene, shown as a drawing block that
 * opens in the app's drawing editor. The model is core's image with a link mark, so the markdown
 * is `[![Excalidraw Diagram](….svg)](….excalidraw)` and every client keeps it as it is.
 */
import { schema as coreSchema, serializeMarkdown } from '@penmoss/core';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { yUndoPluginKey } from '@y/prosemirror';
import { describe, expect, it, vi } from 'vitest';
import type { CollabEditor } from '../src/collab';
import { availableBlockItems, BLOCK_ITEMS, filterBlockItems } from '../src/extensions/block-items';
import {
  DRAWING_ALT,
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
const LINE = (files: DrawingFiles) => `[![Excalidraw Diagram](${files.svg})](${files.scene})`;

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

/** A click on `target`, returned to check what the page did with it. */
function click(target: Element): MouseEvent {
  const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
  target.dispatchEvent(event);
  return event;
}

/** The drawing's Edit or Delete button. */
const button = (view: EditorView, kind: 'edit' | 'delete') =>
  view.dom.querySelector<HTMLButtonElement>(`[data-testid="drawing-${kind}"]`)!;

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

  it('is "Excalidraw Diagram", beside Mermaid Diagram, and the old word still finds it', () => {
    const item = BLOCK_ITEMS.find((block) => block.id === 'drawing')!;
    expect(item.label).toBe('Excalidraw Diagram');
    const found = (query: string) => filterBlockItems(BLOCK_ITEMS, query).map((block) => block.id);
    expect(found('dia')).toEqual(['mermaid', 'drawing']);
    expect(found('excalidraw')[0]).toBe('drawing');
    expect(found('draw')[0]).toBe('drawing');
    expect(found('drawing')).toEqual(['drawing']);
    expect(DRAWING_ALT).toBe('Excalidraw Diagram');
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
  it('shows its SVG and opens its scene from its Edit button; Done points it at the new pair', async () => {
    const { services, edit, finish } = drawings();
    const collab = withDrawing({ drawings: services });
    const { view } = collab.editor;
    const shown = view.dom.querySelector<HTMLElement>('[data-testid="drawing"]')!;
    await flush();
    expect(shown.querySelector('img')!.getAttribute('src')).toBe(
      `data:image/svg+xml;base64,${btoa(FIRST.svg)}`,
    );
    expect(shown.getAttribute('aria-label')).toBe('Excalidraw Diagram: press Enter to edit');
    const editButton = button(view, 'edit');
    expect(editButton.getAttribute('aria-label')).toBe('Edit Excalidraw Diagram');
    expect(editButton.title).toBe('Edit Excalidraw Diagram');
    expect(button(view, 'delete').getAttribute('aria-label')).toBe('Delete Excalidraw Diagram');
    // In the drawing's top-right corner, on hover and while selected (the stylesheet's).
    expect(editButton.parentElement!.className).toBe('pm-drawing-tools');
    expect(editButton.parentElement!.hidden).toBe(false);
    click(editButton);
    expect(edit).toHaveBeenCalledWith(FIRST.scene);
    finish(SECOND);
    await flush();
    expect(markdownOf(collab)).toBe(`Beds\n\n${LINE(SECOND)}\n`);
    // The editor's document and the replica's agree (two transactions, see replaceDrawing): the
    // next edit opens the new scene, and git gets it.
    expect(replicaMarkdown(collab)).toBe(`Beds\n\n${LINE(SECOND)}\n`);
    click(button(view, 'edit'));
    expect(edit).toHaveBeenLastCalledWith(SECOND.scene);
  });

  it('is selected by a click, which does not open it or follow its link', () => {
    const { services, edit } = drawings();
    const collab = withDrawing({ drawings: services });
    const { view } = collab.editor;
    const shown = view.dom.querySelector<HTMLElement>('[data-testid="drawing"]')!;
    const event = click(shown.querySelector('img')!);
    expect(event.defaultPrevented).toBe(true);
    expect(edit).not.toHaveBeenCalled();
    const { selection } = view.state;
    expect(selection).toBeInstanceOf(NodeSelection);
    expect(drawingOf((selection as NodeSelection).node)).toEqual(FIRST);
    expect(shown.classList.contains('ProseMirror-selectednode')).toBe(true);
  });

  it('goes with its Delete button, the caret left where it was, and ⌘Z brings it back', () => {
    const { services } = drawings();
    const collab = withDrawing({ drawings: services });
    const { view } = collab.editor;
    // A pause: the delete is an undo step of its own.
    yUndoPluginKey.getState(view.state)?.undoManager.stopCapturing();
    click(button(view, 'delete'));
    expect(markdownOf(collab)).toBe('Beds\n');
    expect(replicaMarkdown(collab)).toBe('Beds\n');
    expect(view.state.selection).toBeInstanceOf(TextSelection);
    expect(view.state.selection.$from.parent.type.name).toBe('paragraph');
    expect(collab.undo()).toBe(true);
    expect(markdownOf(collab)).toBe(`Beds\n\n${LINE(FIRST)}\n`);
    expect(replicaMarkdown(collab)).toBe(markdownOf(collab));
  });

  it('goes with Backspace or Delete while selected, as a picture does', () => {
    for (const key of ['Backspace', 'Delete']) {
      const { services } = drawings();
      const collab = withDrawing({ drawings: services });
      const { view } = collab.editor;
      click(view.dom.querySelector('[data-testid="drawing"] img')!);
      expect(view.state.selection).toBeInstanceOf(NodeSelection);
      press(view, key);
      expect(markdownOf(collab)).toBe('Beds\n');
    }
  });

  it('in a read-only note, has no buttons and does nothing on a click', () => {
    const { services, edit } = drawings();
    const collab = withDrawing({ drawings: services });
    const { view } = collab.editor;
    collab.editor.setEditable(false);
    const shown = view.dom.querySelector<HTMLElement>('[data-testid="drawing"]')!;
    const before = view.state.selection;
    click(shown.querySelector('img')!);
    expect(view.state.selection.eq(before)).toBe(true);
    // Its buttons, were they reached (the stylesheet hides them), do nothing either.
    click(button(view, 'edit'));
    click(button(view, 'delete'));
    expect(edit).not.toHaveBeenCalled();
    expect(markdownOf(collab)).toBe(`Beds\n\n${LINE(FIRST)}\n`);
    // A drawing first shown in a read-only note has them hidden.
    const readOnly = openEditor(undefined, { images: images(), drawings: services });
    readOnly.editor.setEditable(false);
    readOnly.editor.commands.setContent(collab.editor.getJSON());
    expect(button(readOnly.editor.view, 'edit').parentElement!.hidden).toBe(true);
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
    // No Edit or Delete buttons: the phone has no drawing editor.
    expect(shown.querySelector('.pm-drawing-tools')).toBeNull();
    expect(click(shown).defaultPrevented).toBe(true);
    // Edited around: the drawing stays as it is.
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 5)));
    type(view, ' and paths\nMore text');
    expect(markdownOf(collab)).toBe(`Beds and paths\n\nMore text\n\n${LINE(FIRST)}\n`);
    expect(replicaMarkdown(collab)).toBe(markdownOf(collab));
  });
});
