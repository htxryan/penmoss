/**
 * Inline images (T10). The model comes from core's `image` spec (A9): `src`
 * is the note path `attachments/<sha256>.<ext>` (or a web URL), and `width`
 * is written `![alt|300](…)`.
 *
 * Pasting a screenshot or dropping image files stores each one through
 * `ImageServices.add` (content-addressed, local first, uploaded later) and
 * inserts it. The node view shows the image from an object URL the services
 * resolve, so an `<img>` never needs the API token (A30). Rendering never
 * writes to the document: only a resize, or editing the alt text or width,
 * dispatches a transaction.
 */
import { nodeSpecs } from '@penmoss/core/schema';
import { InputRule, Node, type Attributes } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { NodeSelection, Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorView, NodeView } from '@tiptap/pm/view';
import { onDoubleActivate, openLightbox, type Lightbox, type LightboxImage } from '../lightbox';

export interface ImageServices {
  /** Stores an image and returns the path to put in the note; rejects with a message to show. */
  add(bytes: Uint8Array<ArrayBuffer>): Promise<{ readonly path: string }>;
  /**
   * A URL an `<img>` can show for `src`, or null when the image is unavailable.
   * Each URL returned is given back with `release` once the view no longer shows it.
   */
  resolve(src: string, signal: AbortSignal): Promise<string | null>;
  /** Gives back a URL from `resolve` (object URLs are counted and revoked when unused). */
  release?(src: string): void;
  /** Reports an image that could not be added (wrong type, too large, storage failure). */
  onError?(message: string): void;
  /**
   * How a picture from a web address shows in an app shell that fetches it itself (T40 P8,
   * ED13): `{ url }` for the `<img>`, `'wait'` for a Tap to load placeholder (`now` is then
   * true once tapped), or null when web pictures are off. Without it the `<img>` loads the
   * address (the web).
   */
  web?(src: string, now: boolean): { readonly url: string } | 'wait' | null;
}

const MIN_WIDTH = 32;
const WEB_URL = /^https?:\/\//i;

function imageAttributes(): Attributes {
  const spec = nodeSpecs.image.attrs;
  const number = (value: string | null) => {
    const parsed = value === null ? NaN : Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  };
  const coreAttr = (name: keyof typeof spec) => {
    const attr = spec[name] as { default?: unknown; validate?: string };
    return {
      ...('default' in attr ? { default: attr.default } : { isRequired: true }),
      ...(attr.validate === undefined ? {} : { validate: attr.validate }),
    };
  };
  return {
    src: { ...coreAttr('src'), parseHTML: (element) => element.getAttribute('src') },
    alt: { ...coreAttr('alt'), parseHTML: (element) => element.getAttribute('alt') ?? '' },
    title: { ...coreAttr('title'), parseHTML: (element) => element.getAttribute('title') },
    width: {
      ...coreAttr('width'),
      parseHTML: (element) => number(element.getAttribute('width')),
    },
    height: {
      ...coreAttr('height'),
      parseHTML: (element) => number(element.getAttribute('height')),
    },
  };
}

/** `![alt](https://…)`, typed up to the closing parenthesis, not after `\\` (B6). */
const MARKDOWN_IMAGE = /(?:^|[^\\])(!\[([^[\]\n]*)\]\((https?:\/\/[^\s()]+)\))$/;

/**
 * Typing image markdown inserts the image, as the same markdown from the server
 * shows one. Pasted image markdown still becomes a link (A52): a typed address
 * is the writer's own choice, a pasted page's badges and pixels are not.
 */
const imageShortcut = () =>
  new InputRule({
    find: MARKDOWN_IMAGE,
    handler: ({ state, range, match }) => {
      const [whole, image, alt, src] = match;
      const type = state.schema.nodes['image'];
      if (!whole || !image || !src || !type) return null;
      const start = range.from + whole.length - image.length;
      state.tr.replaceWith(start, range.to, type.create({ src, alt: alt ?? '' }));
      return undefined;
    },
  });

/** The image node; without services, attachment images show their alt text. */
export function imageExtension(services?: ImageServices) {
  const spec = nodeSpecs.image;
  return Node.create({
    name: 'image',
    inline: spec.inline,
    group: spec.group,
    draggable: spec.draggable,
    addAttributes: imageAttributes,
    parseHTML: () => [{ tag: 'img[src]' }],
    renderHTML: ({ HTMLAttributes }) => ['img', HTMLAttributes],
    addNodeView:
      () =>
      ({ node, view, getPos }) =>
        new ImageView(node, view, getPos, services),
    addInputRules: () => [imageShortcut()],
    addProseMirrorPlugins: () => (services ? [imageInputPlugin(services)] : []),
  });
}

/** Image files in a paste (a screenshot, "Copy image") or a drop (files from the desktop). */
export function imageFiles(data: DataTransfer | null, from: 'paste' | 'drop'): File[] {
  if (!data) return [];
  const files = [...data.files].filter((file) => file.type.startsWith('image/'));
  if (files.length === 0 || from === 'drop') return files;
  // Only a lone picture is taken as files. Office puts a picture of copied text next to
  // the text, and Word, Docs or Outlook send a paragraph with an inline picture as HTML
  // plus the picture: those are left to the rich paste (clipboard/paste.ts), which keeps
  // the text and stores the HTML's own data: and blob: pictures through these services.
  const html = data.getData('text/html');
  const text = data.getData('text/plain');
  if (html ? !isLoneImage(html) : text.trim() !== '') return [];
  return files;
}

/** Whether clipboard HTML is just one or more pictures: `<img>` and no text once tags are gone. */
export function isLoneImage(html: string): boolean {
  if (!/<img[\s>]/i.test(html)) return false;
  const text = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(head|style|script|title)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;|&#160;|&#xa0;/gi, ' ')
    .trim();
  return text === '';
}

/** Insert points waiting for their images, per editor; mapped through every change meanwhile. */
const imageInputKey = new PluginKey<Set<{ pos: number }>>('penmossImageInput');

/**
 * Stores each file through `services` and inserts it: at `at` (a drop point,
 * then after the previous image) or, when `at` is null, over the selection.
 * Hashing and storing are async, so the drop point is mapped through any edit
 * (local or remote) made meanwhile.
 */
export async function insertImageFiles(
  view: EditorView,
  services: ImageServices,
  files: readonly File[],
  at: number | null = null,
): Promise<void> {
  const pending = imageInputKey.getState(view.state);
  const point = at === null ? null : { pos: at };
  if (point) pending?.add(point);
  try {
    for (const file of files) {
      let path: string;
      try {
        path = (await services.add(new Uint8Array(await file.arrayBuffer()))).path;
      } catch (error) {
        services.onError?.(error instanceof Error ? error.message : String(error));
        continue;
      }
      if (view.isDestroyed) return;
      const { state } = view;
      const image = state.schema.nodes['image']!.create({ src: path, alt: '' });
      const tr = point
        ? state.tr.insert(Math.min(point.pos, state.doc.content.size), image)
        : state.tr.replaceSelectionWith(image);
      // The insert maps `point` past the new image, so the next file follows it.
      view.dispatch(tr.scrollIntoView());
      if (point && !pending)
        point.pos = Math.min(point.pos, state.doc.content.size) + image.nodeSize;
    }
  } finally {
    if (point) pending?.delete(point);
  }
}

/** The image types the server accepts (A31). */
export const IMAGE_TYPES = 'image/png,image/jpeg,image/gif,image/webp,image/avif';

function imageInputPlugin(services: ImageServices): Plugin {
  const insert = (view: EditorView, files: File[], at: number | null) =>
    insertImageFiles(view, services, files, at);
  return new Plugin({
    key: imageInputKey,
    state: {
      init: () => new Set<{ pos: number }>(),
      apply(tr, pending) {
        if (tr.docChanged) for (const at of pending) at.pos = tr.mapping.map(at.pos);
        return pending;
      },
    },
    props: {
      handlePaste(view, event) {
        const files = imageFiles(event.clipboardData, 'paste');
        if (files.length === 0) return false;
        event.preventDefault();
        void insert(view, files, null);
        return true;
      },
      handleDrop(view, event, _slice, moved) {
        if (moved) return false;
        const files = imageFiles(event.dataTransfer, 'drop');
        if (files.length === 0) return false;
        event.preventDefault();
        const at = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ?? null;
        void insert(view, files, at);
        return true;
      },
    },
  });
}

/**
 * Shows one image: the resolved picture (or its alt text while it loads or
 * when it is unavailable), a resize handle, and, while selected, alt text
 * and width fields.
 */
class ImageView implements NodeView {
  readonly dom: HTMLSpanElement;
  private readonly img: HTMLImageElement;
  private readonly fallback: HTMLSpanElement;
  /** Tap to load: a web picture held back until asked for (ED13). */
  private readonly loadButton: HTMLButtonElement;
  private readonly tools: HTMLSpanElement;
  private readonly altInput: HTMLInputElement;
  private readonly widthInput: HTMLInputElement;
  /** The tools' Open in Lightbox (T51, A948); in a read-only note it is all the tools show. */
  private readonly lightboxButton: HTMLButtonElement;
  private readonly offDouble: () => void;
  /** The lightbox this picture opened, while it may be open. */
  private lightbox: Lightbox | null = null;
  private loading: AbortController | null = null;
  /** The source whose URL this view holds (given back on change and on destroy). */
  private shown: string | null = null;
  private selected = false;

  constructor(
    private node: PMNode,
    private readonly view: EditorView,
    private readonly getPos: () => number | undefined,
    private readonly services: ImageServices | undefined,
  ) {
    const doc = view.dom.ownerDocument;
    this.dom = doc.createElement('span');
    this.dom.className = 'pm-image';
    this.dom.contentEditable = 'false';
    this.dom.dataset['testid'] = 'image';

    this.img = doc.createElement('img');
    this.img.draggable = false;
    this.fallback = doc.createElement('span');
    this.fallback.className = 'pm-image-fallback';
    this.loadButton = doc.createElement('button');
    this.loadButton.type = 'button';
    this.loadButton.className = 'pm-image-load';
    this.loadButton.textContent = 'Tap to Load';
    this.loadButton.hidden = true;
    this.loadButton.addEventListener('click', (event) => {
      event.preventDefault();
      this.loadNow();
    });

    const handle = doc.createElement('span');
    handle.className = 'pm-image-resize';
    handle.setAttribute('aria-hidden', 'true');
    handle.addEventListener('pointerdown', (event) => this.startResize(event));

    this.tools = doc.createElement('span');
    this.tools.className = 'pm-image-tools';
    this.tools.hidden = true;
    this.altInput = this.field(doc, 'Alt text', 'text');
    this.altInput.placeholder = 'Describe the image';
    this.widthInput = this.field(doc, 'Width', 'number');
    this.widthInput.min = String(MIN_WIDTH);
    this.widthInput.placeholder = 'auto';
    this.lightboxButton = doc.createElement('button');
    this.lightboxButton.type = 'button';
    this.lightboxButton.className = 'pm-image-lightbox';
    this.lightboxButton.textContent = 'Open in Lightbox';
    this.lightboxButton.dataset['testid'] = 'image-lightbox';
    this.lightboxButton.addEventListener('click', (event) => {
      event.preventDefault();
      // The lightbox gives focus back to what had it, so to this button, its opener, even where
      // a click leaves focus in the note (Safari, WebKit; T51 review).
      this.lightboxButton.focus({ preventScroll: true });
      this.openLightbox();
    });
    this.tools.append(this.lightboxButton);
    this.tools.addEventListener('focusout', (event) => {
      if (!this.tools.contains(event.relatedTarget as globalThis.Node | null) && !this.selected) {
        this.tools.hidden = true;
      }
    });

    // The picture's own box, inside the node's: the node's breaks the line before the picture
    // and is as wide as the line there, so the handle and the fields sit on this one, which is
    // the picture's size (A506, PEN-66).
    const frame = doc.createElement('span');
    frame.className = 'pm-image-frame';
    frame.append(this.img, this.fallback, this.loadButton, handle, this.tools);
    this.dom.append(frame);
    // A double click (a double tap on a touch screen) opens the lightbox, read-only notes too.
    this.offDouble = onDoubleActivate(this.img, (event) => {
      if (!this.showing()) return;
      event.preventDefault();
      this.openLightbox();
    });
    this.render(true);
  }

  /** Whether the picture itself shows (not its alt text, Tap to load or a failure). */
  private showing(): boolean {
    return this.dom.dataset['state'] === 'ready' && this.img.getAttribute('src') !== null;
  }

  /** The lightbox on this picture, stepping through every shown picture of the note (A948). */
  openLightbox(): void {
    if (!this.showing()) return;
    const views = [...this.view.dom.querySelectorAll<HTMLElement>('.pm-image')].filter(
      (element) =>
        element.dataset['state'] === 'ready' && element.querySelector('img')?.getAttribute('src'),
    );
    const images: LightboxImage[] = views.map((element) => {
      const img = element.querySelector('img')!;
      return { src: img.currentSrc || img.src, alt: img.alt, source: img };
    });
    const index = Math.max(0, views.indexOf(this.dom));
    if (views.length === 0)
      images.push({ src: this.img.currentSrc || this.img.src, alt: this.img.alt });
    this.tools.hidden = !this.selected;
    this.lightbox = openLightbox({ images, index, doc: this.dom.ownerDocument });
  }

  update(node: PMNode): boolean {
    if (node.type !== this.node.type) return false;
    const srcChanged = node.attrs['src'] !== this.node.attrs['src'];
    this.node = node;
    this.render(srcChanged);
    return true;
  }

  selectNode(): void {
    this.selected = true;
    this.dom.classList.add('ProseMirror-selectednode');
    // A read-only note's picture has Open in Lightbox only (T51, A948).
    const editable = this.view.editable;
    for (const label of this.tools.querySelectorAll('label')) label.hidden = !editable;
    this.lightboxButton.hidden = !this.showing();
    if (!editable) {
      this.tools.hidden = this.lightboxButton.hidden;
      return;
    }
    this.altInput.value = (this.node.attrs['alt'] as string) ?? '';
    const width = this.node.attrs['width'] as number | null;
    this.widthInput.value = width === null ? '' : String(width);
    this.tools.hidden = false;
  }

  deselectNode(): void {
    this.selected = false;
    this.dom.classList.remove('ProseMirror-selectednode');
    // Keep the fields while one of them has focus (focusing one moves the selection).
    if (!this.tools.contains(this.dom.ownerDocument.activeElement)) this.tools.hidden = true;
  }

  /** Events in the fields and on the resize handle are the view's, not the editor's. */
  stopEvent(event: Event): boolean {
    const target = event.target as globalThis.Node | null;
    if (this.tools.contains(target) || this.loadButton.contains(target)) return true;
    return (target as Element | null)?.classList?.contains('pm-image-resize') ?? false;
  }

  /** The view manages its own DOM. */
  ignoreMutation(): boolean {
    return true;
  }

  destroy(): void {
    // The note's editor went (another note, the window's page changed): its lightbox goes too,
    // rather than staying over a page it no longer belongs to (T51 review, A948). Checked once
    // ProseMirror is done, since a node view is also destroyed when only its picture changed.
    const lightbox = this.lightbox;
    this.lightbox = null;
    if (lightbox?.open) {
      queueMicrotask(() => {
        if (lightbox.open && (this.view.isDestroyed || !this.view.dom.isConnected)) {
          lightbox.close();
        }
      });
    }
    this.offDouble();
    this.loading?.abort();
    this.releaseShown();
  }

  private releaseShown(): void {
    if (this.shown !== null) this.services?.release?.(this.shown);
    this.shown = null;
  }

  private field(doc: Document, label: string, type: string): HTMLInputElement {
    const wrapper = doc.createElement('label');
    const text = doc.createElement('span');
    text.textContent = label;
    const input = doc.createElement('input');
    input.type = type;
    input.className = `pm-image-${label === 'Width' ? 'width' : 'alt'}`;
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        this.commitFields();
        this.view.focus();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        this.view.focus();
      }
    });
    input.addEventListener('change', () => this.commitFields());
    wrapper.append(text, input);
    this.tools.append(wrapper);
    return input;
  }

  private render(reload: boolean): void {
    const { src, alt, title, width } = this.node.attrs as {
      src: string;
      alt: string;
      title: string | null;
      width: number | null;
    };
    this.img.alt = alt;
    if (title) this.img.title = title;
    else this.img.removeAttribute('title');
    this.img.style.width = width === null ? '' : `${width}px`;
    this.fallback.textContent = alt || 'Image';
    this.loadButton.setAttribute('aria-label', `Load the Picture ${alt || src}`);
    if (!reload) return;
    this.loading?.abort();
    this.loading = null;
    this.releaseShown();
    this.loadButton.hidden = true;
    this.lightboxButton.hidden = true;
    if (WEB_URL.test(src)) {
      this.showWeb(src, false);
      return;
    }
    if (!this.services) {
      this.dom.dataset['state'] = 'missing';
      return;
    }
    const controller = new AbortController();
    this.loading = controller;
    this.dom.dataset['state'] = 'loading';
    this.img.removeAttribute('src');
    const services = this.services;
    services.resolve(src, controller.signal).then(
      (url) => {
        if (controller.signal.aborted) {
          if (url) services.release?.(src); // Arrived after the view moved on.
          return;
        }
        if (!url) {
          this.dom.dataset['state'] = 'missing';
          return;
        }
        this.shown = src;
        this.show(url);
      },
      () => {
        if (!controller.signal.aborted) this.dom.dataset['state'] = 'missing';
      },
    );
  }

  /** A picture from a web address: as the shell says, or the address itself (the web). */
  private showWeb(src: string, now: boolean): void {
    const shown = this.services?.web ? this.services.web(src, now) : { url: src };
    if (shown === 'wait') {
      this.img.removeAttribute('src');
      this.dom.dataset['state'] = 'waiting';
      this.loadButton.hidden = false;
      return;
    }
    if (shown === null) {
      this.img.removeAttribute('src');
      this.dom.dataset['state'] = 'missing';
      return;
    }
    this.show(shown.url);
  }

  private loadNow(): void {
    const src = this.node.attrs['src'] as string;
    if (!WEB_URL.test(src)) return;
    this.loadButton.hidden = true;
    this.dom.dataset['state'] = 'loading';
    this.showWeb(src, true);
  }

  private show(url: string): void {
    this.img.onload = () => {
      this.dom.dataset['state'] = 'ready';
      this.lightboxButton.hidden = false;
    };
    this.img.onerror = () => (this.dom.dataset['state'] = 'missing');
    this.img.src = url;
  }

  private commitFields(): void {
    const alt = this.altInput.value.trim();
    const parsed = Number.parseInt(this.widthInput.value, 10);
    const width = Number.isFinite(parsed) && parsed >= MIN_WIDTH ? parsed : null;
    this.commit({
      alt,
      width,
      height: width === this.node.attrs['width'] ? this.node.attrs['height'] : null,
    });
  }

  /** Writes attributes after a user action, keeping the image selected. */
  private commit(attrs: Record<string, unknown>): void {
    const pos = this.getPos();
    if (pos === undefined || !this.view.editable) return;
    const current = this.view.state.doc.nodeAt(pos);
    if (!current || current.type !== this.node.type) return;
    const next = { ...current.attrs, ...attrs };
    if (Object.keys(next).every((key) => next[key] === current.attrs[key])) return;
    const tr = this.view.state.tr.setNodeMarkup(pos, undefined, next);
    tr.setSelection(NodeSelection.create(tr.doc, pos));
    this.view.dispatch(tr);
  }

  private startResize(event: PointerEvent): void {
    if (!this.view.editable || event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget as HTMLElement;
    handle.setPointerCapture?.(event.pointerId);
    const original = this.img.style.width;
    const startX = event.clientX;
    const startWidth = this.img.getBoundingClientRect().width;
    const maxWidth = Math.max(MIN_WIDTH, this.view.dom.clientWidth);
    let width = startWidth;
    const move = (moved: PointerEvent) => {
      width = Math.round(
        Math.min(maxWidth, Math.max(MIN_WIDTH, startWidth + moved.clientX - startX)),
      );
      this.img.style.width = `${width}px`;
    };
    const end = (finished: PointerEvent) => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
      if (finished.type === 'pointercancel') {
        this.img.style.width = original; // Cancelled (e.g. a touch scroll took over): no change.
        return;
      }
      if (Math.round(startWidth) !== width) this.commit({ width, height: null });
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }
}
