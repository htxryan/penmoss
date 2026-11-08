/**
 * Pasting (T15, FR-CP-2), on top of ProseMirror's own paste:
 *
 * - HTML is rewritten by `sanitizeClipboardHTML` before the parse rules read it.
 * - Plain text that looks like markdown is parsed by the core codec.
 * - ⌘⇧V / Ctrl+Shift+V (paste and match style) always inserts plain text with
 *   the marks around the cursor.
 * - Copies from VS Code (its `vscode-editor-data` entry) become a code block
 *   in the file's language.
 * - A lone picture goes to T10's image path; pictures inside HTML that are
 *   `data:` or `blob:` URLs are stored the same way before the paste goes in.
 * - In a table cell, pasted blocks become one line of inline content.
 * - In a code block, ProseMirror inserts the plain text.
 *
 * Every paste is one transaction. When it must wait (pictures to store, or the
 * codec still loading), nothing is written until then; the paste position is
 * mapped through edits made meanwhile.
 */
import {
  Fragment,
  Slice,
  type Node as PMNode,
  type ResolvedPos,
  type Schema,
} from '@tiptap/pm/model';
import { handlePaste as handleTablePaste } from '@tiptap/pm/tables';
import {
  Plugin,
  PluginKey,
  Selection,
  TextSelection,
  type EditorState,
  type Transaction,
} from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { imageFiles, type ImageServices } from '../extensions/image';
import { resolveLanguage } from '../extensions/highlight';
import { MAX_ATTACHMENT_BYTES, SNIFF_BYTES, sniffImageType } from '@penmoss/core/attachments';
import { clipboardPayload, clipboardSerializer, selectionSlice, writePayload } from './copy';
import { loadCodec, looksLikeMarkdown, markdownToSlice, readyCodec, type Codec } from './markdown';
import { sanitizeClipboardHTML } from './sanitize';
import { clipboardToken } from './token';

export interface ClipboardPluginOptions {
  /** Where pictures in pasted HTML are stored (T10); without it they are left out. */
  readonly images?: ImageServices | undefined;
}

interface PendingPaste {
  from: number;
  to: number;
}

export const clipboardKey = new PluginKey<Set<PendingPaste>>('penmossClipboard');

const LOCAL_IMAGE = /<img\b[^>]*\bsrc\s*=\s*["']?\s*(?:data:image\/|blob:)/i;
const SINGLE_URL = /^https?:\/\/[^\s<>"]+$/i;

/** VS Code's language ids where they differ from the fence names Penmoss writes. */
const VSCODE_LANGUAGES: Record<string, string> = {
  typescriptreact: 'tsx',
  javascriptreact: 'jsx',
  shellscript: 'bash',
  jsonc: 'json',
  'objective-c': 'objc',
  'objective-cpp': 'objc',
};

/** The language a VS Code mode names, as the code block picker writes it, or null. */
export function vscodeLanguage(mode: string | null | undefined): string | null {
  if (!mode || mode === 'plaintext') return null;
  const id = VSCODE_LANGUAGES[mode] ?? mode;
  return resolveLanguage(id)?.fence ?? (/^[\w+#.-]{1,32}$/.test(id) ? id.toLowerCase() : null);
}

function inCell($pos: ResolvedPos): boolean {
  const role = $pos.parent.type.spec['tableRole'] as string | undefined;
  return role === 'cell' || role === 'header_cell';
}

function isTableSlice(slice: Slice): boolean {
  return slice.content.firstChild?.type.spec['tableRole'] !== undefined;
}

/**
 * The slice as one line of inline content, for a table cell (GFM cells hold
 * inline content): blocks are joined by line breaks, a code block's lines
 * become text, and a block formula becomes an inline one.
 */
export function inlineSlice(slice: Slice, schema: Schema): Slice {
  const nodes: PMNode[] = [];
  const hardBreak = schema.nodes['hardBreak']!;
  const lineBreak = () => {
    if (nodes.length > 0 && nodes[nodes.length - 1]!.type !== hardBreak)
      nodes.push(hardBreak.create());
  };
  const visit = (fragment: Fragment) => {
    fragment.forEach((node) => {
      if (node.isInline) {
        nodes.push(node);
      } else if (node.isTextblock) {
        lineBreak();
        if (node.type.spec.code) {
          node.textContent.split('\n').forEach((line, i) => {
            if (i > 0) nodes.push(hardBreak.create());
            if (line) nodes.push(schema.text(line));
          });
        } else node.content.forEach((child) => nodes.push(child));
      } else if (node.type.name === 'blockMath' && schema.nodes['inlineMath']) {
        lineBreak();
        nodes.push(schema.nodes['inlineMath'].create({ latex: node.attrs['latex'] as string }));
      } else if (!node.isLeaf) {
        visit(node.content);
      }
    });
  };
  visit(slice.content);
  while (nodes.length > 0 && nodes[nodes.length - 1]!.type === hardBreak) nodes.pop();
  return nodes.length > 0 ? new Slice(Fragment.from(nodes), 0, 0) : Slice.empty;
}

/**
 * Tab-separated lines (a copy from a spreadsheet, or `a\tb` text) as a table
 * slice, for a paste into a table cell: prosemirror-tables fills the cells from
 * there, adding rows and columns as needed. Null when no line has a tab.
 */
export function tsvTable(text: string, schema: Schema): Slice | null {
  const lines = text.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n');
  if (!lines.some((line) => line.includes('\t'))) return null;
  const { table, tableRow, tableCell } = schema.nodes;
  if (!table || !tableRow || !tableCell) return null;
  const cell = (value: string) => {
    const text = value.trim();
    return tableCell.create(null, text ? schema.text(text) : null); // GFM cells hold inline content.
  };
  const rows = lines.map((line) => tableRow.create(null, line.split('\t').map(cell)));
  return new Slice(Fragment.from(table.create(null, rows)), 0, 0);
}

/** Fits a pasted slice to where it goes: blocks in a table cell become inline content. */
export function fitSlice(slice: Slice, $from: ResolvedPos, schema: Schema): Slice {
  return inCell($from) && !isTableSlice(slice) ? inlineSlice(slice, schema) : slice;
}

/** Plain text as ProseMirror pastes it: a paragraph per line, with the marks at the cursor. */
function plainSlice(text: string, $context: ResolvedPos, schema: Schema): Slice {
  const marks = $context.marks();
  const paragraphs = text
    .replace(/\r\n?/g, '\n')
    .split(/\n+/)
    .map((line) => schema.nodes['paragraph']!.create(null, line ? schema.text(line, marks) : null));
  return Slice.maxOpen(Fragment.from(paragraphs), false);
}

/** Inserts a slice as ProseMirror's paste does, optionally at a mapped earlier position. */
export function insertSlice(
  view: EditorView,
  slice: Slice,
  options: { plain?: boolean; at?: PendingPaste } = {},
): void {
  const tr = view.state.tr;
  if (options.at) {
    const { from, to } = options.at;
    const size = tr.doc.content.size;
    tr.setSelection(
      TextSelection.between(
        tr.doc.resolve(Math.min(from, size)),
        tr.doc.resolve(Math.min(to, size)),
      ),
    );
  }
  const fitted = fitSlice(slice, tr.selection.$from, view.state.schema);
  if (insertListItems(tr, fitted)) {
    view.dispatch(tr.scrollIntoView().setMeta('paste', true).setMeta('uiEvent', 'paste'));
    return;
  }
  const single =
    fitted.openStart === 0 && fitted.openEnd === 0 && fitted.content.childCount === 1
      ? fitted.content.firstChild
      : null;
  if (single) tr.replaceSelectionWith(single, options.plain ?? false);
  else tr.replaceSelection(fitted);
  tr.scrollIntoView().setMeta('paste', true).setMeta('uiEvent', 'paste');
  // Paste and match style never turns text into links.
  if (options.plain) tr.setMeta('preventAutolink', true);
  view.dispatch(tr);
}

/**
 * List items pasted into the same kind of list (a markdown slice opens only
 * its list, see markdownToSlice) go in as sibling items: after the item when
 * the caret ends its text, before it at its start, in place of an empty item,
 * and between the halves of a split item otherwise. ProseMirror alone would
 * nest them inside the current item.
 */
function insertListItems(tr: Transaction, slice: Slice): boolean {
  const list = slice.content.childCount === 1 ? slice.content.firstChild : null;
  const { selection } = tr;
  if (!list || slice.openStart !== 1 || slice.openEnd !== 1 || !selection.empty) return false;
  const { $from } = selection;
  if (!$from.parent.isTextblock) return false;
  for (let depth = $from.depth - 1; depth > 0; depth--) {
    if ($from.node(depth - 1).type !== list.type) continue;
    const item = $from.node(depth);
    const textAt = $from.index(depth);
    let at: number;
    if (item.childCount === 1 && item.textContent === '') {
      tr.replaceWith($from.before(depth), $from.after(depth), list.content);
      at = $from.before(depth) + list.content.size;
    } else if ($from.parentOffset === $from.parent.content.size && textAt === 0) {
      at = $from.after(depth) + list.content.size;
      tr.insert($from.after(depth), list.content);
    } else if ($from.parentOffset === 0 && textAt === 0) {
      tr.insert($from.before(depth), list.content);
      at = $from.before(depth) + list.content.size;
    } else {
      tr.split($from.pos, 2);
      tr.insert($from.pos + 2, list.content);
      at = $from.pos + 2 + list.content.size;
    }
    tr.setSelection(Selection.near(tr.doc.resolve(at), -1));
    return true;
  }
  return false;
}

const TOO_BIG = 'Images over 50 MB cannot be added';
const NOT_A_PICTURE = 'Only PNG, JPEG, GIF, WebP and AVIF images can be added';

/** Base64 characters in `text`, not counting the whitespace a mail client may wrap it with. */
function base64Length(text: string): number {
  let length = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) > 32) length += 1;
  return length;
}

/**
 * Bytes of a `data:` picture: refused before it is decoded when it is over
 * the attachment limit or its first bytes are not a supported picture (T10's
 * checks, early, so a huge paste cannot freeze the tab).
 */
function dataPictureBytes(src: string): Uint8Array<ArrayBuffer> {
  const comma = src.indexOf(',');
  if (comma < 0 || !/;base64$/i.test(src.slice(0, comma))) throw new Error(NOT_A_PICTURE);
  const payload = src.slice(comma + 1);
  // Four characters make three bytes; whitespace is counted only when it could matter.
  if (
    payload.length * 0.75 > MAX_ATTACHMENT_BYTES &&
    base64Length(payload) * 0.75 > MAX_ATTACHMENT_BYTES
  ) {
    throw new Error(TOO_BIG);
  }
  const head = payload.slice(0, Math.ceil(SNIFF_BYTES / 3) * 4 + 64).replace(/\s+/g, '');
  const sniffed = decode(head.slice(0, Math.ceil(SNIFF_BYTES / 3) * 4));
  if (!sniffImageType(sniffed)) throw new Error(NOT_A_PICTURE);
  return decode(payload.replace(/\s+/g, ''));
}

function decode(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Bytes of a `data:` or `blob:` picture. A `blob:` one is read as it is when
 * the browser allows (`connect-src blob:`; this origin's blobs only), else
 * drawn through a canvas, which re-encodes it as PNG.
 */
export async function pictureBytes(src: string, doc: Document): Promise<Uint8Array<ArrayBuffer>> {
  if (/^data:/i.test(src)) return dataPictureBytes(src);
  const win = doc.defaultView;
  if (!win) throw new Error('No window to read the picture in');
  try {
    const response = await win.fetch(src);
    if (response.ok) {
      const blob = await response.blob();
      if (blob.size > MAX_ATTACHMENT_BYTES) throw new Error(TOO_BIG);
      return new Uint8Array(await blob.arrayBuffer());
    }
  } catch (error) {
    if (error instanceof Error && error.message === TOO_BIG) throw error;
    // Not readable as a file (another origin's blob, or a stricter policy): the canvas below.
  }
  const img = new win.Image();
  img.src = src;
  await Promise.race([
    img.decode(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Picture timed out')), 5000)),
  ]);
  const canvas = doc.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  canvas.getContext('2d')?.drawImage(img, 0, 0);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('Could not read the picture');
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * Paste and match style for text handed over by an app shell (Android's own
 * "Paste as plain text", T40 P8, ED11): exactly what ⌘⇧V / Ctrl+Shift+V
 * inserts, a paragraph per line with the marks at the caret, never parsed as
 * markdown and never turned into a link. In a code block the text goes in as
 * it is. False for empty text or a read-only editor.
 */
export function pastePlainText(view: EditorView, text: string): boolean {
  if (!text || !view.editable) return false;
  const { $from } = view.state.selection;
  if ($from.parent.type.spec.code) {
    view.dispatch(
      view.state.tr
        .insertText(text.replace(/\r\n?/g, '\n'))
        .scrollIntoView()
        .setMeta('paste', true)
        .setMeta('uiEvent', 'paste'),
    );
    return true;
  }
  insertSlice(view, plainSlice(text, $from, view.state.schema), { plain: true });
  return true;
}

export function clipboardPlugin(schema: Schema, options: ClipboardPluginOptions = {}): Plugin {
  /** Set by ⌘⇧V / Ctrl+Shift+V (and Chrome's ⌥⇧⌘V) until the paste it causes. */
  let plainUntil = 0;
  let dropping = false;
  const plainIntent = () => Date.now() < plainUntil;

  const track = (state: EditorState): PendingPaste => {
    const pending = { from: state.selection.from, to: state.selection.to };
    clipboardKey.getState(state)?.add(pending);
    return pending;
  };
  const untrack = (view: EditorView, pending: PendingPaste) => {
    if (!view.isDestroyed) clipboardKey.getState(view.state)?.delete(pending);
  };

  /**
   * Markdown once the codec has loaded; if it cannot load (offline before the
   * chunk was cached), the text goes in as plain paragraphs rather than not at all.
   */
  const markdownLater = (view: EditorView, text: string) =>
    later(view, (at) =>
      loadCodec().then(
        (codec: Codec) => markdownToSlice(text, view.state.schema, codec, at()),
        () => plainSlice(text, at(), view.state.schema),
      ),
    );

  /** Pastes once `slice` resolves, at the position the paste was made (mapped meanwhile). */
  const later = (view: EditorView, slice: (at: () => ResolvedPos) => Promise<Slice | null>) => {
    const pending = track(view.state);
    const at = () => view.state.doc.resolve(Math.min(pending.from, view.state.doc.content.size));
    void slice(at)
      .then((result) => {
        if (result && !view.isDestroyed) insertSlice(view, result, { at: pending });
      })
      .catch((error: unknown) => console.error('[clipboard] paste failed', error))
      .finally(() => untrack(view, pending));
  };

  const pasteWithPictures = (view: EditorView, html: string, images: ImageServices) => {
    const pending = track(view.state);
    const doc = view.dom.ownerDocument;
    const parser = new (doc.defaultView ?? window).DOMParser();
    const clean = sanitizeClipboardHTML(html, parser, {
      localImages: 'keep',
      trustedMarker: clipboardToken(),
    });
    void (async () => {
      const paths = new Map<string, string>();
      for (const src of clean.localImages) {
        try {
          paths.set(src, (await images.add(await pictureBytes(src, doc))).path);
        } catch (error) {
          images.onError?.(error instanceof Error ? error.message : String(error));
        }
      }
      if (view.isDestroyed) return;
      const out = parser.parseFromString(clean.html, 'text/html');
      for (const img of out.querySelectorAll('img')) {
        const path = paths.get(img.getAttribute('src') ?? '');
        if (path) img.setAttribute('src', path);
        else if (clean.localImages.includes(img.getAttribute('src') ?? '')) {
          img.replaceWith(out.createTextNode(img.getAttribute('alt') ?? ''));
        }
      }
      const { from, to } = pending;
      const size = view.state.doc.content.size;
      // Selection only (no document change), then the paste: still one write to the Y.Doc.
      view.dispatch(
        view.state.tr.setSelection(
          TextSelection.between(
            view.state.doc.resolve(Math.min(from, size)),
            view.state.doc.resolve(Math.min(to, size)),
          ),
        ),
      );
      view.pasteHTML(out.body.innerHTML);
    })()
      .catch((error: unknown) => console.error('[clipboard] paste failed', error))
      .finally(() => untrack(view, pending));
  };

  const pasteFromVSCode = (
    view: EditorView,
    event: ClipboardEvent,
    meta: string,
    text: string,
  ): boolean => {
    let mode: string | null;
    try {
      mode = (JSON.parse(meta) as { mode?: string }).mode ?? null;
    } catch {
      return false;
    }
    const { schema } = view.state;
    const code = text.replace(/\r\n?/g, '\n').replace(/\n$/, '');
    if (!code) return false;
    event.preventDefault();
    if (mode === 'markdown') {
      const codec = readyCodec();
      if (codec)
        insertSlice(view, markdownToSlice(code, schema, codec, view.state.selection.$from));
      else markdownLater(view, code);
      return true;
    }
    const language = vscodeLanguage(mode);
    if (!code.includes('\n')) {
      // One line: a symbol or an expression. Code as inline code; plain text as text.
      const $from = view.state.selection.$from;
      const marks =
        language && schema.marks['code']
          ? [...$from.marks(), schema.marks['code'].create()]
          : $from.marks();
      const line = schema.nodes['paragraph']!.create(null, schema.text(code, marks));
      insertSlice(view, new Slice(Fragment.from(line), 1, 1));
      return true;
    }
    if (!mode || mode === 'plaintext') {
      insertSlice(view, plainSlice(code, view.state.selection.$from, schema));
      return true;
    }
    const block = schema.nodes['codeBlock']!.create({ language }, schema.text(code));
    insertSlice(view, new Slice(Fragment.from(block), 0, 0));
    return true;
  };

  return new Plugin<Set<PendingPaste>>({
    key: clipboardKey,
    state: {
      init: () => new Set(),
      apply(tr, pending) {
        if (tr.docChanged) {
          for (const at of pending) {
            const empty = at.from === at.to;
            at.from = tr.mapping.map(at.from, empty ? -1 : 1);
            at.to = empty ? at.from : Math.max(at.from, tr.mapping.map(at.to, -1));
          }
        }
        return pending;
      },
    },
    props: {
      clipboardSerializer: clipboardSerializer(schema),
      handleDOMEvents: {
        keydown(_view, event) {
          const v = event.code === 'KeyV' || event.key.toLowerCase() === 'v';
          if ((event.metaKey || event.ctrlKey) && event.shiftKey && v) {
            plainUntil = Date.now() + 1000;
          }
          return false;
        },
        drop() {
          dropping = true;
          queueMicrotask(() => (dropping = false));
          return false;
        },
        copy(view, event) {
          return copyEvent(view, event, false);
        },
        cut(view, event) {
          return copyEvent(view, event, true);
        },
        paste(view, event) {
          const data = event.clipboardData;
          if (!data) return false;
          if (view.state.selection.$from.parent.type.spec.code) return false; // Plain text.
          if (imageFiles(data, 'paste').length > 0) return false; // T10's image path.
          if (plainIntent()) return false; // ProseMirror's plain paste; handlePaste inserts it.
          const text = data.getData('text/plain');
          const meta = data.getData('vscode-editor-data');
          if (meta && text) return pasteFromVSCode(view, event, meta, text);
          const html = data.getData('text/html');
          if (html && options.images && LOCAL_IMAGE.test(html)) {
            event.preventDefault();
            pasteWithPictures(view, html, options.images);
            return true;
          }
          // Tab-separated text into a table fills its cells, even when a value looks
          // like markdown (prosemirror-tables' own paste, given the cells as a table).
          const cells =
            !html && inCell(view.state.selection.$from) ? tsvTable(text, view.state.schema) : null;
          if (cells && handleTablePaste(view, event, cells)) {
            event.preventDefault();
            return true;
          }
          if (!html && text && looksLikeMarkdown(text)) {
            // Inserted here rather than through clipboardTextParser: ProseMirror re-opens
            // that slice fully, which would merge a pasted heading into the paragraph.
            event.preventDefault();
            const codec = readyCodec();
            if (codec) {
              const { $from } = view.state.selection;
              insertSlice(view, markdownToSlice(text, view.state.schema, codec, $from));
            } else markdownLater(view, text);
            return true;
          }
          return false;
        },
      },
      transformPastedHTML(html, view) {
        const parser = new (view.dom.ownerDocument.defaultView ?? window).DOMParser();
        return sanitizeClipboardHTML(html, parser, { trustedMarker: clipboardToken() }).html;
      },
      clipboardTextParser(text, $context, plain, view) {
        if (plain || plainIntent()) return null as unknown as Slice; // ProseMirror's own: styled like the text around.
        const { schema } = view.state;
        const trimmed = text.trim();
        if (SINGLE_URL.test(trimmed) && schema.marks['link']) {
          const link = schema.marks['link'].create({ href: trimmed });
          const line = schema.nodes['paragraph']!.create(
            null,
            schema.text(trimmed, [...$context.marks(), link]),
          );
          return new Slice(Fragment.from(line), 1, 1);
        }
        return null as unknown as Slice;
      },
      transformPasted(slice, view) {
        if (dropping) return slice;
        return fitSlice(slice, view.state.selection.$from, view.state.schema);
      },
      handlePaste(view, _event, slice) {
        if (!plainIntent()) return false;
        plainUntil = 0;
        // Inserted here so no other paste handler (link-on-paste) restyles plain text.
        insertSlice(view, slice, { plain: true });
        return true;
      },
    },
  });
}

/** Copy and cut: the HTML and the markdown together (copy.ts). */
function copyEvent(view: EditorView, event: ClipboardEvent, cut: boolean): boolean {
  const { selection } = view.state;
  if (selection.empty || !event.clipboardData) return false;
  event.preventDefault();
  writePayload(
    event.clipboardData,
    clipboardPayload(view, selectionSlice(view.state), 'both', readyCodec()),
  );
  if (cut)
    view.dispatch(view.state.tr.deleteSelection().scrollIntoView().setMeta('uiEvent', 'cut'));
  return true;
}
