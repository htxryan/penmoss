/**
 * Drawings (PEN-28): hand-drawn sketches made in Excalidraw, kept as plain files in the notebook.
 *
 * A drawing is not a node of its own: it is core's `image` of a rendered SVG, linked to the
 * Excalidraw scene it was drawn from, alone in its paragraph:
 *
 *     [![Excalidraw Diagram](attachments/<sha256>.svg)](attachments/<sha256>.excalidraw)
 *
 * so the repository and GitHub show the picture, agents read an image link, and every client of
 * any age keeps it as a linked picture: no schema change and no new notebook format. Both files
 * are content-addressed attachments; an edit writes a new pair and points the picture at it.
 *
 * The editor shows such a picture as a drawing block: the SVG as wide as a picture, which a click
 * (or Enter on it) opens in the drawing editor, through `DrawingServices`. The editor itself is
 * the app's (apps/web loads Excalidraw only then); without the services (Android, a read-only
 * note) a drawing is a picture you can look at.
 */
import { parseAttachmentPath } from '@penmoss/core/attachments';
import { Extension, type Editor } from '@tiptap/core';
import type { Mark, Node as PMNode, Schema } from '@tiptap/pm/model';
import { NodeSelection, type Transaction } from '@tiptap/pm/state';
import type { EditorView, NodeView } from '@tiptap/pm/view';
import type { ImageServices } from './image';

/** The pair of files one version of a drawing is: its rendered SVG and its Excalidraw scene. */
export interface DrawingFiles {
  /** `attachments/<sha256>.svg`, what the note shows. */
  readonly svg: string;
  /** `attachments/<sha256>.excalidraw`, what the editor opens. */
  readonly scene: string;
}

/** The drawing editor, from the app (apps/web); without it, drawings show but do not open. */
export interface DrawingServices {
  /**
   * Opens the drawing editor on the scene at `scene` (an attachment path), or on an empty one
   * for a new drawing. Resolves with the files Done stored, or null when it was cancelled (or
   * a new drawing was left empty).
   */
  edit(scene: string | null): Promise<DrawingFiles | null>;
}

/**
 * The alt text a new drawing gets, the slash menu's name for it: the markdown's
 * `![Excalidraw Diagram](…)`. Older drawings keep the `![Drawing](…)` they were made with.
 */
export const DRAWING_ALT = 'Excalidraw Diagram';

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** The attachment extension a path inside the notebook names, or null (web addresses too). */
function attachmentExt(path: unknown): string | null {
  if (typeof path !== 'string' || SCHEME.test(path) || path.startsWith('/')) return null;
  return parseAttachmentPath(path)?.ext ?? null;
}

/** The link mark on a picture that makes it a drawing: one to an `.excalidraw` attachment. */
function sceneLink(marks: readonly Mark[]): Mark | null {
  return (
    marks.find(
      (mark) => mark.type.name === 'link' && attachmentExt(mark.attrs['href']) === 'excalidraw',
    ) ?? null
  );
}

/** The drawing's files when `node` is one (an SVG attachment linked to its scene), else null. */
export function drawingOf(node: PMNode): DrawingFiles | null {
  if (node.type.name !== 'image' || attachmentExt(node.attrs['src']) !== 'svg') return null;
  const link = sceneLink(node.marks);
  return link ? { svg: node.attrs['src'] as string, scene: link.attrs['href'] as string } : null;
}

/** A drawing's picture, linked to its scene: what goes in the note. */
export function drawingNode(
  schema: Schema,
  files: DrawingFiles,
  attrs: Record<string, unknown> = {},
) {
  const link = schema.marks['link']!.create({ href: files.scene, title: null });
  return schema.nodes['image']!.create({ alt: DRAWING_ALT, ...attrs, src: files.svg }, null, [
    link,
  ]);
}

/**
 * Points the drawing at `pos` at a new pair of files, keeping its alt text and width, and
 * selects it. False when `pos` no longer holds a drawing.
 *
 * Two transactions: the picture, then the link. The Yjs binding (`@y/prosemirror`) writes a
 * change of both an inline node's attributes and its link in one transaction to its own document
 * but leaves the editor's with the old link, which would open the old scene (PEN-28,
 * drawing.test.ts). The note is a drawing at every step, and Undo takes both back together (the
 * undo manager merges changes this close).
 */
export function replaceDrawing(view: EditorView, pos: number, files: DrawingFiles): boolean {
  const node = view.state.doc.nodeAt(pos);
  if (!node || !drawingOf(node)) return false;
  const link = view.state.schema.marks['link']!;
  view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, src: files.svg }));
  const tr = view.state.tr
    .removeMark(pos, pos + 1, link)
    .addMark(pos, pos + 1, link.create({ href: files.scene, title: null }));
  tr.setSelection(NodeSelection.create(tr.doc, pos));
  view.dispatch(tr.scrollIntoView());
  return true;
}

/**
 * Puts a new drawing at `at`: in the paragraph there when it is empty, else in a paragraph of its
 * own after the textblock holding `at` (a drawing is a block, never beside text). Selects it.
 */
export function placeDrawing(tr: Transaction, at: number, files: DrawingFiles): void {
  const { schema } = tr.doc.type;
  const node = drawingNode(schema, files);
  const $at = tr.doc.resolve(Math.min(Math.max(at, 0), tr.doc.content.size));
  const block = $at.parent;
  let pos: number;
  if (block.type.name === 'paragraph' && block.content.size === 0 && $at.depth > 0) {
    pos = $at.start();
    tr.insert(pos, node);
  } else if (block.isTextblock && $at.depth > 0) {
    const after = $at.after();
    tr.insert(after, schema.nodes['paragraph']!.create(null, node));
    pos = after + 1;
  } else {
    tr.insert($at.pos, schema.nodes['paragraph']!.create(null, node));
    pos = $at.pos + 1;
  }
  tr.setSelection(NodeSelection.create(tr.doc, pos));
  tr.scrollIntoView();
}

/** The drawing services an editor was made with (the Drawing extension's), if any. */
export function drawingServicesOf(editor: Editor): DrawingServices | undefined {
  const storage = editor.storage as unknown as { drawing?: DrawingStorage };
  return storage.drawing?.services;
}

/** One drawing editor at a time per editor: a second open while one is up does nothing. */
const editing = new WeakSet<EditorView>();

/**
 * Opens a new drawing for the place `at` and, on Done, puts it there. The place is mapped
 * through every edit made while the drawing editor is open (another device's, an agent's).
 */
export async function insertDrawing(editor: Editor, at: number): Promise<boolean> {
  const services = drawingServicesOf(editor);
  const { view } = editor;
  if (!services || editing.has(view)) return false;
  editing.add(view);
  let point = at;
  const follow = ({ transaction }: { transaction: Transaction }) => {
    point = transaction.mapping.map(point);
  };
  editor.on('transaction', follow);
  try {
    const files = await services.edit(null);
    if (editor.isDestroyed) return false;
    // Focus comes back to the note, where the menu was, whether or not a drawing was made.
    view.focus();
    if (!files) return false;
    const tr = editor.state.tr;
    placeDrawing(tr, point, files);
    view.dispatch(tr);
    return true;
  } finally {
    editor.off('transaction', follow);
    editing.delete(view);
  }
}

/**
 * Opens the drawing at `getPos()` in the drawing editor and, on Done, points it at the new files.
 * `getPos` is read again once the editor closes, so the drawing is found where it moved to.
 */
export async function editDrawing(
  view: EditorView,
  services: DrawingServices,
  getPos: () => number | undefined,
): Promise<boolean> {
  const pos = getPos();
  const node = pos === undefined ? null : view.state.doc.nodeAt(pos);
  const files = node ? drawingOf(node) : null;
  if (!files || !view.editable || editing.has(view)) return false;
  editing.add(view);
  try {
    const saved = await services.edit(files.scene);
    if (view.isDestroyed) return false;
    view.focus();
    if (!saved) return false;
    const now = getPos();
    const current = now === undefined ? null : view.state.doc.nodeAt(now);
    // Still the drawing that was opened (not one another device changed meanwhile).
    if (now === undefined || !current || drawingOf(current)?.scene !== files.scene) return false;
    return replaceDrawing(view, now, saved);
  } finally {
    editing.delete(view);
  }
}

/** Each drawing's view by its element, so Enter on a selected drawing opens that view's. */
const views = new WeakMap<globalThis.Node, DrawingView>();

/**
 * Shows one drawing: its SVG as a picture (or "Drawing" while it loads or when it cannot be
 * had). A click, or Enter while it is selected, opens it in the drawing editor when the note is
 * editable and the app has one.
 */
export class DrawingView implements NodeView {
  readonly dom: HTMLSpanElement;
  private readonly img: HTMLImageElement;
  private readonly fallback: HTMLSpanElement;
  private loading: AbortController | null = null;
  /** The source whose URL this view holds (given back on change and on destroy). */
  private shown: string | null = null;

  constructor(
    private node: PMNode,
    private readonly view: EditorView,
    private readonly getPos: () => number | undefined,
    private readonly images: ImageServices | undefined,
    private readonly drawings: DrawingServices | undefined,
  ) {
    const doc = view.dom.ownerDocument;
    // `pm-image` too: a drawing sits on its own line exactly as a picture does (A506).
    this.dom = doc.createElement('span');
    this.dom.className = 'pm-image pm-drawing';
    this.dom.contentEditable = 'false';
    this.dom.dataset['testid'] = 'drawing';
    this.img = doc.createElement('img');
    this.img.draggable = false;
    this.fallback = doc.createElement('span');
    this.fallback.className = 'pm-image-fallback';
    const frame = doc.createElement('span');
    frame.className = 'pm-image-frame';
    frame.append(this.img, this.fallback);
    this.dom.append(frame);
    views.set(this.dom, this);
    this.dom.addEventListener('click', (event) => {
      // The link around the picture is the scene's file, never followed from the note.
      event.preventDefault();
      if (event.button === 0) this.open();
    });
    this.render(true);
  }

  /** Whether a click opens the drawing editor here. */
  private get editable(): boolean {
    return this.drawings !== undefined && this.view.editable;
  }

  /** Opens this drawing in the drawing editor (a click, or Enter while it is selected). */
  open(): boolean {
    if (!this.editable || !this.drawings) return false;
    void editDrawing(this.view, this.drawings, this.getPos);
    return true;
  }

  update(node: PMNode): boolean {
    if (node.type !== this.node.type || !drawingOf(node)) return false;
    const reload = node.attrs['src'] !== this.node.attrs['src'];
    this.node = node;
    this.render(reload);
    return true;
  }

  selectNode(): void {
    this.dom.classList.add('ProseMirror-selectednode');
  }

  deselectNode(): void {
    this.dom.classList.remove('ProseMirror-selectednode');
  }

  /** Clicks are the drawing's (they open it), not the editor's or the link's. */
  stopEvent(event: Event): boolean {
    return event.type === 'click' || (event.type === 'mousedown' && this.editable);
  }

  ignoreMutation(): boolean {
    return true;
  }

  destroy(): void {
    this.loading?.abort();
    if (this.shown !== null) this.images?.release?.(this.shown);
    this.shown = null;
  }

  private render(reload: boolean): void {
    const { alt, width } = this.node.attrs as { alt: string; width: number | null };
    const label = alt || DRAWING_ALT;
    this.img.alt = label;
    this.img.style.width = width === null ? '' : `${width}px`;
    this.fallback.textContent = label;
    if (this.editable) {
      this.dom.title = 'Edit Excalidraw Diagram';
      this.dom.setAttribute('aria-label', `${label}: click or press Enter to edit`);
    } else {
      this.dom.removeAttribute('title');
      this.dom.removeAttribute('aria-label');
    }
    if (!reload) return;
    this.loading?.abort();
    if (this.shown !== null) this.images?.release?.(this.shown);
    this.shown = null;
    const src = this.node.attrs['src'] as string;
    const images = this.images;
    if (!images) {
      this.dom.dataset['state'] = 'missing';
      return;
    }
    const controller = new AbortController();
    this.loading = controller;
    this.dom.dataset['state'] = 'loading';
    this.img.removeAttribute('src');
    images.resolve(src, controller.signal).then(
      (url) => {
        if (controller.signal.aborted) {
          if (url) images.release?.(src);
          return;
        }
        if (!url) {
          this.dom.dataset['state'] = 'missing';
          return;
        }
        this.shown = src;
        this.img.onload = () => (this.dom.dataset['state'] = 'ready');
        this.img.onerror = () => (this.dom.dataset['state'] = 'missing');
        this.img.src = url;
      },
      () => {
        if (!controller.signal.aborted) this.dom.dataset['state'] = 'missing';
      },
    );
  }
}

export interface DrawingOptions {
  services: DrawingServices | undefined;
}

export interface DrawingStorage {
  services: DrawingServices | undefined;
}

/**
 * Holds the drawing services for the slash menu and palette, and opens a selected drawing with
 * Enter, ahead of the lists' and paragraphs' Enter.
 */
export const DrawingExtension = Extension.create<DrawingOptions, DrawingStorage>({
  name: 'drawing',
  priority: 1000,

  addOptions() {
    return { services: undefined };
  },

  addStorage() {
    return { services: this.options.services };
  },

  addKeyboardShortcuts() {
    return {
      Enter: ({ editor }) => {
        const services = this.options.services;
        const { selection } = editor.state;
        if (!services || !editor.isEditable || !(selection instanceof NodeSelection)) return false;
        if (!drawingOf(selection.node)) return false;
        const dom = editor.view.nodeDOM(selection.from);
        const view = dom ? views.get(dom) : undefined;
        if (view) return view.open();
        const from = selection.from;
        void editDrawing(editor.view, services, () => from);
        return true;
      },
    };
  },
});
