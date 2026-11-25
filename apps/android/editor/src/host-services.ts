/**
 * The editor host's services for the open note (PEN-186, split from `host.ts`): its counts, its
 * pictures and files through the app, conflict copies, the theme and its preview, the phone's
 * notes for wikilinks and new notes made from a link.
 */
import {
  attachmentPath,
  filePath,
  IMAGE_TYPES,
  MAX_ATTACHMENT_BYTES,
  parseAttachmentPath,
  SNIFF_BYTES,
  sniffFileType,
  sniffImageType,
} from '@penmoss/core/attachments';
import { ulid } from '@penmoss/core/ids';
import {
  createCollabEditor,
  noteExtensions,
  type FileServices,
  type ImageServices,
  type LinkServices,
  type NoteCandidate,
} from '@penmoss/editor';
import { docText, textStats } from '@penmoss/model/stats';
import { NOTE_ROOT } from '@penmoss/model/replica';
import { initNote, isoWithOffset, readTitle } from '@penmoss/model/note';
import { conflictCopy } from '@penmoss/model/records';
import { createYjs14Replica } from '@penmoss/model/yjs14';
import {
  applyThemeTo,
  builtInTheme,
  fontVariables,
  parseTheme,
  type Theme,
} from '@penmoss/ui/theme';
import type { Editor } from '@tiptap/core';
import * as Y from '@y/y';
import { toBase64 } from 'lib0/buffer';
import {
  BRIDGE_VERSION,
  MAX_FILE_NAME,
  MAX_HEADING_CHARS,
  type CopyFailure,
  type CopyInto,
  type DirectoryEntry,
  type FileAction,
  type FileEntry,
  type FromEditor,
  type NewNote,
  type StoredUpdate,
  type TextCounts,
} from './protocol';
import {
  ATTACHMENT_URL_PREFIX,
  bodyOf,
  completeDoc,
  COUNT_DELAY_MS,
  displayTitle,
  FILE_INFO_MS,
  type FileInfo,
  hex,
  holdsNothing,
  MAX_REMOTE_URL,
  type OpenNote,
  PREVIEW_HTML,
  PREVIEW_NOTE_ID,
  PREVIEW_TITLE,
  REMOTE_PICTURE_PATH,
  SELECTION_COUNT_MS,
  STORE_PICTURE_MS,
} from './host-support';
import { HostBase } from './host-base';

export abstract class HostServices extends HostBase {
  /**
   * The note's counts (T40 P8, NT24), as the web's status bar takes them
   * (T41, A505): after typing pauses, the selection's shortly after it
   * changes, and sent only when they changed.
   */
  protected countWords(open: OpenNote, editor: Editor): () => void {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const count = () => {
      timer = null;
      if (this.current !== open || editor.isDestroyed) return;
      const doc = textStats(docText(editor.state.doc));
      const { from, to } = editor.state.selection;
      const picked = from === to ? null : textStats(docText(editor.state.doc, from, to));
      const selection: TextCounts | null =
        picked && picked.characters > 0
          ? { words: picked.words, characters: picked.characters }
          : null;
      const message: FromEditor = {
        v: BRIDGE_VERSION,
        type: 'counts',
        noteId: open.noteId,
        words: doc.words,
        characters: doc.characters,
        minutes: doc.minutes,
        selection,
      };
      const text = JSON.stringify(message);
      if (text === this.lastCounts) return;
      this.lastCounts = text;
      this.post(message);
    };
    const later = (ms: number) => () => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(count, ms);
    };
    const onUpdate = later(COUNT_DELAY_MS);
    const onSelection = later(SELECTION_COUNT_MS);
    timer = setTimeout(count, 0);
    editor.on('update', onUpdate);
    editor.on('selectionUpdate', onSelection);
    return () => {
      editor.off('update', onUpdate);
      editor.off('selectionUpdate', onSelection);
      if (timer !== null) clearTimeout(timer);
    };
  }

  /** Pictures the app stored from the photo picker, at the selection (A304). */
  protected insertImages(noteId: string, paths: readonly string[]): void {
    const editor = this.editableEditor(noteId);
    if (!editor) return;
    const type = editor.schema.nodes['image'];
    if (!type) return;
    const { view } = editor;
    for (const path of paths) {
      const image = type.create({ src: path, alt: '' });
      view.dispatch(view.state.tr.replaceSelectionWith(image).scrollIntoView());
    }
    view.focus();
  }

  /**
   * Files the app stored from the document picker (ED12), at the selection:
   * a picture as a picture, anything else as a chip with its name, as the
   * web's `insertFiles` does.
   */
  protected insertFileEntries(noteId: string, files: readonly FileEntry[]): void {
    const editor = this.editableEditor(noteId);
    if (!editor || this.current?.sourceOff) return;
    const { image, attachment } = editor.schema.nodes;
    if (!image || !attachment) return;
    const pictures = new Set<string>(Object.values(IMAGE_TYPES));
    const { view } = editor;
    for (const file of files) {
      const ext = parseAttachmentPath(file.path)?.ext ?? '';
      const node = pictures.has(ext)
        ? image.create({ src: file.path, alt: '' })
        : attachment.create({ href: file.path, name: file.name || 'File' });
      view.dispatch(view.state.tr.replaceSelectionWith(node).scrollIntoView());
    }
    view.focus();
  }

  /**
   * Edits kept apart from a note become a copy of it (A5, A306): what they
   * were made on with the edits applied, as a new note with fresh Yjs items,
   * exactly as the web app saves one. It fails closed (A309): edits that build
   * on something they were not sent are never copied without it, since the
   * copy would silently lack them; the app keeps them instead. Edits that
   * change nothing a copy would show make no copy. And when a copy of earlier
   * edits of the same copy exists and still shows exactly those, the new ones
   * are merged into it rather than making another.
   */
  protected copyConflicts(
    noteId: string,
    base: readonly StoredUpdate[],
    edits: readonly StoredUpdate[],
    into: CopyInto | undefined,
  ): void {
    const replaces = edits.map((stored) => stored.id);
    const failed = (reason: CopyFailure) =>
      this.post({ v: BRIDGE_VERSION, type: 'copyFailed', noteId, reason, replaces });
    let full: Y.Doc | null = null;
    let before: Y.Doc | null = null;
    try {
      full = completeDoc([...base, ...edits]);
      if (!full) return failed('incomplete');
      before = completeDoc(base);
      const unchanged =
        before !== null && bodyOf(before) === bodyOf(full) && readTitle(before) === readTitle(full);
      if (holdsNothing(full) || unchanged) return failed('empty');
      const merged = into && before ? this.mergeIntoCopy(into, before, full) : null;
      if (merged) {
        this.post({
          v: BRIDGE_VERSION,
          type: 'conflictCopy',
          noteId,
          note: merged,
          replaces,
          merged: true,
        });
        return;
      }
      const record = conflictCopy(Y.encodeStateAsUpdate(full), { now: this.now() });
      this.post({
        v: BRIDGE_VERSION,
        type: 'conflictCopy',
        noteId,
        note: { id: record.noteId, title: record.title ?? '', update: toBase64(record.update) },
        replaces,
      });
    } catch {
      failed('unreadable');
    } finally {
      full?.destroy();
      before?.destroy();
    }
  }

  /**
   * The edit that brings an existing conflict copy up to `full`, when the copy
   * still shows exactly what it was made from (`before`); null otherwise. The
   * body is replaced in one transaction on the copy's own items, so it merges
   * with anything the server has of the copy.
   */
  protected mergeIntoCopy(into: CopyInto, before: Y.Doc, full: Y.Doc): NewNote | null {
    const copy = completeDoc(into.updates);
    if (!copy) return null;
    try {
      if (bodyOf(copy) !== bodyOf(before)) return null;
      const known = Y.encodeStateVector(copy);
      copy.transact(() => {
        const body = copy.get(NOTE_ROOT);
        body.delete(0, body.length);
        body.applyDelta(full.get(NOTE_ROOT).toDeltaDeep());
      });
      return {
        id: into.noteId,
        title: readTitle(copy),
        update: toBase64(Y.encodeStateAsUpdate(copy, known)),
      };
    } finally {
      copy.destroy();
    }
  }

  /**
   * The theme editor's preview (T40 P1b, A418): the sample note in the real editor, so the
   * preview is the note's own stylesheet. Its document is made here and never leaves: no
   * update, title or state is sent to the app, and nothing can be typed.
   */
  protected preview(): void {
    this.close();
    const replica = createYjs14Replica();
    initNote(replica.doc, {
      id: PREVIEW_NOTE_ID,
      created: isoWithOffset(this.now()),
      kind: 'note',
    });
    const { title, body, root } = this.elements;
    title.value = PREVIEW_TITLE;
    title.readOnly = true;
    this.fitTitle();
    const open: OpenNote = {
      noteId: PREVIEW_NOTE_ID,
      replica,
      collab: null,
      flush: () => undefined,
      sendText: () => undefined,
      held: [],
      holdTimer: null,
      sourceOff: null,
      teardown: () => {
        open.collab?.destroy();
        body.replaceChildren();
        replica.destroy();
      },
    };
    this.current = open;
    open.collab = createCollabEditor({
      element: body,
      extensions: noteExtensions({
        links: this.links(PREVIEW_NOTE_ID),
        images: this.images(PREVIEW_NOTE_ID),
        symbols: this.symbolSource,
      }),
      replica,
    });
    const { editor } = open.collab;
    editor.commands.setContent(PREVIEW_HTML);
    editor.setEditable(false);
    editor.view.dom.setAttribute('aria-label', 'Theme preview');
    root.dataset['preview'] = 'true';
    root.hidden = false;
  }

  /** Shows the theme the app resolved (A305); a built-in comes from this build's own copy. */
  protected applyTheme(raw: Readonly<Record<string, unknown>>, variant: 'light' | 'dark'): void {
    const theme: Theme | null = builtInTheme(raw['id']) ?? parseTheme(raw)?.theme ?? null;
    if (!theme) {
      this.fail(null, 'The app sent a theme this editor cannot read');
      return;
    }
    this.theme = { theme, variant };
    this.applyAppearance();
  }

  /**
   * The theme, then the person's fonts over it (T51, A944): the theme's own fonts come back
   * when a font goes back to Theme Default, so each change lays both again.
   */
  protected applyAppearance(): void {
    const root = this.elements.root.ownerDocument.documentElement;
    if (this.theme) applyThemeTo(root, this.theme.theme, this.theme.variant);
    if (!this.fonts) return;
    for (const [name, value] of Object.entries(fontVariables(this.fonts)))
      root.style.setProperty(name, value);
  }

  /** The phone's notes for wikilinks (A303): titles change in every open link at once. */
  protected setDirectory(notes: readonly DirectoryEntry[]): void {
    this.notes = notes;
    this.notesById = new Map(notes.map((entry) => [entry.id, entry]));
    for (const listener of [...this.linkListeners]) listener();
  }

  /**
   * Wikilinks (T16) from the phone's note list (A303). A note made from a
   * link is created here, like the web app does, and handed to the app to
   * store, upload and file beside this one.
   */
  protected links(noteId: string): LinkServices {
    return {
      noteId,
      title: (id) => {
        const entry = this.notesById.get(id);
        return entry ? displayTitle(entry.title) : null;
      },
      search: (query, limit): readonly NoteCandidate[] =>
        this.matcher
          .filter(
            this.notes.filter((entry) => entry.id !== noteId),
            query,
            (entry) => displayTitle(entry.title),
            limit,
          )
          .map((entry) => ({
            id: entry.id,
            title: displayTitle(entry.title),
            ...(entry.folder ? { detail: entry.folder } : {}),
          })),
      resolve: (title) => {
        const wanted = title.trim().toLowerCase();
        if (!wanted) return null;
        return this.notes.find((entry) => entry.title.trim().toLowerCase() === wanted)?.id ?? null;
      },
      create: (title) => this.createNote(noteId, title),
      // At a heading when the link names one (T40 P7, LK3): the app opens the note there.
      open: (target, heading) =>
        this.post({
          v: BRIDGE_VERSION,
          type: 'openNote',
          noteId: target,
          ...(heading?.trim() ? { heading: heading.trim().slice(0, MAX_HEADING_CHARS) } : {}),
        }),
      // `[[Title#` headings and embeds from the other note's stored updates (T40 P7, A470).
      headings: (target) => this.linked.headings(target),
      body: (target) => this.linked.body(target),
      watch: (target, listener) => this.linked.watch(target, listener),
      subscribe: (listener) => {
        this.linkListeners.add(listener);
        return () => this.linkListeners.delete(listener);
      },
    };
  }

  protected createNote(from: string, raw: string): string | null {
    const title = raw.replace(/[\r\n]+/g, ' ').trim();
    if (!title) return null;
    const now = this.now();
    const id = ulid(now.getTime());
    const replica = createYjs14Replica();
    let note: NewNote;
    try {
      initNote(replica.doc, { id, created: isoWithOffset(now), kind: 'note' }, title);
      note = { id, title, update: toBase64(replica.encodeStateAsUpdate()) };
    } finally {
      replica.destroy();
    }
    // Known at once, so the new link shows its title before the app's list catches up.
    this.setDirectory([{ id, title }, ...this.notes]);
    this.post({ v: BRIDGE_VERSION, type: 'newNote', noteId: from, note });
    return id;
  }

  /**
   * Pictures in the note (T10) through the app (A304). A pasted or dropped
   * picture is checked and hashed here and handed to the app, which stores it
   * and uploads it when it can; the note shows pictures from the app's origin,
   * where the app serves them from the phone or fetches them with its token.
   * Pictures from web addresses come through the app too (ED13; A293).
   */
  protected images(noteId: string): ImageServices {
    return {
      add: async (bytes) => {
        if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
          throw new Error('Pictures over 50 MB cannot be added');
        }
        const type = sniffImageType(bytes);
        if (!type) throw new Error('Only PNG, JPEG, GIF, WebP and AVIF pictures can be added');
        const sha256 = hex(await crypto.subtle.digest('SHA-256', bytes));
        const path = attachmentPath(sha256, type);
        // Inserted only once the phone has it (A311): a picture the phone could not store is
        // never named by the note, and the WebView finds the file when it asks for it.
        const stored = this.waitForStore(path);
        // The message, then its bytes as the very next one (the app pairs them, A304).
        this.post({ v: BRIDGE_VERSION, type: 'attachment', noteId, path, size: bytes.byteLength });
        this.postBytes(bytes);
        if (!(await stored)) throw new Error('The picture could not be stored on this phone');
        return { path };
      },
      resolve: (src) => {
        const parsed = parseAttachmentPath(src);
        return Promise.resolve(
          parsed ? `${ATTACHMENT_URL_PREFIX}${parsed.sha256}.${parsed.ext}` : null,
        );
      },
      onError: (message) => this.notice(noteId, message),
      web: (src, now) => this.webPicture(noteId, src, now),
    };
  }

  /**
   * Files in the note (T13) through the app (T40 P8, ED12): a dropped or
   * pasted file is hashed and sniffed here and handed to the app, which checks
   * it against its path, stores it and uploads it with the pictures; it goes
   * into the note only once stored (A311). A chip's size and type come from the
   * app, and Open and Save a copy are the app's: the page never holds a file's
   * URL, and a PDF never renders in it (A293).
   */
  protected files(noteId: string): FileServices {
    const images = this.images(noteId);
    const path = (src: string) => {
      const parsed = parseAttachmentPath(src);
      return parsed ? `attachments/${parsed.sha256}.${parsed.ext}` : null;
    };
    return {
      ...images,
      addFile: async (file) => {
        const name = file.name.slice(0, MAX_FILE_NAME);
        if (file.size > MAX_ATTACHMENT_BYTES) {
          throw new Error(`“${name}” is over 50 MB, the largest file Penmoss stores`);
        }
        const bytes = new Uint8Array(await file.arrayBuffer());
        const type = sniffFileType(bytes.subarray(0, SNIFF_BYTES));
        const sha256 = hex(await crypto.subtle.digest('SHA-256', bytes));
        const stored = filePath(sha256, type, name);
        const done = this.waitForStore(stored);
        // The message, then its bytes as the very next one, as for a picture (A304).
        this.post({
          v: BRIDGE_VERSION,
          type: 'file',
          noteId,
          path: stored,
          name,
          size: bytes.byteLength,
        });
        this.postBytes(bytes);
        if (!(await done)) throw new Error(`“${name}” could not be stored on this phone`);
        return { path: stored };
      },
      info: (src) => {
        const asked = path(src);
        if (!asked) return Promise.resolve(null);
        return new Promise<FileInfo | null>((resolve) => {
          const timer = setTimeout(() => resolve(null), FILE_INFO_MS);
          const waiting = this.asking.get(asked) ?? [];
          waiting.push((info) => {
            clearTimeout(timer);
            resolve(info);
          });
          this.asking.set(asked, waiting);
          if (waiting.length === 1) {
            this.post({ v: BRIDGE_VERSION, type: 'fileInfo', noteId, path: asked });
          }
        });
      },
      openFile: (src: string, name: string, action: FileAction) => {
        const asked = path(src);
        if (!asked) {
          this.notice(noteId, 'This file is not one Penmoss stores');
          return;
        }
        this.post({
          v: BRIDGE_VERSION,
          type: 'openFile',
          noteId,
          path: asked,
          name: name.slice(0, MAX_FILE_NAME),
          action,
        });
      },
    };
  }

  /** Resolves once the app answers for `path` (true: stored), or false after a while (A311). */
  protected waitForStore(path: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), STORE_PICTURE_MS);
      const waiting = this.storing.get(path) ?? [];
      waiting.push((ok) => {
        clearTimeout(timer);
        resolve(ok);
      });
      this.storing.set(path, waiting);
    });
  }

  /**
   * A picture from a web address (T40 P8, ED13), fetched by the app on the
   * page's own origin: `https` only, and as the app's setting says: shown,
   * held for a tap, or not at all.
   */
  protected webPicture(
    noteId: string,
    src: string,
    now: boolean,
  ): { readonly url: string } | 'wait' | null {
    if (!/^https:\/\//i.test(src) || src.length > MAX_REMOTE_URL) return null;
    const mode = this.webPictures?.noteId === noteId ? this.webPictures.mode : 'off';
    if (mode === 'off') return null;
    if (mode === 'wait' && !now) return 'wait';
    return { url: `${REMOTE_PICTURE_PATH}?${now ? 'now=1&' : ''}u=${encodeURIComponent(src)}` };
  }

  protected showUnsupported(open: OpenNote, nodeTypes: readonly string[]): void {
    const { title, unsupported } = this.elements;
    title.readOnly = true;
    unsupported.textContent = open.replica.plainText();
    unsupported.hidden = false;
    this.post({ v: BRIDGE_VERSION, type: 'unsupported', noteId: open.noteId, nodeTypes });
  }
}
