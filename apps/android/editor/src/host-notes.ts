/**
 * The editor host's open note (PEN-186, split from `host.ts`): comments, headings, the Info
 * sheet's details, and opening and closing a note.
 */
import { type Props } from '@penmoss/core/analytics';
import { extractLinks } from '@penmoss/core/links';
import { capNoteText, MAX_NOTE_HEADINGS_BYTES } from '@penmoss/core/note-text';
import { noteHeadings } from '@penmoss/core/search';
import { findHeading } from '@penmoss/core/line-symbols';
import {
  attachNoteUsage,
  createCollabEditor,
  noteExtensions,
  setNativeClipboard,
  UnsupportedContentError,
} from '@penmoss/editor';
import { formatCombo } from '@penmoss/editor/keys';
import { noteFields } from '@penmoss/model/note-fields';
import { bindTitleField } from '@penmoss/model/title';
import { readIdentity, readTitle } from '@penmoss/model/note';
import { frontmatterTags, noteTags } from '@penmoss/model/tags';
import {
  descriptionAsks,
  descriptionAuthor,
  readAiSetting,
  readDescription,
} from '@penmoss/model/description';
import { bodyJson, createYjs14Replica, type Yjs14Replica } from '@penmoss/model/yjs14';
import type { Editor } from '@tiptap/core';
import * as Y from '@y/y';
import { fromBase64, toBase64 } from 'lib0/buffer';
import { LinkedNotes } from './linked';
import { NoteComments } from './comments';
import type { CommentToEditor } from './comments-protocol';
import {
  BRIDGE_VERSION,
  MAX_REPORTED_LINKS,
  type Compacted,
  type FromEditor,
  type InfoField,
  type ToEditor,
} from './protocol';
import {
  compact,
  COPY_REFUSED,
  FROM_APP,
  frontmatterValue,
  HEADING_MARK_MS,
  INFO_EVERY_MS,
  type OpenNote,
  PREVIEW_NOTE_ID,
  type SelectionBookmark,
} from './host-support';
import { HostEditing } from './host-editing';

export abstract class HostNotes extends HostEditing {
  /** A change the Comments sheet asks for (T48): written in the open note's own document. */
  protected comment(message: CommentToEditor): void {
    const open = this.current;
    if (!open || open.noteId !== message.noteId) return;
    if (!open.comments) {
      // The app's list of sessions (T60) is no request of Ryan's: nothing to say.
      if (message.type === 'commentSessions') return;
      this.notice(message.noteId, "This note can't take comments here.");
      return;
    }
    open.comments.handle(message);
  }

  /** Other notes' bodies and watches, for tests. */
  get linkedNotes(): LinkedNotes {
    return this.linked;
  }

  /**
   * Scrolls the open note to a heading, as the web does for `[[Note#Heading]]` (T40 P7, LK3):
   * the first top-level heading with that text (ignoring case and spaces at the ends), marked
   * for a moment. A heading the note no longer has leaves it where it is.
   */
  protected showHeading(noteId: string, heading: string): void {
    const editor = this.current?.noteId === noteId ? this.current.collab?.editor : null;
    if (!editor || editor.isDestroyed) return;
    // The exact heading, else one that differs only by its line symbols (T44, A748).
    const headings: Array<{ text: string; offset: number }> = [];
    editor.state.doc.forEach((node, offset) => {
      if (node.type.name === 'heading') headings.push({ text: node.textContent, offset });
    });
    const index = findHeading(
      headings.map((each) => each.text),
      heading,
    );
    if (index < 0) return;
    const dom = editor.view.nodeDOM(headings[index]!.offset);
    if (!(dom instanceof HTMLElement)) return;
    dom.scrollIntoView({ block: 'start' });
    this.clearHeadingMark();
    dom.classList.add('pm-heading-target');
    this.headingMark = {
      element: dom,
      timer: setTimeout(() => this.clearHeadingMark(), HEADING_MARK_MS),
    };
  }

  protected clearHeadingMark(): void {
    const mark = this.headingMark;
    if (!mark) return;
    clearTimeout(mark.timer);
    mark.element.classList.remove('pm-heading-target');
    this.headingMark = null;
  }

  /**
   * The open note's details for the Info sheet (T40 P7, NT23): when it was made, its kind and
   * period, its frontmatter as the web's Info panel shows it (`noteFields`), and the notes it
   * links to or embeds, which the app keeps for backlinks (A473).
   */
  protected noteInfo(
    noteId: string,
    replica: Yjs14Replica,
    editor: Editor | null,
  ): Extract<FromEditor, { type: 'noteInfo' }> {
    const doc = replica.doc;
    const identity = readIdentity(doc);
    const title = readTitle(doc);
    const tags = frontmatterTags(doc);
    const kind = identity.kind ?? 'note';
    const values: Record<string, unknown> = {
      id: noteId,
      ...(title ? { title } : {}),
      ...(identity.created ? { created: identity.created } : {}),
      ...(tags.length > 0 ? { tags } : {}),
      ...(kind !== 'note' ? { type: kind } : {}),
    };
    const fields: InfoField[] = Object.entries(values).map(([key, value]) => ({
      key,
      value: frontmatterValue(value),
    }));
    let links: string[];
    try {
      const targets = new Set<string>();
      const add = (target: unknown) => {
        if (typeof target === 'string' && target && target !== noteId) targets.add(target);
      };
      if (editor && !editor.isDestroyed) {
        // The editor's own tree, already built: no second copy of the note per read (A307).
        editor.state.doc.descendants((node) => {
          if (node.type.name === 'wikilink' || node.type.name === 'embed')
            add(node.attrs['noteId']);
          return true;
        });
      } else {
        for (const link of extractLinks(bodyJson(doc))) add(link.noteId);
      }
      links = [...targets].sort().slice(0, MAX_REPORTED_LINKS);
    } catch {
      links = [];
    }
    return {
      v: BRIDGE_VERSION,
      type: 'noteInfo',
      noteId,
      created: identity.created ?? null,
      kind,
      period: identity.period ?? null,
      fields,
      links,
      description: readDescription(doc),
      descriptionBy: descriptionAuthor(doc),
      ai: readAiSetting(doc),
      descriptionAsks: descriptionAsks(doc),
    };
  }

  close(): void {
    // A drawing open over the note goes with it, as Cancel (PEN-189): the note it would go in is
    // closing (`close`, or the note opened again).
    this.drawings.finish('cancel');
    const open = this.current;
    this.current = null;
    // A selection or a delete belongs to the note as it was shown (re-review).
    this.captured = null;
    this.deletion = null;
    this.scrollGate.stop();
    if (!open) return;
    // Session detail's waiting burst goes before the note's last edits (PEN-177).
    open.usage?.flush();
    open.flush();
    open.sendText();
    open.teardown();
    this.elements.root.hidden = true;
    delete this.elements.root.dataset['preview'];
    if (this.stateTimer !== null) clearTimeout(this.stateTimer);
    this.stateTimer = null;
    this.lastState = '';
    this.lastCounts = '';
  }

  /**
   * The WebView's height changed (A307). When it shrank, the keyboard opened
   * or grew over the note: bring the caret back above the formatting bar.
   */
  viewportChanged(height: number): void {
    const before = this.viewportHeight;
    this.viewportHeight = height;
    const editor = this.current?.collab?.editor;
    if (before === null || height >= before || !editor?.isFocused) return;
    editor.commands.scrollIntoView();
  }

  protected open(message: Extract<ToEditor, { type: 'open' }>): void {
    this.close();
    // Another note: its place starts from the top (core's reset keeps the gap).
    this.scrollGate.reset();
    const { noteId } = message;
    const replica = createYjs14Replica();
    let compacted: Compacted | null;
    let compactedPending: Compacted | null;
    try {
      for (const stored of [...message.synced, ...message.pending]) {
        replica.applyUpdate(fromBase64(stored.update), FROM_APP);
      }
      compacted = compact(message.synced);
      compactedPending = compact(message.pending);
    } catch (error) {
      replica.destroy();
      this.fail(noteId, `The note's stored data could not be read: ${String(error)}`);
      return;
    }

    const { title, body, unsupported, root } = this.elements;
    let lastTitle = readTitle(replica.doc);
    // Frontmatter tags are attributes: cheap to read on every change, as the web's chips do.
    let lastTags = frontmatterTags(replica.doc);
    // The Info sheet's details (T40 P7): sent when they change, read at most every 300 ms.
    let lastInfo = '';
    let infoTimer: ReturnType<typeof setTimeout> | null = null;
    const sendInfo = () => {
      infoTimer = null;
      if (this.current?.replica !== replica) return;
      const info = this.noteInfo(noteId, replica, this.current.collab?.editor ?? null);
      this.showDescription();
      const key = JSON.stringify(info);
      if (key === lastInfo) return;
      lastInfo = key;
      this.post(info);
    };
    let unsent: Uint8Array<ArrayBuffer>[] = [];
    let timer: ReturnType<typeof setTimeout> | null = null;
    // When the oldest unsent edit was made: typing that never pauses is sent this long after.
    let firstUnsentAt: number | null = null;
    const flush = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      firstUnsentAt = null;
      if (unsent.length === 0) return;
      const update = unsent.length === 1 ? unsent[0]! : Y.mergeUpdates(unsent);
      unsent = [];
      this.post({ v: BRIDGE_VERSION, type: 'update', noteId, update: toBase64(update) });
    };
    // The offline index (T40 P6, FD4): once typing pauses for long, and as the note closes,
    // the text this phone's own edits made, so the phone finds them before the server has them.
    let textChanged = false;
    let textTimer: ReturnType<typeof setTimeout> | null = null;
    const sendText = () => {
      if (textTimer !== null) clearTimeout(textTimer);
      textTimer = null;
      if (!textChanged) return;
      textChanged = false;
      this.post({
        v: BRIDGE_VERSION,
        type: 'text',
        noteId,
        text: capNoteText(replica.plainText()),
        // The index's headings column (review S6) and the note's tags as this phone has them,
        // frontmatter and inline, for the tag browser before the server indexes them (S5).
        headings: capNoteText(noteHeadings(bodyJson(replica.doc)), MAX_NOTE_HEADINGS_BYTES),
        tags: noteTags(replica.doc),
      });
    };
    const offUpdate = replica.onUpdate((update, origin, info) => {
      const commentsOnly = info?.commentsOnly === true;
      // The Comments sheet's list follows its threads, here or from elsewhere (T48).
      if (this.current?.replica === replica) this.current.comments?.changed(commentsOnly);
      // Local edits (typing, the title field) go to the app to store and upload.
      if (origin !== FROM_APP) {
        // A comment is no edit (A770): the offline index's text stays as it is.
        if (!commentsOnly) {
          textChanged = true;
          if (textTimer !== null) clearTimeout(textTimer);
          textTimer = setTimeout(sendText, this.textIdleMs);
        }
        // A copy: Yjs may reuse the buffer it hands listeners.
        unsent.push(new Uint8Array(update));
        const now = Date.now();
        firstUnsentAt ??= now;
        if (timer !== null) clearTimeout(timer);
        // Sent once typing pauses, or when the oldest waiting edit is EDIT_MAX_WAIT_MS old.
        const wait = Math.min(this.idleMs, firstUnsentAt + this.maxWaitMs - now);
        timer = setTimeout(flush, Math.max(0, wait));
      }
      const next = readTitle(replica.doc);
      if (next !== lastTitle) {
        lastTitle = next;
        this.post({ v: BRIDGE_VERSION, type: 'title', noteId, title: next });
        // Once the title binding, which listens after this, has rewritten the field.
        queueMicrotask(this.fitTitle);
      }
      // Here or on another device: the app's tag sheet follows either.
      const tags = frontmatterTags(replica.doc);
      if (tags.join('\n') !== lastTags.join('\n')) {
        lastTags = tags;
        this.post({ v: BRIDGE_VERSION, type: 'tags', noteId, tags });
      }
      // The Info sheet's details, at most every INFO_EVERY_MS (T40 P7, NT23).
      infoTimer ??= setTimeout(sendInfo, INFO_EVERY_MS);
    });
    title.value = '';
    const unbindTitle = bindTitleField(title, replica);
    title.readOnly = !message.editable;
    this.fitTitle();

    const cleanups: Array<() => void> = [];
    const files = this.files(noteId);
    const images = files;
    const links = this.links(noteId);
    const open: OpenNote = {
      noteId,
      replica,
      collab: null,
      flush,
      sendText,
      held: [],
      holdTimer: null,
      images,
      files,
      links,
      sourceOff: null,
      teardown: () => {
        if (open.holdTimer !== null) clearTimeout(open.holdTimer);
        open.sourceOff?.();
        if (infoTimer !== null) clearTimeout(infoTimer);
        this.clearHeadingMark();
        if (textTimer !== null) clearTimeout(textTimer);
        for (const cleanup of cleanups.splice(0)) cleanup();
        offUpdate();
        unbindTitle();
        open.collab?.destroy();
        body.replaceChildren();
        unsupported.hidden = true;
        unsupported.textContent = '';
        replica.destroy();
      },
    };
    this.current = open;

    try {
      open.collab = createCollabEditor({
        element: body,
        extensions: noteExtensions({
          links,
          images,
          files,
          // Drawings (PEN-189): Excalidraw over the note, under the note screen's drawing bar.
          drawings: this.drawings.services,
          // Toggles open as this phone left them (T40 P8, ED8), kept by the app per note.
          foldState: this.foldState(noteId),
          // Line symbols (T44, A747): the synced list, the picker's Edit symbols… opening
          // Settings → Symbols, and a hardware keyboard's shortcut for each.
          symbols: this.symbolSource,
          onEditSymbols: () =>
            this.post({ v: BRIDGE_VERSION, type: 'command', noteId, id: 'app.symbols' }),
          symbolShortcut: (index) => {
            const combo = this.keys.keysOf(`editor.symbol${index + 1}`)[0];
            return combo ? formatCombo(combo) : null;
          },
          // Comment threads (T48): their highlights, and the editor's Comment command.
          comments: true,
          // Copy as Markdown of a whole note carries its frontmatter, as on the web (T15).
          clipboard: {
            note: () => noteFields(noteId, replica),
            onCopy: (_format, ok) => {
              if (!ok) this.notice(noteId, COPY_REFUSED);
            },
          },
        }),
        replica,
        // A later version's content arrived while open: show it read-only from now on (A158).
        onUnsupported: (nodeTypes) => this.showUnsupported(open, nodeTypes),
      });
      const { editor } = open.collab;
      editor.view.dom.setAttribute('aria-label', 'Note body');
      editor.setEditable(message.editable);
      cleanups.push(this.prepareForTyping(open, editor));
      cleanups.push(this.countWords(open, editor));
      // A body selection kept for the selection menu follows edits made meanwhile (B2).
      const follow = ({
        transaction,
      }: {
        transaction: { mapping: Parameters<SelectionBookmark['map']>[0] };
      }) => {
        const at = this.captured?.noteId === noteId ? this.captured.at : null;
        if (at?.kind === 'body') at.bookmark = at.bookmark.map(transaction.mapping);
      };
      editor.on('transaction', follow);
      cleanups.push(() => editor.off('transaction', follow));
      // Copies (and a code block's Copy button) go to the app's clipboard (T40 P8, ED9, ED7).
      setNativeClipboard((payload) => Promise.resolve(this.toClipboard(open, payload)));
      cleanups.push(() => setNativeClipboard(null));
      cleanups.push(this.tagTaps(noteId, editor));
      // The note's threads (T48): listed for the Comments sheet and drawn in the note.
      open.comments = new NoteComments(noteId, replica, editor, {
        post: (message) => this.post(message),
        notice: (text) => this.notice(noteId, text),
        editable: () => this.current === open && !editor.isDestroyed && editor.isEditable,
        restoreCaptured: () => {
          const captured = this.take(noteId);
          return captured?.kind === 'body' && this.restore(editor, captured.bookmark) !== null;
        },
        now: () => this.now().getTime(),
        author: () => this.commentAuthor,
        // Send to… (T60, A1078): the target and `waiting` reach the app before `commentSent`.
        flush: () => open.flush(),
      });
      cleanups.push(() => open.comments?.destroy());
      // Session detail (PEN-177), never for the theme preview's sample note: the app adds the
      // note's and its folder's refs, which only it can make.
      if (noteId !== PREVIEW_NOTE_ID) {
        open.usage = attachNoteUsage(editor, {
          record: (name, props: Props) =>
            this.post({ v: BRIDGE_VERSION, type: 'usage', noteId, name, props }),
          // The note's own title, which the field may not show yet as the content arrives.
          titleLength: () => readTitle(replica.doc).length,
          ...(this.usageClock ? { clock: this.usageClock } : {}),
        });
        cleanups.push(() => open.usage?.destroy());
      }
    } catch (error) {
      if (!(error instanceof UnsupportedContentError)) {
        this.close();
        this.fail(noteId, `The note could not be opened: ${String(error)}`);
        return;
      }
      this.showUnsupported(open, error.nodeTypes);
    }
    root.hidden = false;
    this.post({
      v: BRIDGE_VERSION,
      type: 'opened',
      noteId,
      title: lastTitle,
      compacted,
      compactedPending,
    });
    this.post({ v: BRIDGE_VERSION, type: 'tags', noteId, tags: lastTags });
    // The note shows: its shape, once (PEN-177).
    open.usage?.open('open');
    sendInfo();
    // And its comment threads (T48), drawn in the note and listed for the Comments sheet.
    open.comments?.start();
    if (this.focusTitleOf === noteId) {
      this.focusTitleOf = null;
      if (message.editable && !title.readOnly) title.focus();
    }
  }
}
