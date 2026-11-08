/**
 * Note embeds (T13): `![[Title]]` or `![[Title#Heading]]` on its own line
 * shows the other note, or one of its sections, read-only inside this one.
 * The model is core's `embed` block atom (A9), with the same reference as a
 * wikilink: the target note's id, so a rename never breaks it.
 *
 * The view renders the target's current body (`LinkServices.body`) through
 * the editor's own schema, and renders again whenever the note changes
 * (`LinkServices.watch`, live over the note's socket) or a title does. The
 * text stays in its source note: the host stores only the reference, so it
 * is found by search only there.
 *
 * Embeds inside an embedded section render too, a few levels deep. A note
 * that would embed itself, directly or through others, shows as a link
 * instead (a cycle), and so does an embed nested too deep. Rendering never
 * writes to either document.
 */
import { linkLabel, linkRefOf, sectionOf, type DocJson, type LinkRef } from '@penmoss/core/links';
import { parseWikiReference } from '@penmoss/core/wikilinks';
import { InputRule, Node, type Attributes } from '@tiptap/core';
import { DOMSerializer, type Node as PMNode, type Schema } from '@tiptap/pm/model';
import { NodeSelection } from '@tiptap/pm/state';
import type { EditorView, NodeView } from '@tiptap/pm/view';
import { openFile, type FileServices } from './attachment';
import type { ImageServices } from './image';
import { notePath, openWhere, referenceText, type LinkServices, type OpenWhere } from './wikilink';

/** Embeds inside embeds render this many levels deep; deeper ones show as links. */
export const MAX_EMBED_DEPTH = 3;

export type EmbedResolution =
  /** No note has the written title (yet). */
  | { readonly kind: 'unresolved' }
  /** The note embeds itself, directly or through the embeds around it. */
  | { readonly kind: 'cycle'; readonly title: string | null }
  | { readonly kind: 'too-deep'; readonly title: string | null }
  /** The note was deleted, or is not on this device yet. */
  | { readonly kind: 'missing'; readonly title: string | null }
  | { readonly kind: 'no-heading'; readonly title: string }
  | { readonly kind: 'section'; readonly title: string; readonly blocks: DocJson[] };

/**
 * What an embed shows. `chain` is the notes it sits in, outermost first:
 * the note being edited, then each note whose embedded section holds it.
 */
export async function resolveEmbed(
  ref: LinkRef,
  chain: readonly string[],
  services: Pick<LinkServices, 'title' | 'body'> | undefined,
): Promise<EmbedResolution> {
  if (!ref.noteId) return { kind: 'unresolved' };
  const title = services?.title(ref.noteId) ?? null;
  if (chain.includes(ref.noteId)) return { kind: 'cycle', title };
  if (chain.length > MAX_EMBED_DEPTH) return { kind: 'too-deep', title };
  if (title === null || !services?.body) return { kind: 'missing', title };
  const body = await services.body(ref.noteId);
  if (!body) return { kind: 'missing', title };
  const blocks = sectionOf(body, ref.heading);
  if (!blocks) return { kind: 'no-heading', title };
  return { kind: 'section', title, blocks };
}

const data = (name: string, key: string): Attributes[string] => ({
  parseHTML: (element: HTMLElement) => element.getAttribute(`data-${name}`) || null,
  renderHTML: (attrs: Record<string, unknown>) => {
    const value = attrs[key];
    return typeof value === 'string' ? { [`data-${name}`]: value } : {};
  },
});

function embedAttributes(): Attributes {
  return {
    noteId: data('note-id', 'noteId'),
    target: {
      ...data('target', 'target'),
      parseHTML: (el) => el.getAttribute('data-target') ?? '',
    },
    heading: data('heading', 'heading'),
    alias: { default: null, rendered: false },
  };
}

/** The embed node; without services, an embed shows its reference as text. */
export function embedExtension(
  services?: LinkServices,
  images?: ImageServices,
  files?: FileServices,
) {
  return Node.create({
    name: 'embed',
    group: 'block',
    atom: true,
    addAttributes: embedAttributes,
    // Clipboard HTML keeps the note id, so a pasted embed shows the same note.
    parseHTML: () => [{ tag: 'div[data-embed]', priority: 60 }],
    renderHTML: ({ node, HTMLAttributes }) => [
      'div',
      { ...HTMLAttributes, 'data-embed': '' },
      referenceText(linkRefOf(node.attrs), true),
    ],
    renderText: ({ node }) => referenceText(linkRefOf(node.attrs), true),
    addNodeView:
      () =>
      ({ node, view }) =>
        new EmbedView(node, view, services, images, files),
    addInputRules() {
      return [
        new InputRule({
          // `![[Title#Heading]]` typed in full, alone in its paragraph.
          find: /^!\[\[([^[\]\n]+)\]\]$/,
          handler: ({ state, range, match }) => {
            const $from = state.doc.resolve(range.from);
            if ($from.parent.type.name !== 'paragraph' || $from.depth === 0) return;
            const ref = parseWikiReference(match[1]!);
            const target = ref.target.trim();
            if (!target) return;
            const node = state.schema.nodes['embed']!.create({
              noteId: services?.resolve(target) ?? null,
              target,
              heading: ref.heading?.trim() || null,
            });
            const tr = state.tr.replaceWith($from.before(), $from.after(), node);
            const after = $from.before() + node.nodeSize;
            if (after >= tr.doc.content.size) {
              tr.insert(after, state.schema.nodes['paragraph']!.create());
            }
          },
        }),
      ];
    },
    addKeyboardShortcuts() {
      return {
        Enter: ({ editor }) => {
          const { selection } = editor.state;
          if (!(selection instanceof NodeSelection) || selection.node.type.name !== 'embed') {
            return false;
          }
          const ref = linkRefOf(selection.node.attrs);
          if (!services || !ref.noteId) return false;
          services.open(ref.noteId, ref.heading);
          return true;
        },
      };
    },
  });
}

/** How long to wait after a change before rendering again (typing in the source). */
const RENDER_DELAY_MS = 120;

/**
 * One embed: a header naming the source (a link to it) and the section,
 * rendered read-only. Nested embeds render inside it.
 *
 * While the embed is on screen (or near it), the notes it shows are followed
 * live, so an edit anywhere below shows up here; off screen it keeps what it
 * last showed, rendered from this device's copy, and renders again when it
 * comes back. Notes missing here are not followed: they arrive by catch-up
 * sync, which changes the note list. Of list changes, only the titles this
 * embed shows (and a missing note arriving) cause a render: typing in the
 * note around it does not.
 */
class EmbedView implements NodeView {
  readonly dom: HTMLDivElement;
  private readonly title: HTMLAnchorElement;
  private readonly body: HTMLDivElement;
  private readonly offTitles: (() => void) | undefined;
  private readonly observer: IntersectionObserver | null = null;
  /** On screen (always, where IntersectionObserver is missing). */
  private visible: boolean;
  /** The notes the last render showed, followed while on screen. */
  private shown: ReadonlySet<string> = new Set();
  /** Watches on the notes shown (this one and nested ones), by note id. */
  private readonly watches = new Map<string, () => void>();
  /** Each title the last render showed, by note id. */
  private titles = new Map<string, string | null>();
  /** Whether the last render had a note missing on this device. */
  private missing = false;
  /** Attachment images in the rendered content, given back on the next render. */
  private images: string[] = [];
  private renderId = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;

  constructor(
    private node: PMNode,
    private readonly view: EditorView,
    private readonly services: LinkServices | undefined,
    private readonly imageServices: ImageServices | undefined,
    private readonly files: FileServices | undefined,
  ) {
    const doc = view.dom.ownerDocument;
    this.dom = doc.createElement('div');
    this.dom.className = 'pm-embed';
    this.dom.contentEditable = 'false';
    this.dom.dataset['testid'] = 'embed';
    const head = doc.createElement('div');
    head.className = 'pm-embed-head';
    const mark = doc.createElement('span');
    mark.className = 'pm-embed-mark';
    mark.setAttribute('aria-hidden', 'true');
    mark.textContent = '⧉';
    this.title = doc.createElement('a');
    this.title.className = 'pm-embed-title';
    this.title.addEventListener('click', (event) => {
      event.preventDefault();
      this.openRef(linkRefOf(this.node.attrs), openWhere(event));
    });
    head.append(mark, this.title);
    this.body = doc.createElement('div');
    this.body.className = 'pm-embed-body';
    this.body.addEventListener('click', (event) => this.onBodyClick(event));
    this.dom.append(head, this.body);
    this.offTitles = services?.subscribe(() => this.listChanged());
    const Observer = doc.defaultView?.IntersectionObserver;
    this.visible = !Observer;
    if (Observer && services?.watch) {
      this.observer = new Observer(
        (entries) => {
          const entry = entries.at(-1);
          if (entry) this.setVisible(entry.isIntersecting);
        },
        { rootMargin: '200px 0px' },
      );
      this.observer.observe(this.dom);
    }
    void this.render();
  }

  update(node: PMNode): boolean {
    if (node.type !== this.node.type) return false;
    const changed =
      node.attrs['noteId'] !== this.node.attrs['noteId'] ||
      node.attrs['heading'] !== this.node.attrs['heading'] ||
      node.attrs['target'] !== this.node.attrs['target'];
    this.node = node;
    if (changed) void this.render();
    return true;
  }

  /** Clicks inside are the view's (links in the embedded text), not the editor's. */
  stopEvent(event: Event): boolean {
    return event.type === 'click' || event.type === 'mousedown'
      ? this.body.contains(event.target as globalThis.Node) ||
          this.title.contains(event.target as globalThis.Node)
      : false;
  }

  ignoreMutation(): boolean {
    return true;
  }

  destroy(): void {
    this.destroyed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.offTitles?.();
    this.observer?.disconnect();
    for (const off of this.watches.values()) off();
    this.watches.clear();
    this.releaseImages();
  }

  private setVisible(visible: boolean): void {
    if (visible === this.visible || this.destroyed) return;
    this.visible = visible;
    this.follow();
    // Back on screen: anything changed while it was off screen shows now.
    if (visible) this.schedule();
  }

  /** The note list changed: render again only if a title shown changed, or a note may have arrived. */
  private listChanged(): void {
    if (this.missing) {
      this.schedule();
      return;
    }
    for (const [noteId, title] of this.titles) {
      if ((this.services?.title(noteId) ?? null) !== title) {
        this.schedule();
        return;
      }
    }
  }

  private schedule(): void {
    if (this.destroyed) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.render();
    }, RENDER_DELAY_MS);
  }

  private openRef(ref: LinkRef, where: OpenWhere): void {
    if (ref.noteId) this.services?.open(ref.noteId, ref.heading, where);
  }

  private onBodyClick(event: MouseEvent): void {
    const anchor = (event.target as Element | null)?.closest?.('a');
    if (!anchor || !this.body.contains(anchor)) return;
    const noteId = anchor.getAttribute('data-note-id');
    const file = anchor.getAttribute('data-href');
    if (anchor.hasAttribute('data-attachment') && file) {
      // An attached file: from local storage (or downloaded), never by its path.
      event.preventDefault();
      const name = anchor.getAttribute('data-name') || anchor.textContent || 'File';
      if (this.files) void openFile(this.files, this.view.dom.ownerDocument, file, name);
      return;
    }
    if (noteId !== null) {
      event.preventDefault();
      this.services?.open(noteId, anchor.getAttribute('data-heading'), openWhere(event));
      return;
    }
    // Ordinary web links open in a new tab; nothing inside navigates this page.
    const href = anchor.getAttribute('href') ?? '';
    event.preventDefault();
    if (/^https?:\/\//i.test(href)) {
      this.view.dom.ownerDocument.defaultView?.open(href, '_blank', 'noopener');
    }
  }

  private async render(): Promise<void> {
    const id = ++this.renderId;
    const ref = linkRefOf(this.node.attrs);
    const host = this.services?.noteId ?? null;
    const watched = new Set<string>();
    const doc = this.view.dom.ownerDocument;
    const fragment = doc.createDocumentFragment();
    const states: string[] = [];
    const outcome = await this.renderInto(fragment, ref, host ? [host] : [], watched, states);
    if (id !== this.renderId || this.destroyed) return;

    this.title.textContent = linkLabel(ref, outcome.title);
    if (ref.noteId) this.title.href = notePath(ref.noteId);
    else this.title.removeAttribute('href');
    this.dom.dataset['state'] = outcome.state;
    if (ref.noteId) this.dom.dataset['noteId'] = ref.noteId;
    this.releaseImages();
    this.body.replaceChildren(fragment);
    this.loadImages();
    this.shown = watched;
    this.missing = states.includes('missing');
    this.titles = this.titlesShown(ref);
    this.follow();
  }

  /** The titles this render shows: the embedded notes' and their links'. */
  private titlesShown(ref: LinkRef): Map<string, string | null> {
    const ids = new Set<string>();
    if (ref.noteId) ids.add(ref.noteId);
    for (const element of this.body.querySelectorAll('[data-note-id]')) {
      ids.add(element.getAttribute('data-note-id')!);
    }
    return new Map([...ids].map((noteId) => [noteId, this.services?.title(noteId) ?? null]));
  }

  /**
   * Renders what `ref` shows into `out`, nested embeds included, and adds
   * the notes it read to `watched`. Returns the outcome for the top level.
   */
  private async renderInto(
    out: DocumentFragment | HTMLElement,
    ref: LinkRef,
    chain: readonly string[],
    watched: Set<string>,
    states: string[],
  ): Promise<{ state: string; title: string | null }> {
    const doc = this.view.dom.ownerDocument;
    const resolved = await resolveEmbed(ref, chain, this.services);
    states.push(resolved.kind);
    // Followed: notes shown here (a section, or a note without the heading, which may gain it).
    if (ref.noteId && (resolved.kind === 'section' || resolved.kind === 'no-heading')) {
      watched.add(ref.noteId);
    }
    if (resolved.kind !== 'section') {
      const title = resolved.kind === 'unresolved' ? null : resolved.title;
      out.append(this.notice(doc, resolved, ref, title));
      return { state: resolved.kind, title };
    }
    const content = renderBlocks(this.view.state.schema, resolved.blocks, doc);
    if (!content) {
      const message = doc.createElement('p');
      message.className = 'pm-embed-notice';
      message.textContent = 'This section cannot be shown here.';
      out.append(message);
      return { state: 'error', title: resolved.title };
    }
    // Nested embeds: rendered in place, with this note added to their chain.
    for (const nested of [...content.querySelectorAll<HTMLElement>('div[data-embed]')]) {
      const inner = linkRefOf({
        noteId: nested.getAttribute('data-note-id'),
        target: nested.getAttribute('data-target') ?? '',
        heading: nested.getAttribute('data-heading'),
      });
      const box = doc.createElement('div');
      box.className = 'pm-embed pm-embed-nested';
      const head = doc.createElement('div');
      head.className = 'pm-embed-head';
      const link = this.refLink(
        doc,
        inner,
        inner.noteId ? this.services?.title(inner.noteId) : null,
      );
      head.append(link);
      const body = doc.createElement('div');
      body.className = 'pm-embed-body';
      box.append(head, body);
      const result = await this.renderInto(body, inner, [...chain, ref.noteId!], watched, states);
      box.dataset['state'] = result.state;
      nested.replaceWith(box);
    }
    for (const input of content.querySelectorAll('input')) input.disabled = true;
    out.append(content);
    return { state: 'ready', title: resolved.title };
  }

  private notice(
    doc: Document,
    resolved: Exclude<EmbedResolution, { kind: 'section' }>,
    ref: LinkRef,
    title: string | null,
  ): HTMLElement {
    const p = doc.createElement('p');
    p.className = 'pm-embed-notice';
    const name = linkLabel(ref, title);
    switch (resolved.kind) {
      case 'unresolved':
        p.textContent = `No note called “${ref.target}” yet.`;
        break;
      case 'cycle':
        p.append('Embedded in itself, so shown as a link: ', this.refLink(doc, ref, title));
        break;
      case 'too-deep':
        p.append('Nested too deep to show here: ', this.refLink(doc, ref, title));
        break;
      case 'missing':
        p.textContent =
          title === null
            ? `“${ref.target}” was deleted or is not on this device yet.`
            : `“${name}” is not on this device yet.`;
        break;
      case 'no-heading':
        p.textContent = `“${title}” has no heading “${ref.heading ?? ''}”.`;
        break;
    }
    return p;
  }

  private refLink(doc: Document, ref: LinkRef, title: string | null | undefined): HTMLElement {
    const a = doc.createElement('a');
    a.className = 'pm-wikilink';
    a.textContent = linkLabel(ref, title ?? null);
    if (ref.noteId) {
      a.href = notePath(ref.noteId);
      a.setAttribute('data-note-id', ref.noteId);
      if (ref.heading) a.setAttribute('data-heading', ref.heading);
    }
    return a;
  }

  /** Watches exactly the notes the last render showed, while on screen; none off screen. */
  private follow(): void {
    const ids = this.visible ? this.shown : new Set<string>();
    for (const [noteId, off] of this.watches) {
      if (ids.has(noteId)) continue;
      off();
      this.watches.delete(noteId);
    }
    const watch = this.services?.watch?.bind(this.services);
    if (!watch) return;
    for (const noteId of ids) {
      if (!this.watches.has(noteId))
        this.watches.set(
          noteId,
          watch(noteId, () => this.schedule()),
        );
    }
  }

  /** Attachment images in the content come from local storage, like the editor's (A30). */
  private loadImages(): void {
    const services = this.imageServices;
    for (const img of this.body.querySelectorAll<HTMLImageElement>('img[data-src]')) {
      const src = img.getAttribute('data-src')!;
      if (/^https?:\/\//i.test(src)) {
        img.src = src;
        continue;
      }
      if (!services) continue;
      const renderId = this.renderId;
      const controller = new AbortController();
      void services.resolve(src, controller.signal).then((url) => {
        if (!url) return;
        if (renderId !== this.renderId || this.destroyed) {
          services.release?.(src);
          return;
        }
        this.images.push(src);
        img.src = url;
      });
    }
  }

  private releaseImages(): void {
    for (const src of this.images) this.imageServices?.release?.(src);
    this.images = [];
  }
}

/**
 * Top-level blocks as DOM, through the schema's own rendering, built in an
 * inert document (images do not load, nothing runs) and then adopted.
 * Images keep their path in `data-src` for the view to resolve. Null when
 * the blocks do not fit the schema.
 */
export function renderBlocks(
  schema: Schema,
  blocks: readonly DocJson[],
  target: Document,
): HTMLElement | null {
  let doc: PMNode;
  try {
    doc = schema.nodeFromJSON({
      type: 'doc',
      content: blocks.length > 0 ? blocks : [{ type: 'paragraph' }],
    });
    doc.check();
  } catch {
    return null;
  }
  const inert = target.implementation.createHTMLDocument('');
  const container = inert.createElement('div');
  container.append(
    DOMSerializer.fromSchema(schema).serializeFragment(doc.content, { document: inert }),
  );
  for (const img of container.querySelectorAll('img')) {
    img.setAttribute('data-src', img.getAttribute('src') ?? '');
    img.removeAttribute('src');
  }
  for (const element of container.querySelectorAll('[contenteditable]')) {
    element.removeAttribute('contenteditable');
  }
  const adopted = target.adoptNode(container);
  adopted.className = 'pm-embed-content';
  return adopted;
}
