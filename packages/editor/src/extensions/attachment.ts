/**
 * File attachments (T13): PDFs and other files in a note, as a chip with the
 * file's name, size and type, a Download button, and for PDFs a preview in
 * the browser's own viewer. The model is core's `attachment` atom (A9):
 * `href` is the note path `attachments/<sha256>.<ext>`, and `name` the file's
 * name (`[name](attachments/…)` in markdown).
 *
 * Files are stored like images (T10, `FileServices.addFile`): hashed, kept
 * locally, uploaded by the queue when online. The chip reads the bytes from
 * local storage or downloads them with the API token, so a file is never
 * fetched by its path, and only on a click. Rendering never writes to the
 * document.
 */
import { formatBytes, isImageType, PDF_TYPE } from '@penmoss/core/attachments';
import { Node, type Attributes } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorView, NodeView } from '@tiptap/pm/view';
import type { ImageServices } from './image';

/** What attachments need from the app: image services plus files and their sizes. */
export interface FileServices extends ImageServices {
  /** Stores a file of any type and returns the path to put in the note; rejects with a message. */
  addFile(file: File): Promise<{ readonly path: string }>;
  /** The stored file's size and type, or null when unknown (offline, not uploaded anywhere). */
  info(src: string): Promise<{ readonly size: number; readonly type: string } | null>;
  /**
   * Opens the file in the platform's own viewer, or saves a copy where the person picks (an
   * app shell, T40 P8, ED12). With it, a chip offers Open and Save a copy, and no preview.
   */
  openFile?(src: string, name: string, action: 'open' | 'save'): void;
}

function attachmentAttributes(): Attributes {
  return {
    href: {
      parseHTML: (element) => element.getAttribute('data-href') ?? element.getAttribute('href'),
      renderHTML: (attrs) => ({ 'data-href': attrs['href'] as string }),
    },
    name: {
      parseHTML: (element) =>
        element.getAttribute('data-name') ?? element.textContent?.trim() ?? '',
      renderHTML: (attrs) => ({ 'data-name': attrs['name'] as string }),
    },
  };
}

/** The attachment node; without services, a chip shows the name only. */
export function attachmentExtension(services?: FileServices) {
  return Node.create({
    name: 'attachment',
    inline: true,
    group: 'inline',
    atom: true,
    addAttributes: attachmentAttributes,
    // Clipboard HTML between notes keeps the path; ahead of the link mark's `a[href]`.
    parseHTML: () => [{ tag: 'a[data-attachment]', priority: 60 }],
    renderHTML: ({ node, HTMLAttributes }) => [
      'a',
      { ...HTMLAttributes, 'data-attachment': '', href: node.attrs['href'] as string },
      (node.attrs['name'] as string) || 'File',
    ],
    renderText: ({ node }) => `[${node.attrs['name'] as string}](${node.attrs['href'] as string})`,
    addNodeView:
      () =>
      ({ node, view }) =>
        new AttachmentView(node, view, services),
    addProseMirrorPlugins: () => (services ? [fileInputPlugin(services)] : []),
  });
}

/** Insert points waiting for their files, mapped through every change meanwhile. */
const fileInputKey = new PluginKey<Set<{ pos: number }>>('penmossFileInput');

/**
 * Stores each file and inserts it: images as images, anything else as an
 * attachment chip. At `at` (a drop point, then after the previous file), or
 * over the selection when `at` is null.
 */
export async function insertFiles(
  view: EditorView,
  services: FileServices,
  files: readonly File[],
  at: number | null = null,
): Promise<void> {
  const pending = fileInputKey.getState(view.state);
  const point = at === null ? null : { pos: at };
  if (point) pending?.add(point);
  try {
    for (const file of files) {
      const image = isImageType(file.type);
      let path: string;
      try {
        path = image
          ? (await services.add(new Uint8Array(await file.arrayBuffer()))).path
          : (await services.addFile(file)).path;
      } catch (error) {
        services.onError?.(error instanceof Error ? error.message : String(error));
        continue;
      }
      if (view.isDestroyed) return;
      const { state } = view;
      const node = image
        ? state.schema.nodes['image']!.create({ src: path, alt: '' })
        : state.schema.nodes['attachment']!.create({ href: path, name: file.name });
      const tr = point
        ? state.tr.insert(Math.min(point.pos, state.doc.content.size), node)
        : state.tr.replaceSelectionWith(node);
      view.dispatch(tr.scrollIntoView());
      if (point && !pending)
        point.pos = Math.min(point.pos, state.doc.content.size) + node.nodeSize;
    }
  } finally {
    if (point) pending?.delete(point);
  }
}

/** Files in a paste or drop that are not all images (images alone are T10's). */
function mixedFiles(data: DataTransfer | null): File[] {
  const files = [...(data?.files ?? [])];
  return files.some((file) => !isImageType(file.type)) ? files : [];
}

function fileInputPlugin(services: FileServices): Plugin {
  return new Plugin({
    key: fileInputKey,
    state: {
      init: () => new Set<{ pos: number }>(),
      apply(tr, pending) {
        if (tr.docChanged) for (const at of pending) at.pos = tr.mapping.map(at.pos);
        return pending;
      },
    },
    props: {
      handlePaste(view, event) {
        const files = mixedFiles(event.clipboardData);
        if (files.length === 0) return false;
        event.preventDefault();
        void insertFiles(view, services, files, null);
        return true;
      },
      handleDrop(view, event, _slice, moved) {
        if (moved) return false;
        const files = mixedFiles(event.dataTransfer);
        if (files.length === 0) return false;
        event.preventDefault();
        const at = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ?? null;
        void insertFiles(view, services, files, at);
        return true;
      },
    },
  });
}

/** How long a file's URL is held once handed to the browser to open or save. */
export const FILE_URL_HOLD_MS = 60_000;
/** How long to wait for a file to download before giving up on opening it. */
const OPEN_FILE_TIMEOUT_MS = 30_000;

/** Saves a file under its name from its URL (a chip's Download). */
export function downloadUrl(doc: Document, url: string, name: string): void {
  const link = doc.createElement('a');
  link.href = url;
  link.download = name;
  link.hidden = true;
  doc.body.append(link);
  link.click();
  link.remove();
}

/**
 * Opens a stored file that has no chip of its own (one inside an embed): a
 * PDF in a new tab, any other file saved under its name, as the chip does.
 * Its URL is held only while the browser reads it.
 */
export async function openFile(
  services: FileServices,
  doc: Document,
  href: string,
  name: string,
): Promise<void> {
  if (services.openFile) {
    services.openFile(href, name, 'open');
    return;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OPEN_FILE_TIMEOUT_MS);
  let url: string | null;
  let info: Awaited<ReturnType<FileServices['info']>>;
  try {
    [url, info] = await Promise.all([
      services.resolve(href, controller.signal),
      services.info(href).catch(() => null),
    ]);
  } finally {
    clearTimeout(timeout);
  }
  if (!url) {
    services.onError?.(`“${name}” is not available yet: it downloads once online.`);
    return;
  }
  if (info?.type === PDF_TYPE) doc.defaultView?.open(url, '_blank', 'noopener');
  else downloadUrl(doc, url, name);
  setTimeout(() => services.release?.(href), FILE_URL_HOLD_MS);
}

/** The label on a chip's type badge: PDF, or the extension. */
function badgeOf(href: string): string {
  const ext = /\.([a-z0-9]{1,10})$/i.exec(href)?.[1];
  return ext ? ext.toUpperCase().slice(0, 4) : 'FILE';
}

/**
 * One file: a chip with its badge, name and size, Download, and for a PDF
 * Preview (inline, in the browser's viewer) and Open (a new tab).
 */
class AttachmentView implements NodeView {
  readonly dom: HTMLSpanElement;
  private readonly chip: HTMLSpanElement;
  private readonly badge: HTMLSpanElement;
  private readonly name: HTMLSpanElement;
  private readonly size: HTMLSpanElement;
  private readonly previewButton: HTMLButtonElement;
  private readonly openButton: HTMLButtonElement;
  private readonly downloadButton: HTMLButtonElement;
  private preview: HTMLIFrameElement | null = null;
  /** The source whose URL this view holds, released on change and on destroy. */
  private held: string | null = null;
  private loading: AbortController | null = null;
  private infoId = 0;

  constructor(
    private node: PMNode,
    private readonly view: EditorView,
    private readonly services: FileServices | undefined,
  ) {
    const doc = view.dom.ownerDocument;
    this.dom = doc.createElement('span');
    this.dom.className = 'pm-attachment';
    this.dom.contentEditable = 'false';
    this.dom.dataset['testid'] = 'attachment';
    this.chip = doc.createElement('span');
    this.chip.className = 'pm-attachment-chip';
    this.badge = doc.createElement('span');
    this.badge.className = 'pm-attachment-badge';
    this.badge.setAttribute('aria-hidden', 'true');
    this.name = doc.createElement('span');
    this.name.className = 'pm-attachment-name';
    this.size = doc.createElement('span');
    this.size.className = 'pm-attachment-size';
    this.previewButton = this.button(doc, 'Preview', 'preview', () => void this.togglePreview());
    this.openButton = this.button(doc, 'Open', 'open', () => void this.open());
    this.downloadButton = this.button(doc, 'Download', 'download', () => void this.download());
    this.chip.append(
      this.badge,
      this.name,
      this.size,
      this.previewButton,
      this.openButton,
      this.downloadButton,
    );
    this.dom.append(this.chip);
    this.render(true);
  }

  update(node: PMNode): boolean {
    if (node.type !== this.node.type) return false;
    const changed = node.attrs['href'] !== this.node.attrs['href'];
    this.node = node;
    if (changed) this.reset();
    this.render(changed);
    return true;
  }

  /** The buttons and the preview are the view's, not the editor's. */
  stopEvent(event: Event): boolean {
    const target = event.target as globalThis.Node | null;
    return (
      (target instanceof Element && target.closest('button') !== null) ||
      (this.preview?.contains(target) ?? false)
    );
  }

  ignoreMutation(): boolean {
    return true;
  }

  destroy(): void {
    this.reset();
  }

  private get href(): string {
    return this.node.attrs['href'] as string;
  }

  private get fileName(): string {
    return (this.node.attrs['name'] as string) || 'File';
  }

  /** Stored as a PDF (its bytes, A30), not merely named like one. */
  private get isPdf(): boolean {
    return this.dom.dataset['type'] === PDF_TYPE;
  }

  private button(doc: Document, label: string, kind: string, onClick: () => void) {
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = `pm-attachment-${kind}`;
    button.textContent = label;
    button.addEventListener('click', (event) => {
      event.preventDefault();
      onClick();
    });
    return button;
  }

  /** The shell opens and saves files itself (T40 P8): Open and Save a copy, for every file. */
  private get shell(): boolean {
    return this.services?.openFile !== undefined;
  }

  /** Which buttons show: the shell's two, or the web's by the file's type. */
  private showButtons(): void {
    const pdf = this.isPdf;
    this.previewButton.hidden = this.shell || !pdf || !this.services;
    this.openButton.hidden = !this.shell && (!pdf || !this.services);
  }

  private render(reload: boolean): void {
    this.badge.textContent = badgeOf(this.href);
    this.name.textContent = this.fileName;
    this.dom.title = this.fileName;
    if (reload) delete this.dom.dataset['type']; // Another file: its type is asked again.
    this.showButtons();
    this.downloadButton.hidden = !this.services;
    this.downloadButton.textContent = this.shell ? 'Save a Copy' : 'Download';
    this.downloadButton.setAttribute(
      'aria-label',
      this.shell ? `Save a Copy of ${this.fileName}` : `Download ${this.fileName}`,
    );
    if (!this.preview) this.previewButton.setAttribute('aria-label', `Preview ${this.fileName}`);
    this.openButton.setAttribute(
      'aria-label',
      this.shell ? `Open ${this.fileName}` : `Open ${this.fileName} in a New Tab`,
    );
    if (!reload || !this.services) return;
    const id = ++this.infoId;
    this.size.textContent = '';
    void this.services.info(this.href).then((info) => {
      if (id !== this.infoId) return;
      this.size.textContent = info ? formatBytes(info.size) : '';
      if (info) this.dom.dataset['type'] = info.type;
      this.showButtons();
    });
  }

  /** The file's object URL, from local storage or downloaded with the token (held until destroy). */
  private async url(): Promise<string | null> {
    if (!this.services) return null;
    const src = this.href;
    this.loading ??= new AbortController();
    this.dom.dataset['state'] = 'loading';
    const url = await this.services.resolve(src, this.loading.signal);
    if (this.href !== src || this.view.isDestroyed) {
      if (url) this.services.release?.(src);
      return null;
    }
    if (!url) {
      this.dom.dataset['state'] = 'missing';
      this.services.onError?.(`“${this.fileName}” is not available yet: it downloads once online.`);
      return null;
    }
    if (this.held === src) this.services.release?.(src); // One hold per view.
    this.held = src;
    this.dom.dataset['state'] = 'ready';
    return url;
  }

  private async download(): Promise<void> {
    if (this.services?.openFile) {
      this.services.openFile(this.href, this.fileName, 'save');
      return;
    }
    const url = await this.url();
    if (url) downloadUrl(this.view.dom.ownerDocument, url, this.fileName);
  }

  private async open(): Promise<void> {
    if (this.services?.openFile) {
      this.services.openFile(this.href, this.fileName, 'open');
      return;
    }
    const url = await this.url();
    if (url) this.view.dom.ownerDocument.defaultView?.open(url, '_blank', 'noopener');
  }

  private async togglePreview(): Promise<void> {
    if (this.preview) {
      this.preview.remove();
      this.preview = null;
      this.previewButton.textContent = 'Preview';
      this.previewButton.setAttribute('aria-label', `Preview ${this.fileName}`);
      this.previewButton.setAttribute('aria-expanded', 'false');
      return;
    }
    const url = await this.url();
    if (!url || this.preview) return;
    const frame = this.view.dom.ownerDocument.createElement('iframe');
    frame.className = 'pm-attachment-frame';
    frame.title = `Preview of ${this.fileName}`;
    frame.src = url;
    frame.dataset['testid'] = 'attachment-preview';
    this.preview = frame;
    this.dom.append(frame);
    this.previewButton.textContent = 'Close Preview';
    this.previewButton.setAttribute('aria-label', `Close the Preview of ${this.fileName}`);
    this.previewButton.setAttribute('aria-expanded', 'true');
  }

  private reset(): void {
    this.loading?.abort();
    this.loading = null;
    this.preview?.remove();
    this.preview = null;
    if (this.held !== null) this.services?.release?.(this.held);
    this.held = null;
  }
}
