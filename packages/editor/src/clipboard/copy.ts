/**
 * Copying (T15, FR-CP-1). A copy writes standard HTML for rich-text apps
 * (Google Docs, Apple Notes, Slack, another Penmoss note) and markdown as the
 * plain text (VS Code, terminals, any plain field). Copy as Markdown writes
 * only the markdown; Copy as rich text writes the HTML with readable plain
 * text (no markdown syntax). With nothing selected, the explicit commands
 * copy the whole note.
 */
import {
  DOMSerializer,
  Slice,
  type Fragment,
  type Node as PMNode,
  type Schema,
} from '@tiptap/pm/model';
import type { EditorState } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { PENMOSS_MARKER } from './sanitize';
import { clipboardToken } from './token';
import {
  leafText,
  loadCodec,
  readyCodec,
  sliceToMarkdown,
  type Codec,
  type NoteFields,
} from './markdown';

export type CopyFormat = 'both' | 'markdown' | 'rich';

export interface ClipboardPayload {
  /** `text/html`, absent for Copy as Markdown. */
  readonly html?: string;
  readonly text: string;
}

/**
 * The HTML a copy writes: the editor's own rendering, except where that is
 * not standard HTML other apps understand. Callouts become a quote with
 * their title in bold (Docs and Notes show a quote; Penmoss reads the data
 * attributes back), and tables lose TipTap's column sizing.
 */
export function clipboardSerializer(schema: Schema): DOMSerializer {
  const base = DOMSerializer.fromSchema(schema);
  const nodes = { ...base.nodes };
  if (schema.nodes['callout']) {
    nodes['callout'] = (node: PMNode) => {
      const type = node.attrs['type'] as string;
      const title = node.attrs['title'] as string;
      const attrs: Record<string, string> = { 'data-callout': type };
      if (title) attrs['data-callout-title'] = title;
      if (node.attrs['foldable']) attrs['data-callout-fold'] = node.attrs['collapsed'] ? '-' : '+';
      const heading = title || type.charAt(0).toUpperCase() + type.slice(1);
      return [
        'blockquote',
        attrs,
        ['p', { 'data-callout-heading': '' }, ['strong', heading]],
        ['div', 0],
      ];
    };
  }
  if (schema.nodes['table']) nodes['table'] = () => ['table', ['tbody', 0]];
  return new DOMSerializer(nodes, base.marks);
}

/**
 * What the selection copies: its content, with an ordered list the selection
 * starts inside numbered from the first copied item (copying items 4 and 5
 * gives `4.` and `5.`, as they read).
 */
export function selectionSlice(state: EditorState): Slice {
  const { selection } = state;
  const slice = selection.content();
  const { $from } = selection;
  const renumber = (fragment: Fragment, depth: number): Fragment => {
    const first = fragment.firstChild;
    if (!first || depth > slice.openStart || depth > $from.depth) return fragment;
    const content = renumber(first.content, depth + 1);
    let node: PMNode = content === first.content ? first : first.copy(content);
    const index = $from.index(depth);
    if (node.type.name === 'orderedList' && index > 0 && $from.node(depth).type === node.type) {
      const start = (node.attrs['start'] as number | undefined) ?? 1;
      node = node.type.create({ ...node.attrs, start: start + index }, node.content, node.marks);
    }
    return node === first ? fragment : fragment.replaceChild(0, node);
  };
  const content = renumber(slice.content, 1);
  return content === slice.content ? slice : new Slice(content, slice.openStart, slice.openEnd);
}

/** Readable plain text for a slice: block text separated by blank lines, no markup. */
export function plainText(slice: Slice): string {
  return slice.content.textBetween(0, slice.content.size, '\n\n', leafText).replace(/\s+$/, '');
}

/**
 * What to put on the clipboard for `slice`, or for the whole note when
 * `slice` is null. Markdown needs the codec; without it (it has not loaded
 * yet) the plain text stands in.
 */
export function clipboardPayload(
  view: EditorView,
  slice: Slice | null,
  format: CopyFormat,
  codec: Codec | null,
  note: NoteFields | null = null,
): ClipboardPayload {
  const whole = slice === null;
  const content = slice ?? new Slice(view.state.doc.content, 0, 0);
  const markdown = () =>
    codec ? sliceToMarkdown(content, codec, whole ? note : null) : plainText(content);
  if (format === 'markdown') return { text: markdown() };
  const { dom } = view.serializeForClipboard(content);
  // Marks the HTML as this install's own, next to ProseMirror's slice marker (token.ts).
  dom.querySelector('[data-pm-slice]')?.setAttribute(PENMOSS_MARKER, clipboardToken());
  const html = dom.innerHTML;
  return { html, text: format === 'rich' ? plainText(content) : markdown() };
}

/** Writes a payload into a copy or cut event's clipboard data. */
export function writePayload(data: DataTransfer, payload: ClipboardPayload): void {
  data.clearData();
  if (payload.html !== undefined) data.setData('text/html', payload.html);
  data.setData('text/plain', payload.text);
}

/**
 * Puts a payload on the system clipboard from a command (a shortcut, a menu
 * item). `execCommand('copy')` inside the user's gesture fires a copy event
 * whose data we fill, which works in browsers, Electron and the Android
 * WebView without a permission; where it does not, the async Clipboard API
 * takes over.
 */
export async function writeClipboard(doc: Document, payload: ClipboardPayload): Promise<boolean> {
  let written = false;
  const onCopy = (event: ClipboardEvent) => {
    if (!event.clipboardData) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    writePayload(event.clipboardData, payload);
    written = true;
  };
  // Chrome copies only when something is selected, unless `beforecopy` is cancelled.
  const allow = (event: Event) => event.preventDefault();
  doc.addEventListener('copy', onCopy, true);
  doc.addEventListener('beforecopy', allow, true);
  try {
    if (typeof doc.execCommand === 'function') doc.execCommand('copy');
  } catch {
    // Not supported: the async API below.
  } finally {
    doc.removeEventListener('copy', onCopy, true);
    doc.removeEventListener('beforecopy', allow, true);
  }
  if (written) return true;
  const clipboard = doc.defaultView?.navigator.clipboard;
  if (!clipboard) return false;
  try {
    const ClipboardItemCtor = doc.defaultView?.ClipboardItem;
    if (payload.html !== undefined && ClipboardItemCtor && clipboard.write) {
      await clipboard.write([
        new ClipboardItemCtor({
          'text/html': new Blob([payload.html], { type: 'text/html' }),
          'text/plain': new Blob([payload.text], { type: 'text/plain' }),
        }),
      ]);
    } else {
      await clipboard.writeText(payload.text);
    }
    return true;
  } catch {
    return false;
  }
}

/** What a native clipboard gets: every format at once (T29: HTML, plain text and markdown). */
export interface NativeClipboardPayload extends ClipboardPayload {
  /** The markdown, also offered under the platform's markdown type (`net.daringfireball.markdown`). */
  readonly markdown?: string;
}

export type NativeClipboardWriter = (payload: NativeClipboardPayload) => Promise<boolean>;

let nativeWriter: NativeClipboardWriter | null = null;

/**
 * Lets an app shell write the explicit copies itself (the Mac app's
 * clipboard bridge, T29): one write with HTML, plain text and markdown, which
 * a page's copy event cannot do. Null restores the browser's clipboard.
 */
export function setNativeClipboard(writer: NativeClipboardWriter | null): void {
  nativeWriter = writer;
}

/**
 * Puts plain text on the clipboard (a code block's Copy button): through the
 * app shell's clipboard when there is one (the Android app's, T40 P8, ED7,
 * where the WebView's `navigator.clipboard` is not to be relied on; the Mac
 * app's), otherwise the async Clipboard API. Resolves with whether it was written.
 */
export async function copyText(doc: Document, text: string): Promise<boolean> {
  if (nativeWriter) {
    try {
      if (await nativeWriter({ text })) return true;
    } catch {
      // The shell could not write it: the page's own clipboard below.
    }
  }
  const clipboard = doc.defaultView?.navigator.clipboard;
  if (!clipboard) return false;
  try {
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Copy as Markdown or rich text through the app shell's clipboard: no user gesture needed. */
async function copyNative(
  writer: NativeClipboardWriter,
  view: EditorView,
  slice: Slice | null,
  format: 'markdown' | 'rich',
  note: NoteFields | null,
): Promise<boolean> {
  const codec = readyCodec() ?? (await loadCodec().catch(() => null));
  const payload = clipboardPayload(view, slice, format, codec, note);
  const markdown =
    format === 'markdown'
      ? payload.text
      : codec
        ? clipboardPayload(view, slice, 'markdown', codec, note).text
        : undefined;
  try {
    if (await writer(markdown === undefined ? payload : { ...payload, markdown })) return true;
  } catch {
    // The shell could not write it: the page's own clipboard below.
  }
  return writeClipboard(view.dom.ownerDocument, payload);
}

/**
 * Copy as Markdown or Copy as rich text: the selection, or the whole note when
 * nothing is selected. Resolves with whether the clipboard was written.
 */
export async function copyAs(
  view: EditorView,
  format: 'markdown' | 'rich',
  note: NoteFields | null = null,
  whole = false,
): Promise<boolean> {
  const slice = whole || view.state.selection.empty ? null : selectionSlice(view.state);
  if (nativeWriter) return copyNative(nativeWriter, view, slice, format, note);
  const codec = readyCodec();
  const doc = view.dom.ownerDocument;
  if (codec || format === 'rich') {
    return writeClipboard(doc, clipboardPayload(view, slice, format, codec, note));
  }
  // The codec is still loading (the first copy right after opening). The write must
  // start inside the gesture (Safari refuses one after it), so the clipboard gets a
  // promise of the markdown; without promise support, the markdown follows the load.
  const markdown = loadCodec()
    .catch(() => null)
    .then((loaded) => clipboardPayload(view, slice, format, loaded, note).text);
  const promised = writePromised(doc, markdown);
  if (promised) return promised;
  return writeClipboard(doc, { text: await markdown });
}

/** Writes text that is still being made through `ClipboardItem`'s promise support, or null. */
function writePromised(doc: Document, text: Promise<string>): Promise<boolean> | null {
  const win = doc.defaultView;
  const clipboard = win?.navigator.clipboard;
  const ClipboardItemCtor = win?.ClipboardItem;
  if (!clipboard?.write || !ClipboardItemCtor) return null;
  if (
    typeof ClipboardItemCtor.supports === 'function' &&
    !ClipboardItemCtor.supports('text/plain')
  ) {
    return null;
  }
  try {
    const blob = text.then((value) => new Blob([value], { type: 'text/plain' }));
    return clipboard.write([new ClipboardItemCtor({ 'text/plain': blob })]).then(
      () => true,
      () => false,
    );
  } catch {
    return null; // A ClipboardItem without promise support.
  }
}
